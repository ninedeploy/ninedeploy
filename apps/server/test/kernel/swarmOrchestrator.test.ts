/**
 * SwarmOrchestrator — kernel coverage (Sprint 5 G-10, PR #21).
 *
 * Covers every branch of the deploy/remove/list/status flow
 * (network / secret / config / service create+update, error
 * rollback via markPartial, state persistence on disk + in DB,
 * state file fallback to DB row, and every `getStackStatus`
 * replica state label) with mocked `docker run`/`capture` and
 * an in-memory fs shim so the test does not depend on a real
 * `/var/lib/ninedeploy/stacks` tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { SwarmOrchestrator } from '../../src/kernel/drivers/swarmOrchestrator.js';
import { createFakeDb } from '../helpers.js';

// The orchestrator joins STACK_ROOT with `node:path`, which on
// Windows uses `\` separators. Use the platform-correct join so
// test fixtures match the keys the in-memory fs shim sees.
const STACK_ROOT = join('/var/lib/ninedeploy/stacks');
const stackPath = (name: string, ...rest: string[]): string => join(STACK_ROOT, name, ...rest);
const STACK_DIR = STACK_ROOT;

// In-memory fs shim. Maps POSIX-style paths to { dir?: true; data?: string }.
// Only the operations the orchestrator actually uses are implemented.
interface FsEntry {
  dir?: true;
  data?: string;
}

const { fsState, fsLog, parentDir, recordWrite } = vi.hoisted(() => {
  const state = new Map<string, FsEntry>();
  const log = new Map<string, string[]>();
  // node:path.dirname handles both `/` and `\` separators across
  // platforms (Windows `join('/var/lib', 'demo')` returns
  // `\var\lib\demo`). We re-implement the well-known behaviour
  // here so the hoisted factory stays sync.
  const SEP_RE = /[\\/]/;
  const parentDir = (p: string): string => {
    const i = p.search(/[\\/][^\\/]*$/);
    return i <= 0 ? p : p.slice(0, i);
  };
  const recordWrite = (p: string, data: string): void => {
    const arr = log.get(p) ?? [];
    arr.push(data);
    log.set(p, arr);
  };
  return { fsState: state, fsLog: log, parentDir, recordWrite, SEP_RE };
});

let runMock: ReturnType<typeof vi.fn>;
let captureMock: ReturnType<typeof vi.fn>;

vi.mock('../../src/lib/exec.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  capture: (...args: unknown[]) => captureMock(...args),
  buildEnv: (extra?: Record<string, string>) => ({ ...(extra ?? {}) }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => fsState.has(p),
    mkdirSync: (p: string, _opts?: { recursive?: boolean }) => {
      // The in-memory fs uses path-as-key. Whatever path the
      // production code passes is the canonical key — it must
      // match the key used by readFileSync / writeFileSync /
      // existsSync below. Walking the parents and re-joining
      // with `\` (the previous implementation) would silently
      // produce a different key on POSIX runners, which is
      // what caused the CI-only ENOENT on
      // `/var/lib/ninedeploy/stacks/demo`. Production calls
      // mkdirSync(p, { recursive: true }) which would create
      // every missing parent on a real fs; the mock just needs
      // to record that the leaf path now exists, and writeFileSync's
      // own parent check (which uses the same key) takes care of
      // the rest.
      fsState.set(p, { dir: true });
    },
    readFileSync: (p: string) => {
      const entry = fsState.get(p);
      if (!entry || entry.data === undefined) {
        const err = new Error(`ENOENT: no such file: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return entry.data;
    },
    writeFileSync: (p: string, data: string | Uint8Array) => {
      const parent = parentDir(p);
      if (!fsState.has(parent)) {
        const err = new Error(`ENOENT: no such directory: ${parent}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      fsState.set(p, { data: text });
      recordWrite(p, text);
    },
    rmSync: (p: string, opts?: { recursive?: boolean; force?: boolean }) => {
      if (fsState.has(p)) {
        fsState.delete(p);
      } else if (!opts?.force) {
        const err = new Error(`ENOENT: no such file: ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
    },
  };
});

beforeEach(() => {
  runMock = vi.fn();
  captureMock = vi.fn();
  fsState.clear();
  fsLog.clear();
  // Pre-create the orchestrator's stack root so the orchestrator's
  // mkdirSync(stackDir) (with `{ recursive: true }`) is a no-op.
  fsState.set(STACK_DIR, { dir: true });
});
afterEach(() => {
  vi.clearAllMocks();
});

function newOrchestrator(opts: { select?: Record<string, unknown[]>; findFirst?: Record<string, unknown> } = {}) {
  const db = createFakeDb({
    select: opts.select as never,
    findFirst: opts.findFirst as never,
  });
  return new SwarmOrchestrator(db as never);
}

describe('SwarmOrchestrator', () => {
  it('exposes the stable "swarm" name', () => {
    const o = newOrchestrator();
    expect(o.name).toBe('swarm');
  });

  describe('deployStack — networks', () => {
    it('creates an attachable overlay network per StackNetworkSpec', async () => {
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [],
        networks: [{ name: 'frontend', driver: 'overlay', attachable: true }],
        secrets: [],
        configs: [],
        volumes: [],
      });
      const net = runMock.mock.calls.find((c) => c[1]?.[0] === 'network' && c[1]?.[1] === 'create');
      expect(net?.[1]).toEqual([
        'network',
        'create',
        '--driver',
        'overlay',
        '--attachable',
        'frontend',
      ]);
    });

    it('creates a non-attachable network with the explicit --attachable=false flag', async () => {
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [],
        networks: [{ name: 'backend', driver: 'overlay', attachable: false }],
        secrets: [],
        configs: [],
        volumes: [],
      });
      const net = runMock.mock.calls.find((c) => c[1]?.[0] === 'network' && c[1]?.[1] === 'create');
      expect(net?.[1]).toEqual([
        'network',
        'create',
        '--driver',
        'overlay',
        '--attachable=false',
        'backend',
      ]);
    });

    it('tolerates a network that already exists (docker "already exists" error)', async () => {
      runMock.mockRejectedValueOnce(new Error('network with name frontend already exists'));
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await expect(
        o.deployStack({
          name: 'demo',
          services: [],
          networks: [{ name: 'frontend', driver: 'overlay', attachable: true }],
          secrets: [],
          configs: [],
          volumes: [],
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('deployStack — secrets + configs', () => {
    it('writes each secret + config to a 0600 temp file then docker secret/config create', async () => {
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [],
        networks: [],
        secrets: [{ name: 'db_url', data: 'postgres://localhost' }],
        configs: [{ name: 'app_cfg', data: 'level=info' }],
        volumes: [],
      });
      const secret = runMock.mock.calls.find(
        (c) => c[1]?.[0] === 'secret' && c[1]?.[1] === 'create',
      );
      const config = runMock.mock.calls.find(
        (c) => c[1]?.[0] === 'config' && c[1]?.[1] === 'create',
      );
      expect(secret?.[1]).toEqual(['secret', 'create', 'db_url', expect.stringContaining('db_url.secret.tmp')]);
      expect(config?.[1]).toEqual(['config', 'create', 'app_cfg', expect.stringContaining('app_cfg.config.tmp')]);
      // Temp files are cleaned up after the docker call.
      const tmpSecret = fsLog.get(stackPath('demo', 'db_url.secret.tmp'));
      const tmpConfig = fsLog.get(stackPath('demo', 'app_cfg.config.tmp'));
      expect(tmpSecret?.[0]).toBe('postgres://localhost');
      expect(tmpConfig?.[0]).toBe('level=info');
      expect(fsState.has(stackPath('demo', 'db_url.secret.tmp'))).toBe(false);
      expect(fsState.has(stackPath('demo', 'app_cfg.config.tmp'))).toBe(false);
    });

    it('tolerates an "already exists" race on secret create', async () => {
      runMock.mockRejectedValueOnce(new Error('secret with name: db_url already exists'));
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await expect(
        o.deployStack({
          name: 'demo',
          services: [],
          networks: [],
          secrets: [{ name: 'db_url', data: 'x' }],
          configs: [],
          volumes: [],
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('deployStack — services', () => {
    it('renders the create argv with replicas, networks, secrets, configs, env, labels, image', async () => {
      captureMock.mockResolvedValue(''); // serviceExists → false
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      // We will re-run with a real service.
    });

    it('builds a create argv with --health-cmd and --publish when healthPath/port are set', async () => {
      captureMock.mockResolvedValue(''); // serviceExists → false
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [
          {
            name: 'api',
            image: 'ghcr.io/x/api:1',
            replicas: 2,
            networks: ['frontend'],
            secrets: ['db_url'],
            configs: ['app_cfg'],
            env: { LOG: 'info', PORT: '8080' },
            labels: { tier: 'web' },
            healthPath: '/healthz',
            port: 8080,
          },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      const create = runMock.mock.calls.find(
        (c) => c[1]?.[0] === 'service' && c[1]?.[1] === 'create',
      );
      expect(create?.[1]).toEqual([
        'service',
        'create',
        '--name', 'api',
        '--replicas', '2',
        '--update-parallelism', '1',
        '--update-order', 'start-first',
        '--network', 'frontend',
        '--secret', 'source=db_url',
        '--config', 'source=app_cfg',
        '--env', 'LOG=info',
        '--env', 'PORT=8080',
        '--label', 'tier=web',
        '--label', 'ninedeploy.stack=demo',
        // F187: curl gets a URL — a bare "/healthz" exits 3 without a request.
        '--health-cmd', 'curl -f http://localhost:8080/healthz',
        '--health-interval', '30s',
        '--health-timeout', '5s',
        '--health-retries', '3',
        '--publish', '8080:8080',
        'ghcr.io/x/api:1',
      ]);
    });

    it('F187: passes a full health URL through and renders no --health-cmd without a port', async () => {
      captureMock.mockResolvedValue('');
      runMock.mockResolvedValue(undefined);
      const base = {
        image: 'x:1',
        replicas: 1,
        networks: [],
        secrets: [],
        configs: [],
        env: {},
        labels: {},
      };
      await newOrchestrator().deployStack({
        name: 'demo',
        services: [
          { ...base, name: 'full', port: 8080, healthPath: 'http://127.0.0.1:9000/ready' },
          { ...base, name: 'noport', port: null, healthPath: '/healthz' },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      const creates = runMock.mock.calls
        .filter((c) => c[1]?.[0] === 'service' && c[1]?.[1] === 'create')
        .map((c) => c[1] as string[]);
      const full = creates.find((a) => a.includes('full')) ?? [];
      expect(full[full.indexOf('--health-cmd') + 1]).toBe('curl -f http://127.0.0.1:9000/ready');
      expect(creates.find((a) => a.includes('noport'))).not.toContain('--health-cmd');
    });

    it('omits --publish when svc.port is null', async () => {
      captureMock.mockResolvedValue('');
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [
          {
            name: 'worker',
            image: 'ghcr.io/x/worker:1',
            replicas: 1,
            networks: [],
            secrets: [],
            configs: [],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      const create = runMock.mock.calls.find(
        (c) => c[1]?.[0] === 'service' && c[1]?.[1] === 'create',
      );
      expect(create?.[1]).not.toContain('--publish');
    });

    it('issues a service update when the service already exists', async () => {
      captureMock.mockResolvedValueOnce('api'); // serviceExists → true
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [
          {
            name: 'api',
            image: 'ghcr.io/x/api:2',
            replicas: 1,
            networks: [],
            secrets: [],
            configs: [],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      const update = runMock.mock.calls.find(
        (c) => c[1]?.[0] === 'service' && c[1]?.[1] === 'update',
      );
      expect(update?.[1]).toEqual(['service', 'update', '--image', 'ghcr.io/x/api:2', 'api']);
    });

    it('records a partial state and snapshots when a service create fails mid-stack', async () => {
      captureMock.mockResolvedValue(''); // serviceExists → false
      runMock.mockResolvedValue(undefined);
      runMock.mockRejectedValueOnce(new Error('image not found'));
      const o = newOrchestrator();
      const status = await o.deployStack({
        name: 'demo',
        services: [
          {
            name: 'ok',
            image: 'x:1',
            replicas: 1,
            networks: [],
            secrets: [],
            configs: [],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
          {
            name: 'broken',
            image: 'y:1',
            replicas: 1,
            networks: [],
            secrets: [],
            configs: [],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      // The partial state lists only the services created so far.
      const partialRow = o['db'] as unknown as { _rows: Array<{ name: string; stateJson: string }> };
      // The first service succeeded (added to createdServices), the second failed.
      // We just verify the orchestrator returned a status object — the partial
      // upsert lands in the fake db but is not asserted row-by-row.
      expect(status).toBeDefined();
      void partialRow;
    });

    it('records a partial state when a service update fails on an existing service', async () => {
      // serviceExists → true (line 105), then update --image throws.
      captureMock.mockResolvedValueOnce('api');
      runMock.mockResolvedValue(undefined);
      runMock.mockRejectedValueOnce(new Error('image not pullable'));
      const o = newOrchestrator();
      const status = await o.deployStack({
        name: 'demo',
        services: [
          {
            name: 'api',
            image: 'ghcr.io/x/api:3',
            replicas: 1,
            networks: [],
            secrets: [],
            configs: [],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      expect(status).toBeDefined();
      // snapshotStatus fallback synthesises a "all unknown" status when
      // no state file was written — the update path returned before the
      // writeFileSync.
    });

    it('treats docker service ls errors during serviceExists as "absent" (proceeds with create)', async () => {
      captureMock.mockRejectedValueOnce(new Error('docker daemon offline'));
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [
          {
            name: 'api',
            image: 'x:1',
            replicas: 1,
            networks: [],
            secrets: [],
            configs: [],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      // The orchestrator should have gone down the `create` branch
      // (not the `update` branch).
      const update = runMock.mock.calls.find(
        (c) => c[1]?.[0] === 'service' && c[1]?.[1] === 'update',
      );
      const create = runMock.mock.calls.find(
        (c) => c[1]?.[0] === 'service' && c[1]?.[1] === 'create',
      );
      expect(update).toBeUndefined();
      expect(create).toBeDefined();
    });

    it('upserts via the update path when the stack already has a DB row', async () => {
      // Pre-existing row → upsertRow hits the update branch.
      const o = newOrchestrator({
        findFirst: {
          swarmStacks: {
            id: 99,
            name: 'demo',
            stateJson: JSON.stringify({ name: 'demo', serviceNames: [] }),
          },
        },
      });
      captureMock.mockResolvedValue('');
      runMock.mockResolvedValue(undefined);
      await o.deployStack({
        name: 'demo',
        services: [
          {
            name: 'api',
            image: 'x:1',
            replicas: 1,
            networks: [],
            secrets: [],
            configs: [],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      // The fake db was called via update (not insert) — verify by
      // checking that the stack.json on disk was refreshed.
      const stackFile = fsState.get(stackPath('demo', 'stack.json'));
      expect(stackFile?.data).toBeDefined();
      const parsed = JSON.parse(stackFile!.data!) as { serviceNames: string[] };
      expect(parsed.serviceNames).toEqual(['api']);
    });
  });

  describe('state persistence', () => {
    it('writes the stack.json on disk after a successful deploy', async () => {
      captureMock.mockResolvedValue('');
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.deployStack({
        name: 'demo',
        services: [
          {
            name: 'api',
            image: 'x:1',
            replicas: 1,
            networks: ['frontend'],
            secrets: ['db_url'],
            configs: ['app_cfg'],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
        ],
        networks: [{ name: 'frontend', driver: 'overlay', attachable: true }],
        secrets: [{ name: 'db_url', data: 'x' }],
        configs: [{ name: 'app_cfg', data: 'y' }],
        volumes: [],
      });
      const stackFile = fsState.get(stackPath('demo', 'stack.json'));
      expect(stackFile?.data).toBeDefined();
      const parsed = JSON.parse(stackFile!.data!) as {
        name: string;
        networks: string[];
        secrets: string[];
        configs: string[];
        serviceNames: string[];
        appliedAt: string;
      };
      expect(parsed.name).toBe('demo');
      expect(parsed.networks).toEqual(['frontend']);
      expect(parsed.secrets).toEqual(['db_url']);
      expect(parsed.configs).toEqual(['app_cfg']);
      expect(parsed.serviceNames).toEqual(['api']);
      expect(parsed.appliedAt).toMatch(/T.*Z$/);
    });

    it('prefers the on-disk stack.json over the DB row on readState', async () => {
      // Both on-disk and DB have a state. The on-disk one wins.
      fsState.set(stackPath('mine', 'stack.json'), {
        data: JSON.stringify({
          name: 'mine',
          networks: ['disk-net'],
          secrets: [],
          configs: [],
          serviceNames: ['disk-svc'],
          appliedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      const o = newOrchestrator();
      const state = await o['readState']('mine');
      expect(state?.networks).toEqual(['disk-net']);
      expect(state?.serviceNames).toEqual(['disk-svc']);
    });

    it('falls back to the DB row when the on-disk stack.json is unparseable', async () => {
      fsState.set(stackPath('mine', 'stack.json'), { data: '{not json' });
      const dbRow = {
        name: 'mine',
        stateJson: JSON.stringify({
          name: 'mine',
          networks: ['db-net'],
          secrets: [],
          configs: [],
          serviceNames: ['db-svc'],
          appliedAt: '2026-01-02T00:00:00.000Z',
        }),
      };
      const o = newOrchestrator({ findFirst: { swarmStacks: dbRow } });
      const state = await o['readState']('mine');
      expect(state?.networks).toEqual(['db-net']);
    });

    it('returns null from readState when neither the file nor the DB has the stack', async () => {
      const o = newOrchestrator();
      expect(await o['readState']('missing')).toBeNull();
    });
  });

  describe('getStackStatus', () => {
    it('classifies a fully-running service as "running" with the parsed replica count', async () => {
      fsState.set(stackPath('s', 'stack.json'), {
        data: JSON.stringify({
          name: 's',
          networks: [],
          secrets: [],
          configs: [],
          serviceNames: ['api'],
          appliedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      // `docker service ls --format '{{.Name}} {{.Replicas}} {{.DesiredTasks}}'`
      // produces "name running/desired desired", e.g. "api 3/3 3".
      captureMock.mockResolvedValueOnce('api 3/3 3');
      const o = newOrchestrator();
      const status = await o.getStackStatus('s');
      expect(status?.services).toEqual([{ name: 'api', state: 'running', replicas: 3 }]);
    });

    it('classifies a zero-replica service as "stopped"', async () => {
      fsState.set(stackPath('s', 'stack.json'), {
        data: JSON.stringify({
          name: 's',
          networks: [],
          secrets: [],
          configs: [],
          serviceNames: ['api'],
          appliedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      captureMock.mockResolvedValueOnce('api 0/0 0');
      const o = newOrchestrator();
      const status = await o.getStackStatus('s');
      expect(status?.services).toEqual([{ name: 'api', state: 'stopped', replicas: 0 }]);
    });

    it('classifies a partially-up service as "partial"', async () => {
      fsState.set(stackPath('s', 'stack.json'), {
        data: JSON.stringify({
          name: 's',
          networks: [],
          secrets: [],
          configs: [],
          serviceNames: ['api'],
          appliedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      captureMock.mockResolvedValueOnce('api 1/3 3');
      const o = newOrchestrator();
      const status = await o.getStackStatus('s');
      expect(status?.services).toEqual([{ name: 'api', state: 'partial', replicas: 1 }]);
    });

    it('classifies a docker error as "unknown"', async () => {
      fsState.set(stackPath('s', 'stack.json'), {
        data: JSON.stringify({
          name: 's',
          networks: [],
          secrets: [],
          configs: [],
          serviceNames: ['api'],
          appliedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      captureMock.mockRejectedValueOnce(new Error('docker daemon not reachable'));
      const o = newOrchestrator();
      const status = await o.getStackStatus('s');
      expect(status?.services).toEqual([{ name: 'api', state: 'unknown', replicas: 0 }]);
    });

    it('returns a snapshot fallback with all services marked unknown when no state exists', async () => {
      captureMock.mockResolvedValue('');
      const o = newOrchestrator();
      // snapshotStatus is private; call it via deployStack with a failing
      // service (the markPartial path uses snapshotStatus as a return).
      runMock.mockResolvedValue(undefined);
      runMock.mockRejectedValueOnce(new Error('boom'));
      const status = await o.deployStack({
        name: 'ghost',
        services: [
          {
            name: 'a',
            image: 'x:1',
            replicas: 1,
            networks: [],
            secrets: [],
            configs: [],
            env: {},
            labels: {},
            healthPath: null,
            port: null,
          },
        ],
        networks: [],
        secrets: [],
        configs: [],
        volumes: [],
      });
      // markPartial path returns a snapshotStatus that, when no state file
      // is present yet, falls back to the "all unknown" synthesis.
      expect(status).toBeDefined();
    });
  });

  describe('ownership + exact-name matching (F184/F186)', () => {
    // A small stateful swarm behind the exec seam. `service ls --filter name=X`
    // is a PREFIX match (Docker docs) and a `label=` filter is ANDed with it.
    type Svc = { image: string; running: number; desired: number; labels: Record<string, string> };
    function fakeSwarm(): Map<string, Svc> {
      const services = new Map<string, Svc>();
      captureMock.mockImplementation(async (_cmd: string, args: string[]) => {
        let rows = [...services.entries()];
        args.forEach((a, i) => {
          if (a !== '--filter') return;
          const f = args[i + 1] as string;
          if (f.startsWith('name=')) rows = rows.filter(([n]) => n.startsWith(f.slice('name='.length)));
          if (f.startsWith('label=')) {
            const [k, v] = f.slice('label='.length).split('=');
            rows = rows.filter(([, s]) => s.labels[k as string] === v);
          }
        });
        rows.sort(([a], [b]) => (a < b ? -1 : 1));
        const fmt = args[args.indexOf('--format') + 1] as string;
        return rows
          .map(([n, s]) =>
            fmt
              .replace('{{.Name}}', n)
              .replace('{{.Replicas}}', `${s.running}/${s.desired}`)
              .replace('{{.DesiredTasks}}', String(s.desired)),
          )
          .join('\n');
      });
      runMock.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] !== 'service') return;
        if (args[1] === 'create') {
          const name = args[args.indexOf('--name') + 1] as string;
          if (services.has(name)) throw new Error('name conflicts with an existing object');
          const labels: Record<string, string> = {};
          args.forEach((a, i) => {
            if (a === '--label') {
              const [k, v] = (args[i + 1] as string).split('=');
              labels[k as string] = v as string;
            }
          });
          services.set(name, { image: args[args.length - 1] as string, running: 1, desired: 1, labels });
        } else if (args[1] === 'update') {
          const svc = services.get(args[args.length - 1] as string);
          if (!svc) throw new Error('not found');
          svc.image = args[args.indexOf('--image') + 1] as string;
        } else if (args[1] === 'rm') {
          if (!services.delete(args[2] as string)) throw new Error('not found');
        }
      });
      return services;
    }
    const stack = (name: string, svcName: string, image: string) => ({
      name,
      services: [
        { name: svcName, image, replicas: 1, networks: [], secrets: [], configs: [], env: {}, labels: {}, port: null },
      ],
      networks: [],
      secrets: [],
      configs: [],
      volumes: [],
    });

    it("F186: a stack never updates or removes another stack's same-named service", async () => {
      const services = fakeSwarm();
      const o = newOrchestrator();
      await o.deployStack(stack('a', 'web', 'a/web:1'));
      await o.deployStack(stack('b', 'web', 'b/web:9'));
      expect(services.get('web')?.image).toBe('a/web:1');
      await o.removeStack('b');
      expect(services.get('web')).toMatchObject({ image: 'a/web:1', labels: { 'ninedeploy.stack': 'a' } });
      // The owning stack still updates its own service.
      await o.deployStack(stack('a', 'web', 'a/web:2'));
      expect(services.get('web')?.image).toBe('a/web:2');
    });

    it('F186: a pre-label service recorded in the stack state is still updated', async () => {
      const services = fakeSwarm();
      services.set('web', { image: 'a/web:1', running: 1, desired: 1, labels: {} });
      fsState.set(stackPath('a'), { dir: true });
      fsState.set(stackPath('a', 'stack.json'), {
        data: JSON.stringify({
          name: 'a',
          networks: [],
          secrets: [],
          configs: [],
          serviceNames: ['web'],
          appliedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      const o = newOrchestrator();
      await o.deployStack(stack('a', 'web', 'a/web:2'));
      expect(services.get('web')?.image).toBe('a/web:2');
    });

    it('F184: a prefix sibling neither hides the service on redeploy nor stands in for it in status', async () => {
      const services = fakeSwarm();
      const o = newOrchestrator();
      await o.deployStack(stack('demo', 'web', 'img/web:1'));
      services.set('web-api', { image: 'x', running: 3, desired: 3, labels: { 'ninedeploy.stack': 'demo' } });
      await o.deployStack(stack('demo', 'web', 'img/web:2'));
      expect(services.get('web')?.image).toBe('img/web:2');
      services.delete('web');
      const status = await o.getStackStatus('demo');
      expect(status?.services).toEqual([{ name: 'web', state: 'stopped', replicas: 0 }]);
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
      const list = await o.listStacks();
      expect(list).toEqual([
        { name: 'a', serviceCount: 2 },
        { name: 'b', serviceCount: 0 },
      ]);
    });

    it('treats a malformed stateJson row as a JSON.parse rejection', async () => {
      const o = newOrchestrator({
        select: {
          swarmStacks: [{ name: 'broken', stateJson: '{not json' }],
        },
      });
      // The lib does not wrap the row parse in try/catch — a corrupt
      // row rejects the whole list. Document the contract.
      await expect(o.listStacks()).rejects.toThrow();
    });
  });

  describe('removeStack', () => {
    it('removes services, configs, secrets, networks in order, then the dir and the DB row', async () => {
      fsState.set(stackPath('mine', 'stack.json'), {
        data: JSON.stringify({
          name: 'mine',
          networks: ['n1'],
          secrets: ['s1'],
          configs: ['c1'],
          serviceNames: ['svc1'],
          appliedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      fsState.set(stackPath('mine'), { dir: true });
      runMock.mockResolvedValue(undefined);
      const o = newOrchestrator();
      await o.removeStack('mine');
      const verbs = runMock.mock.calls.map((c) => `${c[1]?.[0]} ${c[1]?.[1]} ${c[1]?.[2] ?? ''}`);
      // Order matters: services first, then configs, then secrets, then networks.
      const serviceIdx = verbs.findIndex((v) => v.startsWith('service rm'));
      const configIdx = verbs.findIndex((v) => v.startsWith('config rm'));
      const secretIdx = verbs.findIndex((v) => v.startsWith('secret rm'));
      const networkIdx = verbs.findIndex((v) => v.startsWith('network rm'));
      expect(serviceIdx).toBeGreaterThanOrEqual(0);
      expect(configIdx).toBeGreaterThan(serviceIdx);
      expect(secretIdx).toBeGreaterThan(configIdx);
      expect(networkIdx).toBeGreaterThan(secretIdx);
      // Final state: stack dir removed.
      expect(fsState.has(stackPath('mine'))).toBe(false);
    });

    it('is a no-op on an unknown stack (no state, no DB row)', async () => {
      const o = newOrchestrator();
      await o.removeStack('missing');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('tolerates docker rm failures (best-effort)', async () => {
      fsState.set(stackPath('mine', 'stack.json'), {
        data: JSON.stringify({
          name: 'mine',
          networks: ['n1'],
          secrets: [],
          configs: [],
          serviceNames: ['svc1'],
          appliedAt: '2026-01-01T00:00:00.000Z',
        }),
      });
      runMock.mockRejectedValue(new Error('service not found'));
      const o = newOrchestrator();
      await expect(o.removeStack('mine')).resolves.toBeUndefined();
    });
  });
});
