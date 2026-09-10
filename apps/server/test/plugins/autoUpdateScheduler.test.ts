import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import autoUpdateSchedulerPlugin from '../../src/plugins/autoUpdateScheduler.js';
import { createFakeDb, svcRow } from '../helpers.js';

/**
 * The auto-update sweep plugin: a 5-minute reload loop around
 * `sweepAutoUpdates`. Fake timers fire the delayed first tick and the
 * interval without waiting wall-clock time; the sweep itself is stubbed so
 * this file only asserts the PLUGIN wiring (tick runs, failures are
 * swallowed, close stops the loop).
 */

vi.mock('../../src/lib/autoUpdate.js', () => ({
  sweepAutoUpdates: vi.fn(),
}));
import { sweepAutoUpdates } from '../../src/lib/autoUpdate.js';

function makeFastify() {
  const calls = { info: [] as string[], warn: [] as string[] };
  const hooks: Array<() => Promise<void>> = [];
  const app = {
    db: createFakeDb({ findMany: { services: [svcRow({ id: 1, type: 'docker', image: 'nginx:latest', status: 'running', autoUpdate: true })] } }),
    log: {
      info: (obj: unknown, msg?: string) => calls.info.push(msg ?? String(obj)),
      warn: (obj: unknown, msg?: string) => calls.warn.push(msg ?? String(obj)),
    },
    addHook: (_event: string, fn: () => Promise<void>) => {
      hooks.push(fn);
    },
  };
  return { app: app as never, hooks, calls };
}

describe('autoUpdateScheduler plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(sweepAutoUpdates).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the first sweep shortly after boot and logs enqueued re-deploys', async () => {
    vi.mocked(sweepAutoUpdates).mockResolvedValue({ probed: 2, enqueued: 1, skipped: 0 });
    const { app, calls } = makeFastify();
    const registered = autoUpdateSchedulerPlugin(app, {} as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await registered;
    expect(sweepAutoUpdates).toHaveBeenCalledTimes(1);
    expect(calls.info.some((m) => m.includes('enqueued'))).toBe(true);
  });

  it('keeps the panel alive when the sweep throws', async () => {
    vi.mocked(sweepAutoUpdates).mockRejectedValue(new Error('boom'));
    const { app, calls } = makeFastify();
    const registered = autoUpdateSchedulerPlugin(app, {} as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await registered;
    expect(calls.warn.some((m) => m.includes('sweep failed'))).toBe(true);
  });

  it('stops the loop on close', async () => {
    vi.mocked(sweepAutoUpdates).mockResolvedValue({ probed: 0, enqueued: 0, skipped: 0 });
    const { app, hooks } = makeFastify();
    const registered = autoUpdateSchedulerPlugin(app, {} as never);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await registered;
    expect(hooks).toHaveLength(1);
    await hooks[0]!();
    const callsAfterClose = vi.mocked(sweepAutoUpdates).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(vi.mocked(sweepAutoUpdates).mock.calls.length).toBe(callsAfterClose);
  });
});
