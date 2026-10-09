/**
 * SwarmOrchestrator — kernel coverage (Sprint 5 G-10, PR #21; rewritten with
 * the driver for multi-node T7, design §7.3).
 *
 * The driver now applies every stack with one `docker stack deploy` of a
 * rendered compose file, so the cases that pinned the old per-object argv
 * (`service create` / `service update --image` / `--env` / `--publish` /
 * `--health-cmd`) were adapted to the stack file and the `stack deploy` argv;
 * the D7a–f defects they encoded are proven in swarmDriverD7.test.ts. The
 * state, status, list and remove contracts keep their cases. Docker is mocked
 * behind `lib/exec.js` and the filesystem is an in-memory shim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createFakeDb } from '../helpers.js';

const h = vi.hoisted(() => ({
  files: new Map<string, { dir?: true; data?: string; mode?: number }>(),
  log: new Map<string, string[]>(),
}));

let runMock: ReturnType<typeof vi.fn>;
let captureMock: ReturnType<typeof vi.fn>;

vi.mock('../../src/lib/exec.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  capture: (...args: unknown[]) => captureMock(...args),
  buildEnv: (extra?: Record<string, string>) => ({ ...(extra ?? {}) }),
  sleep: async () => undefined,
}));
vi.mock('../../src/config.js', () => ({ config: { paths: { dataDir: '/data' } } }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => h.files.has(p),
    mkdirSync: (p: string) => {
      h.files.set(p, { dir: true });
    },
    readFileSync: (p: string) => {
      const entry = h.files.get(p);
      if (!entry || entry.data === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return entry.data;
    },
    writeFileSync: (p: string, data: string | Uint8Array, opts?: { mode?: number }) => {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      h.files.set(p, { data: text, mode: opts?.mode });
      h.log.set(p, [...(h.log.get(p) ?? []), text]);
    },
    chmodSync: () => undefined,
    readdirSync: (p: string) => {
      const kids = [...h.files.keys()].filter((k) => k.startsWith(p) && k !== p).map((k) => k.slice(p.length + 1).split(/[\\/]/)[0] as string);
      if (kids.length === 0 && !h.files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return [...new Set(kids)];
    },
    rmSync: (p: string) => {
      h.files.delete(p);
    },
  };
});

const { SwarmOrchestrator, hashedObjectName, renderStackFile, stackDeployArgs, swarmStackRoot } = await import(
  '../../src/kernel/drivers/swarmOrchestrator.js'
);

const ROOT = join('/srv', 'swarm');
const stackPath = (name: string, ...rest: string[]): string => join(ROOT, name, ...rest);

beforeEach(() => {
  runMock = vi.fn().mockResolvedValue(undefined);
  // Nothing exists yet: every inspect fails, every listing is empty.
  captureMock = vi.fn(async (_cmd: string, args: string[]) => {
    if (args[1] === 'inspect') throw new Error('Error: No such object');
    return '';
  });
  h.files.clear();
  h.log.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

function newOrchestrator(opts: { select?: Record<string, unknown[]>; findFirst?: Record<string, unknown> } = {}) {
  const db = createFakeDb({
    select: opts.select as never,
    findFirst: opts.findFirst as never,
  });
  return new SwarmOrchestrator(db as never, { root: ROOT });
}

const svc = (over: Record<string, unknown> = {}) => ({
  name: 'api',
  image: 'x:1',
  replicas: 1,
  networks: [] as string[],
  secrets: [] as string[],
  configs: [] as string[],
  env: {} as Record<string, string>,
  labels: {} as Record<string, string>,
  port: null as number | null,
  ...over,
});
const stack = (over: Record<string, unknown> = {}) => ({
  name: 'demo',
  services: [] as ReturnType<typeof svc>[],
  networks: [] as Array<{ name: string; driver: 'overlay'; attachable: boolean }>,
  secrets: [] as Array<{ name: string; data: string }>,
  configs: [] as Array<{ name: string; data: string }>,
  volumes: [],
  ...over,
});
const calls = (verb: string) => runMock.mock.calls.filter((c) => `${c[1]?.[0]} ${c[1]?.[1]}` === verb).map((c) => c[1] as string[]);
const stackFile = (name = 'demo') => JSON.parse(h.log.get(stackPath(name, 'stack.yml'))!.at(-1)!) as Record<string, any>;
const state = (name: string, serviceNames: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, networks: [], secrets: [], configs: [], serviceNames, appliedAt: '2026-01-01T00:00:00.000Z', ...extra });

describe('SwarmOrchestrator', () => {
  it('exposes the stable "swarm" name', () => {
    expect(newOrchestrator().name).toBe('swarm');
  });

  it('keeps its stacks under <dataDir>/swarm by default (D7d)', () => {
    expect(swarmStackRoot()).toBe(join('/data', 'swarm'));
  });

  describe('deployStack — networks', () => {
    it('creates an attachable, ENCRYPTED overlay network per StackNetworkSpec (--opt encrypted, no switch)', async () => {
      await newOrchestrator().deployStack(stack({ networks: [{ name: 'frontend', driver: 'overlay', attachable: true }] }));
      expect(calls('network create')).toEqual([['network', 'create', '--driver', 'overlay', '--opt', 'encrypted', '--attachable', 'frontend']]);
    });

    it('creates a non-attachable network with the explicit --attachable=false flag (still encrypted)', async () => {
      await newOrchestrator().deployStack(stack({ networks: [{ name: 'backend', driver: 'overlay', attachable: false }] }));
      expect(calls('network create')).toEqual([['network', 'create', '--driver', 'overlay', '--opt', 'encrypted', '--attachable=false', 'backend']]);
    });

    it('L3: an existing network of that name that is not an ENCRYPTED overlay is refused (never reused, never removed)', async () => {
      for (const [answer, what] of [
        ['overlay|{"com.docker.network.driver.overlay.vxlanid_list":"4097"}', /an overlay WITHOUT data-plane encryption/],
        ['bridge|{}', /not an overlay network/],
      ] as const) {
        runMock.mockClear();
        captureMock.mockImplementation(async (_cmd: string, args: string[]) => (args[0] === 'network' && args[1] === 'inspect' ? answer : ''));
        await expect(newOrchestrator().deployStack(stack({ networks: [{ name: 'frontend', driver: 'overlay', attachable: true }] }))).rejects.toThrow(what);
        expect(calls('network create')).toEqual([]);
        expect(calls('network rm')).toEqual([]);
        expect(calls('stack deploy')).toEqual([]);
      }
      expect(captureMock.mock.calls.find((c) => c[1][1] === 'inspect')?.[1]).toEqual(['network', 'inspect', '--format', '{{.Driver}}|{{json .Options}}', 'frontend']);
    });

    it('tolerates a network that already exists (inspected first; a lost create race re-checks)', async () => {
      captureMock.mockImplementation(async (_cmd: string, args: string[]) => (args[0] === 'network' ? 'overlay|{"encrypted":""}' : ''));
      await newOrchestrator().deployStack(stack({ networks: [{ name: 'frontend', driver: 'overlay', attachable: true }] }));
      expect(calls('network create')).toEqual([]);
      // Missing at the first look, created (encrypted) by someone else in between.
      let looks = 0;
      captureMock.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'network' && args[1] === 'inspect' && looks++ === 0) throw new Error('No such network');
        return args[0] === 'network' ? 'overlay|{"encrypted":""}' : '';
      });
      runMock.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[1] === 'create') throw new Error('network with name frontend already exists');
      });
      const status = await newOrchestrator().deployStack(stack({ networks: [{ name: 'frontend', driver: 'overlay', attachable: true }] }));
      expect(status.error).toBeUndefined();
    });

    it('a network that cannot be created fails the apply (never swallowed); nothing is deployed', async () => {
      runMock.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'network') throw new Error('this node is not a swarm manager');
      });
      await expect(newOrchestrator().deployStack(stack({ networks: [{ name: 'frontend', driver: 'overlay', attachable: true }] }))).rejects.toThrow(
        /Could not create the encrypted overlay network frontend: .*ESP, IP protocol 50/,
      );
      expect(calls('stack deploy')).toEqual([]);
    });
  });

  describe('deployStack — secrets + configs (D7e)', () => {
    it('creates each as <name>-<sha8> from a 0600 temp file, labelled with the stack, then removes the file', async () => {
      await newOrchestrator().deployStack(
        stack({ secrets: [{ name: 'db_url', data: 'postgres://localhost' }], configs: [{ name: 'app_cfg', data: 'level=info' }] }),
      );
      const secretName = hashedObjectName('db_url', 'postgres://localhost');
      const configName = hashedObjectName('app_cfg', 'level=info');
      expect(secretName).toMatch(/^db_url-[0-9a-f]{8}$/);
      expect(calls('secret create')).toEqual([['secret', 'create', '--label', 'ninedeploy.stack=demo', secretName, stackPath('demo', `${secretName}.secret.tmp`)]]);
      expect(calls('config create')).toEqual([['config', 'create', '--label', 'ninedeploy.stack=demo', configName, stackPath('demo', `${configName}.config.tmp`)]]);
      expect(h.log.get(stackPath('demo', `${secretName}.secret.tmp`))).toEqual(['postgres://localhost']);
      expect(h.files.has(stackPath('demo', `${secretName}.secret.tmp`))).toBe(false);
      expect(h.files.has(stackPath('demo', `${configName}.config.tmp`))).toBe(false);
      // The stack file points at the hashed objects.
      expect(stackFile().secrets).toEqual({ db_url: { external: true, name: secretName } });
      expect(stackFile().configs).toEqual({ app_cfg: { external: true, name: configName } });
    });

    it('reuses an object whose content is unchanged (same hash) instead of re-creating it', async () => {
      captureMock.mockImplementation(async (_cmd: string, args: string[]) => (args[0] === 'secret' && args[1] === 'inspect' ? 'id' : ''));
      await newOrchestrator().deployStack(stack({ secrets: [{ name: 'db_url', data: 'x' }] }));
      expect(calls('secret create')).toEqual([]);
    });

    it('prunes the superseded objects of this stack after a successful apply, keeping the current one', async () => {
      const current = hashedObjectName('db_url', 'new');
      captureMock.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[1] === 'inspect') throw new Error('No such secret');
        if (args[0] === 'secret' && args[1] === 'ls') return `${hashedObjectName('db_url', 'old')}\n${current}`;
        return '';
      });
      await newOrchestrator().deployStack(stack({ secrets: [{ name: 'db_url', data: 'new' }] }));
      expect(calls('secret rm')).toEqual([['secret', 'rm', hashedObjectName('db_url', 'old')]]);
      expect(captureMock.mock.calls.find((c) => c[1][1] === 'ls')?.[1]).toEqual(['secret', 'ls', '--filter', 'label=ninedeploy.stack=demo', '--format', '{{.Name}}']);
    });
  });

  describe('deployStack — the stack file and the apply', () => {
    it('renders the golden stack file: replicas, rolling update + rollback, env_file, labels, networks, no ports', async () => {
      await newOrchestrator().deployStack(
        stack({
          networks: [{ name: 'nd-swarm-web', driver: 'overlay', attachable: true }],
          services: [svc({ name: 'web', image: 'nginx:1.27', replicas: 3, port: 80, healthPath: '/health', env: { A: '1' }, networks: ['nd-swarm-web'], labels: { 'ninedeploy.service': '7' } })],
        }),
      );
      expect(stackFile()).toEqual({
        version: '3.9',
        services: {
          web: {
            image: 'nginx:1.27',
            env_file: [stackPath('demo', 'web.env')],
            networks: ['nd-swarm-web'],
            deploy: {
              replicas: 3,
              update_config: { parallelism: 1, order: 'start-first', failure_action: 'rollback', monitor: '30s' },
              rollback_config: { parallelism: 1, order: 'start-first' },
              restart_policy: { condition: 'any' },
              labels: { 'ninedeploy.service': '7', 'ninedeploy.stack': 'demo' },
            },
          },
        },
        networks: { 'nd-swarm-web': { external: true, name: 'nd-swarm-web' } },
      });
      // Written 0600; no `ports`, no `--publish`, no generated healthcheck (D7c).
      expect(h.files.get(stackPath('demo', 'stack.yml'))?.mode).toBe(0o600);
      expect(JSON.stringify(stackFile())).not.toMatch(/ports|healthcheck/);
      expect(runMock.mock.calls.flatMap((c) => c[1])).not.toContain('--publish');
    });

    it('applies with one `stack deploy --prune --detach=false -c <file> <stack>`; no registry auth is forwarded by default', async () => {
      await newOrchestrator().deployStack(stack({ services: [svc()] }));
      expect(calls('stack deploy')).toEqual([['stack', 'deploy', '--prune', '--detach=false', '-c', stackPath('demo', 'stack.yml'), 'demo']]);
      expect(stackDeployArgs({ name: 'x', resolveImage: 'never' }, 'f')).toEqual(['stack', 'deploy', '--prune', '--resolve-image', 'never', '-c', 'f', 'x']);
    });

    it('M4: a detached apply with a private client config forwards registry auth only when asked', async () => {
      await newOrchestrator().deployStack(stack({ services: [svc()] }), { wait: false, dockerConfig: '/cfg/one', withRegistryAuth: true });
      await newOrchestrator().deployStack(stack({ services: [svc()] }), { wait: false, dockerConfig: '/cfg/two' });
      const applies = runMock.mock.calls.map((c) => c[1] as string[]).filter((a) => a.includes('deploy'));
      expect(applies).toEqual([
        ['--config', '/cfg/one', 'stack', 'deploy', '--prune', '--with-registry-auth', '--detach=true', '-c', stackPath('demo', 'stack.yml'), 'demo'],
        ['--config', '/cfg/two', 'stack', 'deploy', '--prune', '--detach=true', '-c', stackPath('demo', 'stack.yml'), 'demo'],
      ]);
    });

    it('L2: the env file is unlinked first, then created exclusively (wx, 0600); the directory is chmodded 0700 every time', async () => {
      const fs = await import('node:fs');
      const write = vi.spyOn(fs, 'writeFileSync');
      const chmod = vi.spyOn(fs, 'chmodSync');
      h.files.set(stackPath('demo', 'api.env'), { data: 'planted' });
      await newOrchestrator().deployStack(stack({ services: [svc({ env: { A: '1' } })] }));
      const envWrite = write.mock.calls.find((c) => c[0] === stackPath('demo', 'api.env'));
      expect(envWrite?.[2]).toEqual({ flag: 'wx', mode: 0o600 });
      expect(h.log.get(stackPath('demo', 'api.env'))?.at(-1)).toBe('A=1\n');
      expect(chmod).toHaveBeenCalledWith(stackPath('demo'), 0o700);
      write.mockRestore();
      chmod.mockRestore();
    });

    it('L2: the boot sweep removes left-over env and temp files and per-deploy client configs, nothing else', async () => {
      const { sweepSwarmEnvFiles } = await import('../../src/kernel/drivers/swarmOrchestrator.js');
      h.files.set(ROOT, { dir: true });
      h.files.set(stackPath('demo', 'api.env'), { data: 'A=1' });
      h.files.set(stackPath('demo', 'x.secret.tmp'), { data: 's' });
      h.files.set(stackPath('demo', 'stack.json'), { data: '{}' });
      h.files.set(join(ROOT, '.docker-abc123'), { dir: true });
      expect(sweepSwarmEnvFiles(ROOT)).toBe(3);
      expect(h.files.has(stackPath('demo', 'api.env'))).toBe(false);
      expect(h.files.has(stackPath('demo', 'x.secret.tmp'))).toBe(false);
      expect(h.files.has(join(ROOT, '.docker-abc123'))).toBe(false);
      expect(h.files.has(stackPath('demo', 'stack.json'))).toBe(true);
      expect(sweepSwarmEnvFiles(join(ROOT, 'missing'))).toBe(0);
    });

    it('a redeploy is the same create-or-update apply: env, replicas and labels change with it (D7a)', async () => {
      const o = newOrchestrator();
      await o.deployStack(stack({ services: [svc({ env: { A: '1' } })] }));
      await o.deployStack(stack({ services: [svc({ env: { A: '2' }, replicas: 4, labels: { x: 'y' } })] }));
      expect(calls('stack deploy')).toHaveLength(2);
      expect(calls('service update')).toEqual([]);
      expect(stackFile().services.api.deploy).toMatchObject({ replicas: 4, labels: { x: 'y' } });
      expect(h.log.get(stackPath('demo', 'api.env'))).toEqual(['A=1\n', 'A=2\n']);
    });

    it('env reaches Swarm through a 0600 env file that is removed after the apply, never argv (D7b)', async () => {
      await newOrchestrator().deployStack(stack({ services: [svc({ env: { SECRET: 'v@l=ue$HOME' } })] }));
      expect(h.log.get(stackPath('demo', 'api.env'))).toEqual(['SECRET=v@l=ue$HOME\n']);
      expect(h.files.has(stackPath('demo', 'api.env'))).toBe(false);
      expect(runMock.mock.calls.flatMap((c) => c[1]).join(' ')).not.toContain('v@l=ue');
      // Also when the apply fails.
      runMock.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[1] === 'deploy') throw new Error('exit 1');
      });
      await newOrchestrator().deployStack(stack({ services: [svc({ env: { SECRET: 'x' } })] }));
      expect(h.files.has(stackPath('demo', 'api.env'))).toBe(false);
    });

    it('refuses a multi-line env value by name before anything is applied', async () => {
      const status = await newOrchestrator().deployStack(stack({ services: [svc({ env: { PEM: 'a\nb' } })] }));
      expect(status.error).toMatch(/PEM spans several lines/);
      expect(calls('stack deploy')).toEqual([]);
    });

    it('renders constraints, command, limits and the stop grace; escapes $ (the CLI interpolates the stack file)', async () => {
      const file = JSON.parse(
        renderStackFile(
          stack({
            resolveImage: 'never',
            services: [
              svc({ constraints: ['node.labels.nd.preload.web!=0'], command: ['sh', '-c', 'echo $HOME'], cpuLimitMilli: 500, memLimitMb: 256, stopGraceSeconds: 20 }),
            ],
          }),
          { envFiles: {}, secrets: {}, configs: {} },
        ),
      ) as Record<string, any>;
      expect(file.services.api).toMatchObject({
        command: ['sh', '-c', 'echo $$HOME'],
        stop_grace_period: '20s',
        deploy: { placement: { constraints: ['node.labels.nd.preload.web!=0'] }, resources: { limits: { cpus: '0.5', memory: '256M' } } },
      });
      expect(file.services.api.env_file).toBeUndefined();
    });

    it('a failed apply records the state with the error and returns it in the status', async () => {
      runMock.mockImplementation(async (_cmd: string, args: string[], _o: unknown, sink: (l: string) => void) => {
        if (args[1] === 'deploy') {
          sink('web: update rolled back due to failure or early termination of task');
          throw new Error('exited with code 1');
        }
      });
      const status = await newOrchestrator().deployStack(stack({ services: [svc()] }));
      expect(status.error).toMatch(/docker stack deploy demo failed: .*rolled back/);
      const saved = JSON.parse(h.files.get(stackPath('demo', 'stack.json'))!.data!) as { error: string; serviceNames: string[] };
      expect(saved).toMatchObject({ serviceNames: ['demo_api'], error: expect.stringMatching(/rolled back/) });
    });

    it('falls back to an apply without --detach on a CLI that does not know the flag', async () => {
      runMock.mockImplementation(async (_cmd: string, args: string[], _o: unknown, sink: (l: string) => void) => {
        if (args.includes('--detach=false')) {
          sink('unknown flag: --detach');
          throw new Error('exited with code 125');
        }
      });
      const status = await newOrchestrator().deployStack(stack({ services: [svc()] }));
      expect(status.error).toBeUndefined();
      expect(calls('stack deploy').map((a) => a.includes('--detach=false'))).toEqual([true, false]);
    });

    it('refuses a stack name that is not a plain Docker name (it becomes a path segment)', async () => {
      await expect(newOrchestrator().deployStack(stack({ name: '../etc' }))).rejects.toThrow(/Invalid stack name/);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('upserts via the update path when the stack already has a DB row', async () => {
      const o = newOrchestrator({ findFirst: { swarmStacks: { id: 1, name: 'demo', stateJson: state('demo', []) } } });
      await o.deployStack(stack({ services: [svc()] }));
      const parsed = JSON.parse(h.files.get(stackPath('demo', 'stack.json'))!.data!) as { serviceNames: string[] };
      expect(parsed.serviceNames).toEqual(['demo_api']);
    });
  });

  describe('state persistence', () => {
    it('writes the stack.json (0600) after a deploy', async () => {
      await newOrchestrator().deployStack(
        stack({
          services: [svc({ networks: ['frontend'], secrets: ['db_url'], configs: ['app_cfg'] })],
          networks: [{ name: 'frontend', driver: 'overlay', attachable: true }],
          secrets: [{ name: 'db_url', data: 'x' }],
          configs: [{ name: 'app_cfg', data: 'y' }],
        }),
      );
      const file = h.files.get(stackPath('demo', 'stack.json'))!;
      expect(file.mode).toBe(0o600);
      const parsed = JSON.parse(file.data!) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        name: 'demo',
        networks: ['frontend'],
        secrets: [hashedObjectName('db_url', 'x')],
        configs: [hashedObjectName('app_cfg', 'y')],
        serviceNames: ['demo_api'],
        appliedAt: expect.stringMatching(/T.*Z$/),
      });
    });

    it('prefers the on-disk stack.json over the DB row on readState', async () => {
      h.files.set(stackPath('mine', 'stack.json'), { data: state('mine', ['disk-svc'], { networks: ['disk-net'] }) });
      const st = await newOrchestrator()['readState']('mine');
      expect(st?.networks).toEqual(['disk-net']);
      expect(st?.serviceNames).toEqual(['disk-svc']);
    });

    it('falls back to the DB row when the on-disk stack.json is unparseable', async () => {
      h.files.set(stackPath('mine', 'stack.json'), { data: '{not json' });
      const o = newOrchestrator({ findFirst: { swarmStacks: { name: 'mine', stateJson: state('mine', ['db-svc'], { networks: ['db-net'] }) } } });
      expect((await o['readState']('mine'))?.networks).toEqual(['db-net']);
    });

    it('returns null from readState when neither the file nor the DB has the stack', async () => {
      expect(await newOrchestrator()['readState']('missing')).toBeNull();
    });
  });

  describe('getStackStatus', () => {
    const withState = (serviceNames: string[]) => h.files.set(stackPath('s', 'stack.json'), { data: state('s', serviceNames) });

    it('classifies a fully-running service as "running" with the parsed replica count', async () => {
      withState(['s_api']);
      captureMock.mockResolvedValueOnce('s_api 3/3');
      expect((await newOrchestrator().getStackStatus('s'))?.services).toEqual([{ name: 's_api', state: 'running', replicas: 3, desired: 3 }]);
      expect(captureMock.mock.calls[0]?.[1]).toEqual(['stack', 'services', 's', '--format', '{{.Name}} {{.Replicas}}']);
    });

    it('classifies a zero-replica service as "stopped"', async () => {
      withState(['s_api']);
      captureMock.mockResolvedValueOnce('s_api 0/0');
      expect((await newOrchestrator().getStackStatus('s'))?.services).toEqual([{ name: 's_api', state: 'stopped', replicas: 0, desired: 0 }]);
    });

    it('classifies a partially-up service as "partial" (a placement note after the count is ignored)', async () => {
      withState(['s_api']);
      captureMock.mockResolvedValueOnce('s_api 1/3 (max 1 per node)');
      expect((await newOrchestrator().getStackStatus('s'))?.services).toEqual([{ name: 's_api', state: 'partial', replicas: 1, desired: 3 }]);
    });

    it('classifies a docker error as "unknown"', async () => {
      withState(['s_api']);
      captureMock.mockRejectedValueOnce(new Error('docker daemon not reachable'));
      expect((await newOrchestrator().getStackStatus('s'))?.services).toEqual([{ name: 's_api', state: 'unknown', replicas: 0 }]);
    });

    it('reads a pre-0.16 state (bare service names) as <stack>_<name>, and reports the last apply error', async () => {
      h.files.set(stackPath('s', 'stack.json'), { data: state('s', ['api'], { error: 'rolled back' }) });
      captureMock.mockResolvedValueOnce('s_api 2/2');
      expect(await newOrchestrator().getStackStatus('s')).toMatchObject({ services: [{ name: 's_api', state: 'running' }], error: 'rolled back' });
    });

    it('returns null for an unknown stack, and for a name that is not a stack name', async () => {
      expect(await newOrchestrator().getStackStatus('ghost')).toBeNull();
      expect(await newOrchestrator().getStackStatus('../x')).toBeNull();
    });
  });

  describe('ownership + exact-name matching (F184/F186)', () => {
    it('F186: Swarm namespaces each stack, so removing one never touches another stack of the same service name', async () => {
      const o = newOrchestrator();
      await o.deployStack(stack({ name: 'a', services: [svc({ name: 'web' })] }));
      await o.deployStack(stack({ name: 'b', services: [svc({ name: 'web' })] }));
      runMock.mockClear();
      await o.removeStack('b');
      expect(calls('stack rm')).toEqual([['stack', 'rm', 'b']]);
      expect(runMock.mock.calls.flatMap((c) => c[1])).not.toContain('a');
    });

    it('F184: a prefix sibling never stands in for the service in status (exact row only)', async () => {
      h.files.set(stackPath('demo', 'stack.json'), { data: state('demo', ['demo_web']) });
      captureMock.mockResolvedValueOnce('demo_web-api 3/3');
      expect((await newOrchestrator().getStackStatus('demo'))?.services).toEqual([{ name: 'demo_web', state: 'unknown', replicas: 0 }]);
    });
  });

  describe('listStacks', () => {
    it('returns one entry per row with the service count from stateJson', async () => {
      const o = newOrchestrator({
        select: {
          swarmStacks: [
            { name: 'a', stateJson: JSON.stringify({ name: 'a', serviceNames: ['s1', 's2'] }) },
            { name: 'b', stateJson: JSON.stringify({ name: 'b', serviceNames: [] }) },
          ],
        },
      });
      expect(await o.listStacks()).toEqual([
        { name: 'a', serviceCount: 2 },
        { name: 'b', serviceCount: 0 },
      ]);
    });

    it('treats a malformed stateJson row as a JSON.parse rejection', async () => {
      const o = newOrchestrator({ select: { swarmStacks: [{ name: 'broken', stateJson: '{not json' }] } });
      await expect(o.listStacks()).rejects.toThrow();
    });
  });

  describe('removeStack', () => {
    it('removes the stack, waits for its tasks, then its secrets, configs and networks, the dir and the DB row', async () => {
      h.files.set(stackPath('mine'), { dir: true });
      h.files.set(stackPath('mine', 'stack.json'), { data: state('mine', ['mine_svc1'], { networks: ['n1'], secrets: ['s1'], configs: ['c1'] }) });
      let ps = 0;
      captureMock.mockImplementation(async (_cmd: string, args: string[]) => (args[1] === 'ps' ? (ps++ === 0 ? 'task1' : '') : ''));
      await newOrchestrator().removeStack('mine');
      const verbs = runMock.mock.calls.map((c) => `${c[1]?.[0]} ${c[1]?.[1]} ${c[1]?.[2] ?? ''}`.trim());
      expect(verbs).toEqual(['stack rm mine', 'secret rm s1', 'config rm c1', 'network rm n1']);
      expect(ps).toBe(2);
      expect(h.files.has(stackPath('mine'))).toBe(false);
    });

    it('is a no-op on an unknown stack (no state, no DB row)', async () => {
      await newOrchestrator().removeStack('missing');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('tolerates docker rm failures (best-effort)', async () => {
      h.files.set(stackPath('mine', 'stack.json'), { data: state('mine', ['mine_svc1'], { networks: ['n1'] }) });
      runMock.mockRejectedValue(new Error('not found'));
      await expect(newOrchestrator().removeStack('mine')).resolves.toBeUndefined();
    });
  });
});
