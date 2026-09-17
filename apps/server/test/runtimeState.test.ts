import { describe, expect, it, vi, beforeEach } from 'vitest';
import runtimeStatePlugin from '../src/plugins/runtimeState.js';
import { buildTestApp, createFakeDb, svcRow, trackStatusUpdates } from './helpers.js';

const execMocks = vi.hoisted(() => ({
  capture: vi.fn(async () => 'running'),
  run: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/exec.js', () => execMocks);

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

const agentMocks = vi.hoisted(() => ({ agentOp: vi.fn(async () => ({ exitCode: 0, lines: [] })) }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: agentMocks.agentOp }));

const pm2Mocks = vi.hoisted(() => ({
  connect: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
  disconnect: vi.fn(),
  describe: vi.fn((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) => cb(null, [])),
  restart: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
  resurrect: vi.fn((cb: () => void) => cb()),
  dump: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
  start: vi.fn((_opts: unknown, cb: (err?: Error | null) => void) => cb(null)),
  stop: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
  delete: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
}));
vi.mock('pm2', () => ({ default: pm2Mocks }));

const configMock = vi.hoisted(() => ({
  wildcardDomain: '',
  isProd: false,
  publicUrl: 'http://localhost:3000',
  paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
  jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
}));
vi.mock('../src/config.js', () => ({ config: configMock }));

/** Build an app whose onReady runs one reconcile pass against `row`. */
async function reconcileOnce(
  row: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
) {
  const db = createFakeDb(
    {
      ...(row ? { findMany: { services: [row] } } : { findMany: { services: [] } }),
      ...extra,
    },
  );
  const { updates } = trackStatusUpdates(db);
  const app = await buildTestApp({ db });
  await app.register(runtimeStatePlugin);
  await app.ready(); // fires the onReady reconcile
  await app.close();
  return { updates };
}

/** Key docker CLI calls by their args — order-independent, unlike mock chains. */
function mockDocker(byArgs: {
  state: Array<string | Error>;
  label?: string;
  ps?: string;
  /** Raw `{{.State.OOMKilled}}|{{.State.ExitCode}}` inspect reply. */
  oom?: string;
}) {
  let stateCalls = 0;
  execMocks.capture.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes('{{.State.Status}}')) {
      const next = byArgs.state[stateCalls++] ?? 'running';
      if (next instanceof Error) throw next;
      return next;
    }
    if (args.includes('{{.State.OOMKilled}}|{{.State.ExitCode}}')) return byArgs.oom ?? 'false|0';
    if (args.includes('com.docker.compose.project" }}')) return byArgs.label ?? '';
    if (args.includes('ps')) return byArgs.ps ?? '';
    if (args[0] === 'start') return '';
    return 'running';
  });
}

