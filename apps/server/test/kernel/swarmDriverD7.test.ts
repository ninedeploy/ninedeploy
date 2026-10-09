/**
 * D7a–f (multi-node design §0.2, §7.3): the Swarm driver's defects, as
 * behaviour a correct driver must have — written against the UNMODIFIED
 * driver first (every case failed there; evidence in
 * .temp_files/run_0.16/t7/d7-proof-before.log), then kept as the regression
 * guard for the `docker stack deploy` rewrite.
 *
 * The cases look only at what reaches Docker — every argv and every file the
 * driver writes — never at how the driver is built, so they hold for any
 * implementation:
 *   D7a  a redeploy applies env, replica and label changes (not just the image);
 *   D7b  no env value (secrets included) is ever an argv element;
 *   D7c  nothing is published on the Swarm ingress mesh (Traefik is the only ingress);
 *   D7d  the stack state lives under the panel's data directory, so a docker
 *        install (non-root, only the data dir writable) can deploy at all;
 *   D7e  a rotated secret value reaches the service (a new object), never
 *        swallowed as "already exists";
 *   D7f  a local-only image is deployed without registry resolution and with
 *        the placement constraint that keeps tasks off nodes lacking it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../helpers.js';

const h = vi.hoisted(() => {
  // path.join(path.sep, 'srv', 'nd-data'), spelled out: the hoisted block runs before any import.
  const DATA = ['', 'srv', 'nd-data'].join(process.platform === 'win32' ? '\\' : '/');
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  /** Every file content ever written, by path (the env file is deleted after a deploy). */
  const writes: Array<{ path: string; data: string }> = [];
  /** null: everything writable; else only paths under this root (a docker install's /data). */
  const state = { writableRoot: null as string | null };
  const docker = {
    services: new Set<string>(),
    networks: new Set<string>(),
    /** name → content at creation. */
    secrets: new Map<string, string>(),
    configs: new Map<string, string>(),
    /** Successful `secret create`s, in order. */
    secretCreates: [] as Array<{ name: string; data: string }>,
  };
  const calls: string[][] = [];
  return { DATA, files, dirs, writes, state, docker, calls };
});

const norm = (p: string) => p.replace(/\\/g, '/');
const writable = (p: string) => h.state.writableRoot === null || norm(p).startsWith(norm(h.state.writableRoot));
const eacces = (p: string) => Object.assign(new Error(`EACCES: permission denied, mkdir '${p}'`), { code: 'EACCES' });

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => h.files.has(norm(p)) || h.dirs.has(norm(p)),
    mkdirSync: (p: string) => {
      if (!writable(p)) throw eacces(p);
      h.dirs.add(norm(p));
    },
    readFileSync: (p: string) => {
      const data = h.files.get(norm(p));
      if (data === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return data;
    },
    writeFileSync: (p: string, data: string | Uint8Array) => {
      if (!writable(p)) throw eacces(p);
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      h.files.set(norm(p), text);
      h.writes.push({ path: norm(p), data: text });
    },
    chmodSync: () => undefined,
    rmSync: (p: string) => {
      const key = norm(p);
      h.files.delete(key);
      for (const f of [...h.files.keys()]) if (f.startsWith(`${key}/`)) h.files.delete(f);
      h.dirs.delete(key);
    },
  };
});

vi.mock('../../src/config.js', () => ({ config: { paths: { dataDir: h.DATA } } }));
const DATA = h.DATA;

/** The value after `flag` in argv. */
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

/** A fake daemon that keeps enough state to answer what a driver asks. */
async function fakeRun(_cmd: string, args: string[]): Promise<void> {
  h.calls.push(args);
  const [a, b] = args;
  if (a === 'network' && b === 'create') {
    const name = args.at(-1)!;
    if (h.docker.networks.has(name)) throw new Error(`network with name ${name} already exists`);
    h.docker.networks.add(name);
    return;
  }
  if ((a === 'secret' || a === 'config') && b === 'create') {
    const [name, file] = args.slice(-2) as [string, string];
    const store = a === 'secret' ? h.docker.secrets : h.docker.configs;
    if (store.has(name)) throw new Error(`Error response from daemon: rpc error: code = AlreadyExists desc = ${a} ${name} already exists`);
    const data = h.files.get(norm(file));
    if (data === undefined) throw new Error(`open ${file}: no such file`);
    store.set(name, data);
    if (a === 'secret') h.docker.secretCreates.push({ name, data });
    return;
  }
  if (a === 'service' && b === 'create') {
    h.docker.services.add(after(args, '--name')!);
    return;
  }
  if (a === 'stack' && b === 'deploy') {
    const file = h.files.get(norm(after(args, '-c') ?? after(args, '--compose-file')!));
    if (file === undefined) throw new Error('stack file missing');
    const stack = args.at(-1)!;
    for (const name of Object.keys((JSON.parse(file) as { services?: object }).services ?? {})) h.docker.services.add(`${stack}_${name}`);
  }
}

async function fakeCapture(_cmd: string, args: string[]): Promise<string> {
  h.calls.push(args);
  const [a, b] = args;
  if (a === 'service' && b === 'ls') {
    const name = args.find((x) => x.startsWith('name='))?.slice('name='.length) ?? '';
    return [...h.docker.services].filter((s) => s.startsWith(name)).join('\n');
  }
  if (a === 'network' && b === 'inspect') {
    if (!h.docker.networks.has(args.at(-1)!)) throw new Error(`Error: No such network: ${args.at(-1)}`);
    return 'overlay|{"encrypted":""}';
  }
  if ((a === 'secret' || a === 'config') && b === 'inspect') {
    const store = a === 'secret' ? h.docker.secrets : h.docker.configs;
    if (!store.has(args.at(-1)!)) throw new Error(`Error: No such ${a}: ${args.at(-1)}`);
    return 'id';
  }
  if ((a === 'secret' || a === 'config') && b === 'ls') return [...(a === 'secret' ? h.docker.secrets : h.docker.configs).keys()].join('\n');
  return '';
}

