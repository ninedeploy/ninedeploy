/**
 * 0.14 upgrade: the panel's Traefik moves from one route file
 * (`providers.file.filename: /etc/traefik/dynamic.yml`) to a watched
 * directory (`/etc/traefik/dynamic`), DESIGN §2.2 / M8.
 *
 * An upgraded panel must keep serving every existing route:
 *   • the generated routes are byte-for-byte what v0.13.0 rendered — pinned
 *     against golden files produced by RUNNING the v0.13.0 `engine/proxy.ts`
 *     on the fixture input (`fixtures/traefik-upgrade/`, generator kept in
 *     `.temp_files/run_0.14/t2/gen_013_golden.test.ts`);
 *   • the 0.13 data layout becomes the 0.14 layout with the legacy routes
 *     copied into place BEFORE the one-time recreate (no 404 window);
 *   • a recreate that fails leaves the old container reading `dynamic.yml`,
 *     which is then kept fresh until a recreate succeeds;
 *   • a re-upgrade after a rollback starts on the routes 0.13 last wrote.
 *
 * Golden files are compared after CRLF→LF (git's autocrlf checks them out
 * with CRLF on Windows; Traefik and the renderer use LF).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, servers, services, serviceTargets } from '@ninedeploy/db';

const h = vi.hoisted(() => ({
  config: { paths: { dataDir: '' }, acmeEmail: null as string | null, port: 3001 },
  capture: vi.fn(async (..._a: unknown[]): Promise<string> => ''),
  run: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  ensureDockerImage: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/lib/exec.js', () => ({ capture: h.capture, run: h.run, sleep: vi.fn(async () => undefined) }));
vi.mock('../src/lib/dockerPull.js', () => ({ ensureDockerImage: h.ensureDockerImage }));
vi.mock('../src/lib/serviceBridge.js', () => ({ reapTraefikNetworks: vi.fn(async () => undefined) }));
vi.mock('../src/lib/hostPath.js', () => ({ hostPathFor: vi.fn(async (p: string) => p) }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/crypto.js', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}));
vi.mock('../src/lib/settings.js', () => ({
  getSettingString: async (db: { settingsMap?: Record<string, string> }, k: string, f: string | null) => db.settingsMap?.[k] ?? f,
}));

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-upgrade-014-'));
h.config.paths.dataDir = base;
const traefikDir = path.join(base, 'traefik');
const legacyFile = path.join(traefikDir, 'dynamic.yml');
const newFile = path.join(traefikDir, 'dynamic', 'ninedeploy.yml');
afterAll(() => rmSync(base, { recursive: true, force: true }));

const proxy = await import('../src/engine/proxy.js');

const FIX = path.join(import.meta.dirname, 'fixtures', 'traefik-upgrade');
const golden = (f: string) => readFileSync(path.join(FIX, f), 'utf8').replace(/\r\n/g, '\n');
const input = JSON.parse(readFileSync(path.join(FIX, 'input.json'), 'utf8')) as {
  settings: Record<string, string>;
  services: unknown[];
  domains: Array<Record<string, unknown>>;
};
const DNS = { provider: 'cloudflare', token: 'cf-token', wildcardApex: 'apps.example.com' };

function fixtureDb(extraDomains: Array<Record<string, unknown>> = []) {
  const rows = (t: unknown): unknown[] =>
    t === domains ? [...input.domains, ...extraDomains]
    : t === services ? input.services
    : t === serviceTargets || t === servers ? []
    : [];
  return {
    settingsMap: input.settings,
    select: () => ({
      from: (t: unknown) =>
        Object.assign(Promise.resolve().then(() => rows(t)), { where: async () => rows(t), orderBy: async () => rows(t) }),
    }),
  } as never;
}

const routerNames = (yaml: string) =>
  Object.keys((load(yaml) as { http: { routers: Record<string, unknown> } }).http.routers).sort();

/** Lay down exactly what a v0.13.0 panel leaves in `<data>/traefik`. */
function layout013(): void {
  rmSync(traefikDir, { recursive: true, force: true });
  mkdirSync(traefikDir, { recursive: true });
  writeFileSync(path.join(traefikDir, 'traefik.yml'), golden('v0.13.0-traefik.yml'));
  writeFileSync(legacyFile, golden('v0.13.0-dynamic.yml'));
  writeFileSync(path.join(traefikDir, 'acme.json'), '{}');
}

/** Docker as a v0.13.0 container running on our directory with 0.13's fingerprint. */
function docker013(onRun: (args: string[]) => void = () => undefined): void {
  h.capture.mockImplementation(async (_cmd: unknown, a: unknown) => {
    const args = a as string[];
    if (args[0] === 'ps') return 'abc123\n';
    if (args[0] === 'inspect' && args[3]?.includes('.Config.Labels')) return 'fingerprint-of-0.13';
    if (args[0] === 'inspect' && args[3]?.includes('.Mounts')) return traefikDir;
    if (args[0] === 'inspect' && args[3]?.includes('.State.Running')) return 'true|{"ninedeploy":{}}';
    if (args[0] === 'inspect') return '{"ninedeploy":{}}';
    return '';
  });
  h.run.mockImplementation(async (_cmd: unknown, a: unknown) => {
    onRun(a as string[]);
  });
}

beforeEach(() => {
  h.capture.mockReset();
  h.run.mockReset();
  h.ensureDockerImage.mockReset();
  h.ensureDockerImage.mockResolvedValue(undefined);
});

