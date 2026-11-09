import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  getPanelBackupConfig: vi.fn(), runPanelBackup: vi.fn(async () => ({ status: 'completed' })),
  clearPanelBackupScratch: vi.fn(), setPanelBackupScheduleListener: vi.fn(),
  ticks: [] as Array<() => void>, stops: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock('../../apps/server/src/lib/panelBackup.js', () => mock);
vi.mock('croner', () => ({ Cron: class {
  stop = vi.fn();
  constructor(_expr: string, _options: unknown, tick: () => void) { mock.ticks.push(tick); mock.stops.push(this.stop); }
} }));
const plugin = (await import('../../apps/server/src/plugins/panelBackupScheduler.js')).default;
const cfg = { enabled: true, cron: '0 3 * * *', destinationId: 1, retain: 7 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// A Node event-loop checkpoint drains the released read's promise continuations;
// the deferreds, not a timer or a wall-clock deadline, determine completion order.
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
async function boot() {
  const app = Fastify({ logger: false });
  app.decorate('db', {} as never);
  await app.register(plugin);
  await app.ready();
  return app;
}
beforeEach(() => {
  vi.clearAllMocks(); mock.ticks.length = 0; mock.stops.length = 0;
  mock.getPanelBackupConfig.mockReset().mockResolvedValue(cfg);
});

for (const closeBeforeRelease of [false, true]) {
  it(`${closeBeforeRelease ? 'closed' : 'live control'} owner after a gated settings read`, async () => {
    const app = await boot();
    const entered = deferred<void>(); const read = deferred<typeof cfg>();
    mock.getPanelBackupConfig.mockImplementationOnce(() => { entered.resolve(); return read.promise; });
    try {
      mock.ticks[0]!();
      await entered.promise;
      if (closeBeforeRelease) await app.close();
      read.resolve(cfg);
      await checkpoint();
      console.log('EXPECTED:', closeBeforeRelease ? 0 : 1, 'ACTUAL:', mock.runPanelBackup.mock.calls.length); if (closeBeforeRelease) console.log(mock.runPanelBackup.mock.calls.length ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED'); expect(mock.runPanelBackup).toHaveBeenCalledTimes(closeBeforeRelease ? 0 : 1);
      if (closeBeforeRelease) expect(mock.stops[0]).toHaveBeenCalledOnce();
    } finally { read.resolve(cfg); await app.close(); }
  });
}

it('a failed settings read released after close starts no backup', async () => {
  const app = await boot(); const read = deferred<typeof cfg>();
  mock.getPanelBackupConfig.mockReturnValueOnce(read.promise);
  mock.ticks[0]!();
  await app.close();
  read.reject(new Error('closed database'));
  await checkpoint();
  expect(mock.runPanelBackup).not.toHaveBeenCalled();
});
