import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
const recovery = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/engine/swarmRecovery.js', () => ({ reconcileSwarmTransitions: recovery.run }));
const { default: plugin } = await import('../../src/plugins/swarmRecovery.js');
afterEach(() => { vi.useRealTimers(); recovery.run.mockReset(); });

it('runs after boot, serializes cycles and aborts the active recovery before closing', async () => {
  vi.useFakeTimers();
  const app = Fastify(); app.decorate('db', {});
  let release!: () => void;
  recovery.run.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  await app.register(plugin); await app.ready();
  expect(recovery.run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); expect(recovery.run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(180_000); expect(recovery.run).toHaveBeenCalledTimes(1);
  const signal = recovery.run.mock.calls[0]![1].signal as AbortSignal;
  let closed = false; const closing = app.close().then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(signal.aborted).toBe(true); expect(closed).toBe(false);
  release(); await closing;
  await vi.advanceTimersByTimeAsync(120_000); expect(recovery.run).toHaveBeenCalledTimes(1);
});

it('continues the scheduled loop after a transient recovery error', async () => {
  vi.useFakeTimers();
  recovery.run.mockRejectedValueOnce(new Error('temporary SQLite failure')).mockResolvedValue({ recovered: 0, held: 0 });
  const app = Fastify(); app.decorate('db', {});
  await app.register(plugin); await app.ready();
  try {
    await vi.advanceTimersByTimeAsync(1000); expect(recovery.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(recovery.run).toHaveBeenCalledTimes(2);
  } finally { await app.close(); }
});
