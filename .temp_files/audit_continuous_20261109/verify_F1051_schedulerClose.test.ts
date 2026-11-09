import Fastify from 'fastify';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

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

for (const closeOwner of [false, true]) {
  for (const outcome of ['enabled', 'disabled', 'rejected'] as const) {
    it(`independent three overlapping ticks / closed=${closeOwner} / ${outcome}`, async () => {
      const app = await boot();
      const pending = [deferred<typeof cfg>(), deferred<typeof cfg>(), deferred<typeof cfg>()];
      for (const read of pending) { mock.getPanelBackupConfig.mockReturnValueOnce(read.promise); mock.ticks[0]!(); }
      try {
        expect(mock.getPanelBackupConfig).toHaveBeenCalledTimes(4);
        if (closeOwner) await app.close();
        for (const read of [...pending].reverse()) {
          if (outcome === 'rejected') read.reject(new Error('injected read failure'));
          else read.resolve({ ...cfg, enabled: outcome === 'enabled' });
        }
        await checkpoint();
        expect(mock.runPanelBackup).toHaveBeenCalledTimes(!closeOwner && outcome === 'enabled' ? 3 : 0);
        if (closeOwner) expect(mock.stops[0]).toHaveBeenCalledOnce();
      } finally { for (const read of pending) read.resolve(cfg); await app.close(); }
    });
  }
}
it('releasing a previous app tick after a new app boots starts only the new owner', async () => {
  const previous = await boot(); const read = deferred<typeof cfg>();
  mock.getPanelBackupConfig.mockReturnValueOnce(read.promise); mock.ticks[0]!();
  await previous.close();
  const current = await boot();
  try {
    mock.ticks[1]!(); read.resolve(cfg); await checkpoint();
    expect(mock.runPanelBackup).toHaveBeenCalledOnce();
    expect(mock.runPanelBackup.mock.calls[0]?.[0]).toBe(current.getDecorator('db'));
  } finally { read.resolve(cfg); await current.close(); }
});
afterAll(() => console.log('FIX VERIFIED'));
