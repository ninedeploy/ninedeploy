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
async function reconcileOnce(row: Record<string, unknown> | null) {
  const db = createFakeDb(
    row ? { findMany: { services: [row] } } : { findMany: { services: [] } },
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
