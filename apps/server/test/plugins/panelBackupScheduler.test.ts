import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const libMock = vi.hoisted(() => {
  const state = {
    cfg: { enabled: false, cron: '0 3 * * *', destinationId: null as number | null, retain: 7 },
    listener: null as (() => void) | null,
  };
  return {
    state,
    getPanelBackupConfig: vi.fn(async () => ({ ...state.cfg })),
    runPanelBackup: vi.fn(async () => ({ status: 'completed' })),
    clearPanelBackupScratch: vi.fn(),
    setPanelBackupScheduleListener: vi.fn((fn: (() => void) | null) => {
      state.listener = fn;
    }),
  };
});
vi.mock('../../src/lib/panelBackup.js', () => libMock);

const CronMock = vi.hoisted(() => {
  // croner stand-in: records each armed job; tests fire `fn` by hand.
  const instances: Array<{ expr: string; fn: () => void; stop: ReturnType<typeof vi.fn> }> = [];
  const Ctor = vi.fn(function (this: Record<string, unknown>, expr: string, _opts: unknown, fn: () => void) {
    this.expr = expr;
    this.fn = fn;
    this.stop = vi.fn();
    instances.push(this as never);
  });
  return { Cron: Ctor, instances };
});
vi.mock('croner', () => ({ Cron: CronMock.Cron }));

const plugin = (await import('../../src/plugins/panelBackupScheduler.js')).default;

async function boot() {
  const app = Fastify({ logger: false });
  app.decorate('db', {} as never);
  await app.register(plugin);
  await app.ready();
  return app;
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('panel backup scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CronMock.instances.length = 0;
    libMock.state.cfg = { enabled: false, cron: '0 3 * * *', destinationId: null, retain: 7 };
    libMock.state.listener = null;
  });

  it('upgrade default: no settings row (disabled) arms nothing, but clears crashed-run scratch', async () => {
    const app = await boot();
    expect(CronMock.Cron).not.toHaveBeenCalled();
    expect(libMock.clearPanelBackupScratch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('arms the configured cron and runs a scheduled backup on each tick', async () => {
    libMock.state.cfg = { enabled: true, cron: '15 2 * * *', destinationId: 4, retain: 7 };
    const app = await boot();
    expect(CronMock.Cron).toHaveBeenCalledWith('15 2 * * *', expect.objectContaining({ mode: '5-part' }), expect.any(Function));
    CronMock.instances[0]!.fn();
    await settle();
    expect(libMock.runPanelBackup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: 'schedule', actorUserId: null }));
    await app.close();
  });

  it('a tick after the operator disabled it does not run', async () => {
    libMock.state.cfg = { enabled: true, cron: '15 2 * * *', destinationId: 4, retain: 7 };
    const app = await boot();
    libMock.state.cfg = { ...libMock.state.cfg, enabled: false };
    CronMock.instances[0]!.fn();
    await settle();
    expect(libMock.runPanelBackup).not.toHaveBeenCalled();
    await app.close();
  });

  it('a settings change re-arms at once; disabling stops the job; close clears the listener', async () => {
    const app = await boot();
    expect(libMock.state.listener).toBeTypeOf('function');
    libMock.state.cfg = { enabled: true, cron: '0 4 * * *', destinationId: 1, retain: 3 };
    libMock.state.listener!();
    await settle();
    expect(CronMock.instances.map((c) => c.expr)).toEqual(['0 4 * * *']);
    libMock.state.cfg = { ...libMock.state.cfg, cron: '30 4 * * *' };
    libMock.state.listener!();
    await settle();
    expect(CronMock.instances[0]!.stop).toHaveBeenCalled();
    expect(CronMock.instances.map((c) => c.expr)).toEqual(['0 4 * * *', '30 4 * * *']);
    // Same settings again: no churn.
    libMock.state.listener!();
    await settle();
    expect(CronMock.instances).toHaveLength(2);
    libMock.state.cfg = { ...libMock.state.cfg, enabled: false };
    libMock.state.listener!();
    await settle();
    expect(CronMock.instances[1]!.stop).toHaveBeenCalled();
    await app.close();
    expect(libMock.setPanelBackupScheduleListener).toHaveBeenLastCalledWith(null);
  });
});