describe('renders exactly what v0.13.0 rendered', () => {
  it('panel routes: byte-for-byte the v0.13.0 golden', async () => {
    expect(await proxy.renderDynamicConfig(fixtureDb(), { serverId: null })).toBe(golden('v0.13.0-dynamic.yml'));
  });

  it('node routes: byte-for-byte the v0.13.0 golden', async () => {
    expect(await proxy.renderDynamicConfig(fixtureDb(), { serverId: 7 })).toBe(golden('v0.13.0-node7-dynamic.yml'));
  });

  it('static config: only the file provider changed, filename → directory', () => {
    expect(proxy.renderStaticConfig('ops@example.com', DNS)).toBe(
      golden('v0.13.0-traefik.yml').replace(
        '    filename: /etc/traefik/dynamic.yml\n',
        '    directory: /etc/traefik/dynamic\n',
      ),
    );
  });
});

// Order matters below: the legacy mirror is per-process state, on until the
// first successful heal — exactly as on a freshly upgraded panel.
describe('0.13 data layout → 0.14 layout', () => {
  it('a failed recreate keeps the 0.13 container (still reading dynamic.yml) fresh', async () => {
    layout013();
    docker013();
    // The image pull fails: by design the old container is NOT removed.
    h.ensureDockerImage.mockRejectedValueOnce(new Error('registry unreachable'));
    await expect(proxy.ensureTraefik(() => undefined, 'ops@example.com', DNS)).rejects.toThrow('registry unreachable');
    expect(h.run).not.toHaveBeenCalledWith('docker', ['rm', '-f', 'ninedeploy-traefik'], {}, expect.any(Function));
    expect(proxy.legacyMirrorActive()).toBe(true);

    // A domain added now must reach the container that is still serving.
    const added = { id: 99, serviceId: 1, hostname: 'new.example.com', path: '/', ssl: false, status: 'active', redirectWww: false };
    await proxy.writeDynamicConfig(fixtureDb([added]));
    expect(readFileSync(legacyFile, 'utf8')).toContain('Host(`new.example.com`)');
    expect(readFileSync(newFile, 'utf8')).toBe(readFileSync(legacyFile, 'utf8'));
  });

  it('copies the legacy routes into place BEFORE the one-time recreate, then renders identically', async () => {
    layout013();
    const legacy = golden('v0.13.0-dynamic.yml');
    let atRemove: string | null = null;
    let staticAtRemove = '';
    docker013((args) => {
      if (args[0] === 'rm') {
        atRemove = existsSync(newFile) ? readFileSync(newFile, 'utf8') : null;
        staticAtRemove = readFileSync(path.join(traefikDir, 'traefik.yml'), 'utf8');
      }
    });
    const logs: string[] = [];

    await expect(proxy.ensureTraefik((l) => logs.push(l), 'ops@example.com', DNS)).resolves.toBe(true);

    // The old container was removed only once the new one's routes were in place.
    expect(atRemove).toBe(legacy);
    expect(staticAtRemove).toContain('directory: /etc/traefik/dynamic');
    expect(staticAtRemove).not.toContain('filename:');
    expect(logs).toContain('traefik static configuration changed; recreating container to apply it');
    const runArgv = h.run.mock.calls.map((c) => c[1] as string[]).find((a) => a[0] === 'run')!;
    expect(runArgv).toEqual(expect.arrayContaining(['-v', `${traefikDir}:/etc/traefik:ro`]));
    expect(proxy.legacyMirrorActive()).toBe(false);

    // The boot render: identical routes, legacy file left alone from now on.
    writeFileSync(legacyFile, legacy);
    await proxy.writeDynamicConfig(fixtureDb());
    expect(readFileSync(newFile, 'utf8')).toBe(legacy);
    expect(routerNames(readFileSync(newFile, 'utf8'))).toEqual(routerNames(legacy));
    expect(readFileSync(legacyFile, 'utf8')).toBe(legacy);
    // No uploads → no certificates file, no custom file.
    expect(existsSync(path.join(traefikDir, 'dynamic', 'certificates.yml'))).toBe(false);
    expect(existsSync(path.join(traefikDir, 'dynamic', 'custom.yml'))).toBe(false);
  });

  it('the panel container reads the generated routes through its mount (panel-side D1 check)', () => {
    const staticDoc = load(readFileSync(path.join(traefikDir, 'traefik.yml'), 'utf8')) as {
      providers: { file: { directory: string } };
    };
    const hostDir = path.join(traefikDir, ...path.posix.relative('/etc/traefik', staticDoc.providers.file.directory).split('/'));
    expect(readFileSync(path.join(hostDir, 'ninedeploy.yml'), 'utf8')).toBe(golden('v0.13.0-dynamic.yml'));
  });

  it('seeds an empty placeholder at the new path on a fresh install (no legacy file)', async () => {
    rmSync(traefikDir, { recursive: true, force: true });
    docker013();
    await expect(proxy.ensureTraefik(() => undefined, null, null)).resolves.toBe(true);
    expect(readFileSync(newFile, 'utf8')).toBe('http:\n  routers:\n  services:\n');
    expect(existsSync(legacyFile)).toBe(false);
  });

  it('a re-upgrade after a rollback starts on the routes 0.13 wrote last, never on older ones', async () => {
    layout013();
    mkdirSync(path.dirname(newFile), { recursive: true });
    writeFileSync(newFile, '# routes from before the rollback\n');
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(newFile, old, old);
    docker013();
    await proxy.ensureTraefik(() => undefined, 'ops@example.com', DNS);
    expect(readFileSync(newFile, 'utf8')).toBe(golden('v0.13.0-dynamic.yml'));

    // The other way round (0.14's file is the newer one) nothing is copied.
    writeFileSync(newFile, '# 0.14 routes\n');
    const older = new Date('2025-01-01T00:00:00Z');
    utimesSync(legacyFile, older, older);
    await proxy.ensureTraefik(() => undefined, 'ops@example.com', DNS);
    expect(readFileSync(newFile, 'utf8')).toBe('# 0.14 routes\n');
  });
});
