import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { load } from 'js-yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D1 (0.14, P0) — a node's Traefik must read the dynamic file the agent writes.
 *
 * End to end, with only the process boundary faked: the panel's REAL
 * `renderStaticConfig`, `syncNodeProxy` driving the REAL agent `runOp`
 * (`proxy.writeConfig` writes real files, `proxy.ensure` builds the real
 * `docker run` argv). The container's view is reconstructed from that argv's
 * `-v <host>:/etc/traefik` mount, and the file provider the static config
 * names is resolved through it. Through 0.13 the static config said
 * `filename: /etc/traefik/dynamic.yml` while the agent writes
 * `/etc/traefik/dynamic/ninedeploy.yml`: nothing bridged the two, so every
 * node proxy loaded zero routes.
 */
const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));
vi.mock('../../src/lib/dockerPull.js', () => ({ pullDockerImage: vi.fn(async () => undefined) }));

const DYNAMIC = '# node routes\nhttp:\n  routers:\n    app_1:\n      rule: "Host(`app.example.com`)"\n      service: svc_app_1\n';

vi.mock('../../src/lib/agentClient.js', () => ({
  agentOp: vi.fn(async (_db: unknown, _id: unknown, op: string, params: Record<string, unknown>, onLine: (l: string) => void) => {
    const { runOp } = await import('../../src/agent.js');
    const lines: string[] = [];
    const exitCode = await runOp(op, params as never, (l) => {
      lines.push(l);
      onLine(l);
    });
    return { exitCode, lines };
  }),
}));
vi.mock('../../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/engine/proxy.js')>()),
  getAcmeEmail: vi.fn(async () => 'ops@example.com'),
  getDnsConfig: vi.fn(async () => ({ provider: '', token: null, wildcardApex: null })),
  renderDynamicConfig: vi.fn(async () => DYNAMIC),
}));

const { syncNodeProxy } = await import('../../src/lib/nodeProxy.js');

const work = mkdtempSync(join(tmpdir(), 'nd-d1-'));
let cwdSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spawnMock.mockClear();
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(work);
});
afterEach(() => cwdSpy.mockRestore());
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The host directory the node's `docker run` mounts at `/etc/traefik`, and the argv. */
function proxyRun(): { argv: string[]; hostDir: string } {
  const argv = spawnMock.mock.calls.map((c) => c[1] as string[]).find((a) => a[0] === 'run');
  if (!argv) throw new Error('proxy.ensure never ran the container');
  const mount = argv.filter((_a, i) => argv[i - 1] === '-v').find((m) => /:\/etc\/traefik(:ro)?$/.test(m));
  if (!mount) throw new Error('no /etc/traefik mount in the node proxy argv');
  return { argv, hostDir: mount.replace(/:\/etc\/traefik(:ro)?$/, '') };
}

/** A container path under /etc/traefik, as the host path the mount serves it from. */
function hostPathOf(hostDir: string, containerPath: string): string {
  const rel = posix.relative('/etc/traefik', containerPath);
  if (rel.startsWith('..')) throw new Error(`${containerPath} is outside the /etc/traefik mount`);
  return join(hostDir, ...rel.split('/'));
}

describe('D1: the node proxy loads the routes the agent writes', () => {
  it("the node's effective static config points at where the agent writes the dynamic file", async () => {
    await expect(syncNodeProxy({} as never, 4, () => undefined, { ensureContainer: true })).resolves.toEqual({ ok: true });
    const { argv, hostDir } = proxyRun();

    // No --configFile flag: Traefik reads its default /etc/traefik/traefik.yml.
    expect(argv.some((a) => a.startsWith('--configFile') || a.startsWith('--configfile'))).toBe(false);
    const staticHost = hostPathOf(hostDir, '/etc/traefik/traefik.yml');
    expect(existsSync(staticHost)).toBe(true);
    const file = (load(readFileSync(staticHost, 'utf8')) as { providers?: { file?: { filename?: string; directory?: string } } })
      .providers?.file;
    expect(file).toBeDefined();

    // Every file the file provider would load, resolved on the host.
    let loaded: string[] = [];
    if (file?.directory) {
      const d = hostPathOf(hostDir, file.directory);
      loaded = existsSync(d) && statSync(d).isDirectory()
        ? readdirSync(d).filter((f) => /\.ya?ml$/.test(f)).map((f) => readFileSync(join(d, f), 'utf8'))
        : [];
    } else if (file?.filename) {
      const f = hostPathOf(hostDir, file.filename);
      loaded = existsSync(f) ? [readFileSync(f, 'utf8')] : [];
    }
    expect(loaded).toContain(DYNAMIC);
  });
});