vi.mock('../../src/lib/exec.js', () => ({
  run: (cmd: string, args: string[]) => fakeRun(cmd, args),
  capture: (cmd: string, args: string[]) => fakeCapture(cmd, args),
  buildEnv: (extra?: Record<string, string>) => ({ ...(extra ?? {}) }),
  sleep: async () => undefined,
}));

const { SwarmOrchestrator } = await import('../../src/kernel/drivers/swarmOrchestrator.js');

beforeEach(() => {
  h.files.clear();
  h.dirs.clear();
  h.writes.length = 0;
  h.state.writableRoot = null;
  h.docker.services.clear();
  h.docker.networks.clear();
  h.docker.secrets.clear();
  h.docker.configs.clear();
  h.docker.secretCreates.length = 0;
  h.calls.length = 0;
});

const orchestrator = () => new SwarmOrchestrator(createFakeDb() as never);

function spec(over: Record<string, unknown> = {}, svc: Record<string, unknown> = {}) {
  return {
    name: 'nd-web',
    services: [
      {
        name: 'web',
        image: 'nginx:1.27-alpine',
        replicas: 1,
        port: 80,
        env: { A: '1' },
        networks: ['nd-swarm-web'],
        secrets: [],
        configs: [],
        healthPath: '/',
        labels: { 'ninedeploy.service': '7' },
        ...svc,
      },
    ],
    networks: [{ name: 'nd-swarm-web', driver: 'overlay' as const, attachable: true }],
    secrets: [],
    configs: [],
    volumes: [],
    ...over,
  };
}

/** Everything that reached Docker or disk since `from`: argv elements and file contents. */
const surface = (fromCall = 0, fromWrite = 0) =>
  [...h.calls.slice(fromCall).flat(), ...h.writes.slice(fromWrite).map((w) => w.data)].join('\n');

describe('D7: the Swarm driver (design §0.2, §7.3)', () => {
  it('D7a: a redeploy applies env, replica and label changes, not just the image', async () => {
    const o = orchestrator();
    await o.deployStack(spec() as never);
    const [c, w] = [h.calls.length, h.writes.length];
    await o.deployStack(spec({}, { env: { A: 'changed-value-2' }, replicas: 3, labels: { 'ninedeploy.service': '7', 'ninedeploy.extra': 'label-x' } }) as never);
    const second = surface(c, w);
    expect(second, 'the new env value').toContain('changed-value-2');
    expect(second, 'the new label').toContain('label-x');
    expect(second, 'the new replica count').toMatch(/"replicas":\s*3|--replicas[\s\S]3|replicas=3/);
  });

  it('D7b: no env value — a secret included — is ever an argv element', async () => {
    await orchestrator().deployStack(spec({}, { env: { DB_PASSWORD: 's3cr3t-value-x' } }) as never);
    const argv = h.calls.flat();
    expect(argv.some((a) => a.includes('s3cr3t-value-x')), argv.join(' ')).toBe(false);
    // …while it still reaches the service (through a file Docker reads).
    expect(h.writes.some((w) => w.data.includes('DB_PASSWORD=s3cr3t-value-x'))).toBe(true);
  });

  it('D7c: nothing is published on the ingress mesh (no --publish, no ports:)', async () => {
    await orchestrator().deployStack(spec({}, { port: 8080 }) as never);
    const argv = h.calls.flat();
    expect(argv.filter((a) => a === '--publish' || a === '-p' || a.startsWith('--publish=')), argv.join(' ')).toEqual([]);
    for (const w of h.writes) expect(w.data, w.path).not.toMatch(/"ports"|^\s*ports:/m);
  });

  it('D7d: the stack state lives under the data directory (a docker install can write nothing else)', async () => {
    h.state.writableRoot = DATA;
    await expect(orchestrator().deployStack(spec() as never)).resolves.toBeDefined();
    const state = [...h.files.keys()].find((f) => f.endsWith('/stack.json'));
    expect(state, 'stack.json was written').toBeDefined();
    expect(state!.startsWith(norm(DATA))).toBe(true);
  });

  it('D7e: a rotated secret value reaches the service as a new object, never swallowed as "already exists"', async () => {
    const o = orchestrator();
    await o.deployStack(spec({ secrets: [{ name: 'api-key', data: 'value-one' }] }, { secrets: ['api-key'] }) as never);
    const [c, w] = [h.calls.length, h.writes.length];
    await o.deployStack(spec({ secrets: [{ name: 'api-key', data: 'value-two' }] }, { secrets: ['api-key'] }) as never);
    const created = h.docker.secretCreates.find((s) => s.data === 'value-two');
    expect(created, 'a secret object holding the rotated value').toBeDefined();
    // …and the redeploy points the service at it.
    expect(surface(c, w)).toContain(created!.name);
  });

  it('D7f: a local-only image deploys without registry resolution and with the preload placement constraint', async () => {
    await orchestrator().deployStack(
      spec({ resolveImage: 'never' }, { image: 'ninedeploy/web:abc1234-b7', constraints: ['node.labels.nd.preload.web!=0'] }) as never,
    );
    const all = surface();
    expect(all).toMatch(/--resolve-image[\s\S]never|--resolve-image=never/);
    expect(all).toContain('node.labels.nd.preload.web!=0');
  });
});
