import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({
  shipLogsOnce: vi.fn(async (_db: unknown, _cursors: unknown) => ({ failed: 0 })),
}));
vi.mock('../../src/engine/logShipper.js', () => ({ shipLogsOnce: engineMocks.shipLogsOnce }));

import logShipper from '../../src/plugins/logShipper.js';

/**
 * r231/r462: the plugin's tick and onClose arms only ever run from a timer —
 * they were the largest uncovered function gap in the suite (the engine half
 * is covered by test/engine/logShipper.test.ts).
 */
describe('log shipper plugin lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineMocks.shipLogsOnce.mockResolvedValue({ failed: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ships on the interval and stops scheduling after onClose', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = Fastify();
    app.decorate('db', {} as never);
    await app.register(logShipper);
    await app.ready();

    expect(engineMocks.shipLogsOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(engineMocks.shipLogsOnce).toHaveBeenCalledTimes(1);

    await app.close();
    await vi.advanceTimersByTimeAsync(30_000);
    // running=false: no further ticks are scheduled.
    expect(engineMocks.shipLogsOnce).toHaveBeenCalledTimes(1);
  });

  it('warns on partial failures and keeps the loop alive', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = Fastify();
    app.decorate('db', {} as never);
    const warn = vi.spyOn(app.log, 'warn').mockImplementation(() => {});
    await app.register(logShipper);
    await app.ready();

    engineMocks.shipLogsOnce.mockResolvedValueOnce({ failed: 3 });
    await vi.advanceTimersByTimeAsync(10_100);
    expect(warn.mock.calls.some((c) => String(c[1] ?? c[0]).includes('log drain delivery failed'))).toBe(true);
    // The finally arm rescheduled the next tick.
    engineMocks.shipLogsOnce.mockClear();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(engineMocks.shipLogsOnce).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('logs and survives a throwing shipLogsOnce (the catch arm)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = Fastify();
    app.decorate('db', {} as never);
    const error = vi.spyOn(app.log, 'error').mockImplementation(() => {});
    await app.register(logShipper);
    await app.ready();

    engineMocks.shipLogsOnce.mockRejectedValueOnce(new Error('drain down'));
    await vi.advanceTimersByTimeAsync(10_100);
    expect(error.mock.calls.some((c) => String(c[1] ?? c[0]).includes('log shipper failed'))).toBe(true);
    await app.close();
  });
});