describe('runtime state reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves a running container alone', async () => {
    mockDocker({ state: ['running'] });
    const { updates } = await reconcileOnce(svcRow({ id: 1, status: 'running', runtimeId: 'c1' }));
    expect(execMocks.capture).toHaveBeenCalledWith('docker', [
      'inspect',
      '--format',
      '{{.State.Status}}',
      'c1',
    ]);
    expect(execMocks.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['start']));
    expect(updates).toEqual([]);
  });

  it('revives a stopped container and keeps the service running', async () => {
    mockDocker({ state: ['exited', 'running'] });
    const { updates } = await reconcileOnce(svcRow({ id: 1, status: 'running', runtimeId: 'c1' }));
    expect(execMocks.capture).toHaveBeenCalledWith('docker', ['start', 'c1']);
    expect(updates).toEqual([]);
    // A clean exit is nobody's business — no OOM alert.
    expect(auditMocks.audit).not.toHaveBeenCalled();
  });

  it('revives a stopped replica while the primary stays healthy', async () => {
    // Main container is running (first Status inspect); replica r2 is exited
    // (second Status inspect) — the reconcile must start it.
    mockDocker({ state: ['running', 'exited'] });
    const { updates } = await reconcileOnce(svcRow({ id: 31, status: 'running', runtimeId: 'web-7', replicas: 3 }));
    expect(execMocks.capture).toHaveBeenCalledWith('docker', ['start', 'web-7-r2']);
    // r3 was reported running by the default mock — never started.
    expect(execMocks.capture).not.toHaveBeenCalledWith('docker', ['start', 'web-7-r3']);
    expect(updates).toEqual([]);
  });

  it('leaves single-replica services without replica inspections', async () => {
    mockDocker({ state: ['running'] });
    await reconcileOnce(svcRow({ id: 32, status: 'running', runtimeId: 'web-1' }));
    // Exactly one Status inspect (the primary); no replica names touched.
    const startCalls = execMocks.capture.mock.calls.filter(([, argv]) => argv[0] === 'start');
    expect(startCalls).toEqual([]);
  });

  it('alerts when the revived container was OOM-killed', async () => {
    mockDocker({ state: ['exited', 'running'], oom: 'true|137' });
    await reconcileOnce(svcRow({ id: 21, status: 'running', runtimeId: 'oom1', name: 'oom-svc' }));
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'alert.oom', 'oom-svc', expect.objectContaining({ runtimeId: 'oom1', exitCode: 137 }));
  });

  it('alerts on exit 137 even when the OOMKilled flag is false', async () => {
    mockDocker({ state: ['exited', 'running'], oom: 'false|137' });
    await reconcileOnce(svcRow({ id: 22, status: 'running', runtimeId: 'oom2', name: 'sigkill-svc' }));
    expect(auditMocks.audit).toHaveBeenCalledWith(expect.anything(), null, 'alert.oom', 'sigkill-svc', expect.objectContaining({ exitCode: 137 }));
  });

  it('patrols fan-out targets: revives a stopped clone on its node', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _sid: number, op: string) => {
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['exited'] };
      return { exitCode: 0, lines: [] };
    });
    const { updates } = await reconcileOnce(
      svcRow({ id: 41, status: 'running', runtimeId: 'web-7', replicas: 1 }),
      {
        select: { serviceTargets: [{ id: 3, serviceId: 41, serverId: 5, runtimeId: 'web-t5-9', status: 'error' }] },
        update: { serviceTargets: [{ id: 3, status: 'running' }] },
      },
    );
    expect(agentMocks.agentOp).toHaveBeenCalledWith(
      expect.anything(), 5, 'docker.start', { name: 'web-t5-9' }, expect.any(Function),
    );
    // The service row itself is untouched — only the target row's status
    // flipped to running (the tracker records table-agnostically).
    expect(updates.filter((u) => u.status === 'error' || u.status === 'stopped')).toEqual([]);
  });

  it('skips a downed agent without judging the service', async () => {
    agentMocks.agentOp.mockRejectedValue(new Error('node unreachable'));
    const { updates } = await reconcileOnce(
      svcRow({ id: 42, status: 'running', runtimeId: 'web-7' }),
      {
        select: { serviceTargets: [{ id: 4, serviceId: 42, serverId: 6, runtimeId: 'web-t6-9', status: 'running' }] },
      },
    );
    expect(updates).toEqual([]);
  });

  it('throttles repeated OOM alerts for the same service', async () => {
    mockDocker({ state: ['exited', 'running'], oom: 'true|137' });
    // Two passes for the same service: the in-memory cooldown (module-level,
    // shared across app instances) must swallow the second alert.
    await reconcileOnce(svcRow({ id: 23, status: 'running', runtimeId: 'oom3', name: 'loopy' }));
    await reconcileOnce(svcRow({ id: 23, status: 'running', runtimeId: 'oom3', name: 'loopy' }));
    expect(auditMocks.audit).toHaveBeenCalledTimes(1);
  });

  it('starts compose project siblings alongside the main container', async () => {
    mockDocker({ state: ['exited', 'running'], label: 'ndcmp-web', ps: 'id1\nid2\n' });
    await reconcileOnce(svcRow({ id: 1, status: 'running', runtimeId: 'c1', type: 'compose' }));
    expect(execMocks.capture).toHaveBeenCalledWith('docker', ['start', 'c1']);
    expect(execMocks.capture).toHaveBeenCalledWith('docker', ['start', 'id1', 'id2']);
  });

  it('marks the service errored when revival fails', async () => {
    mockDocker({
      state: ['exited', new Error('`docker inspect` exited 1: driver failure')],
    });
    const { updates } = await reconcileOnce(svcRow({ id: 1, status: 'running', runtimeId: 'c1' }));
    expect(updates).toContainEqual({ status: 'error' });
  });

  it('marks the service errored without a start attempt when the container is gone', async () => {
    mockDocker({
      state: [new Error('`docker inspect` exited 1: Error response from daemon: No such container: c1')],
    });
    const { updates } = await reconcileOnce(svcRow({ id: 1, status: 'running', runtimeId: 'c1' }));
    expect(execMocks.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['start']));
    expect(updates).toContainEqual({ status: 'error' });
  });

  it('skips the round without judging when the docker daemon is unreachable', async () => {
    mockDocker({
      state: [new Error('`docker inspect` exited 1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock')],
    });
    const { updates } = await reconcileOnce(svcRow({ id: 1, status: 'running', runtimeId: 'c1' }));
    expect(updates).toEqual([]);
  });

  it('resurrects the PM2 dump once when a process is gone, then revives it', async () => {
    // gone → resurrect → back online
    pm2Mocks.describe
      .mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) => cb(null, []))
      .mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
        cb(null, [{ name: 'api-1', pm2_env: { status: 'online' } }]),
      );
    const { updates } = await reconcileOnce(
      svcRow({ id: 1, status: 'running', runtimeId: 'api-1', type: 'pm2' }),
    );
    expect(pm2Mocks.resurrect).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
  });

  it('revives a stopped PM2 process via restart', async () => {
    pm2Mocks.describe
      .mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
        cb(null, [{ name: 'api-1', pm2_env: { status: 'stopped' } }]),
      )
      .mockImplementationOnce((_n: string, cb: (err: Error | null, desc?: unknown[]) => void) =>
        cb(null, [{ name: 'api-1', pm2_env: { status: 'online' } }]),
      );
    const { updates } = await reconcileOnce(
      svcRow({ id: 1, status: 'running', runtimeId: 'api-1', type: 'pm2' }),
    );
    expect(pm2Mocks.restart).toHaveBeenCalledWith('api-1', expect.any(Function));
    expect(updates).toEqual([]);
  });

  it('marks a PM2 service errored when it stays gone after resurrect', async () => {
    const { updates } = await reconcileOnce(
      svcRow({ id: 1, status: 'running', runtimeId: 'api-1', type: 'pm2' }),
    );
    expect(pm2Mocks.resurrect).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual({ status: 'error' });
  });
});
