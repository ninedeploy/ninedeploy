import { describe, expect, it, vi } from 'vitest';
import { HookPipeline } from '../../src/kernel/hookPipeline.js';
import type { KernelContext } from '../../src/kernel/types.js';

describe('HookPipeline', () => {
  const mockContext = {} as KernelContext;

  it('runs tapped hook handlers in priority order and transforms payload', async () => {
    const pipeline = new HookPipeline(() => mockContext);
    const trace: string[] = [];

    const unsub1 = pipeline.tap('deploy:before', async (payload) => {
      trace.push('low-priority');
      return { ...payload, targetCommit: 'low' };
    }, { priority: 10 });

    const unsub2 = pipeline.tap('deploy:before', async (payload) => {
      trace.push('high-priority');
      return { ...payload, targetCommit: 'high' };
    }, { priority: 200 });

    expect(pipeline.hasListeners('deploy:before')).toBe(true);
    expect(pipeline.hasListeners('deploy:after')).toBe(false);

    const initial = { service: { id: 1, name: 'api' } as any };
    const result = await pipeline.call('deploy:before', initial);

    expect(trace).toEqual(['high-priority', 'low-priority']);
    expect(result.targetCommit).toBe('low');

    // Unsub 1 while 2 is still there
    unsub1();
    // Unsub 1 again (when index is -1)
    unsub1();
    expect(pipeline.hasListeners('deploy:before')).toBe(true);

    // Unsub 2 so hook is fully deleted
    unsub2();
    expect(pipeline.hasListeners('deploy:before')).toBe(false);
  });

  it('returns initial payload unchanged if no handlers are registered or if handler returns void', async () => {
    const pipeline = new HookPipeline(() => mockContext);
    const initial = { database: { id: 1 } as any, allowOrAbort: true };
    const res = await pipeline.call('database:before_delete', initial);
    expect(res).toBe(initial);

    // Handler returning undefined
    pipeline.tap('database:before_delete', async () => {
      // return void
    });
    const res2 = await pipeline.call('database:before_delete', initial);
    expect(res2).toBe(initial);
  });

  it('handles timeouts without crashing the pipeline', async () => {
    const pipeline = new HookPipeline(() => mockContext);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    pipeline.tap('deploy:after', async () => {
      await new Promise((r) => setTimeout(r, 50));
    }, { timeoutMs: 10, id: 'slow-handler' });

    // Handler without id timing out
    pipeline.tap('deploy:after', async () => {
      await new Promise((r) => setTimeout(r, 50));
    }, { timeoutMs: 10 });

    const initial = { service: { id: 1 } as any, deployId: 99, success: true };
    const result = await pipeline.call('deploy:after', initial);

    expect(result).toEqual(initial);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('handles handler throwing errors without crashing the caller', async () => {
    const pipeline = new HookPipeline(() => mockContext);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    pipeline.tap('deploy:after', async () => {
      throw new Error('Boom');
    });

    const initial = { service: { id: 1 } as any, deployId: 99, success: true };
    const result = await pipeline.call('deploy:after', initial);

    expect(result).toEqual(initial);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('allows unregistering handlers and clearing all hooks', () => {
    const pipeline = new HookPipeline(() => mockContext);
    const unsub = pipeline.tap('deploy:before', async () => {});

    expect(pipeline.hasListeners('deploy:before')).toBe(true);
    unsub();
    expect(pipeline.hasListeners('deploy:before')).toBe(false);

    const unsubAfterClear = pipeline.tap('deploy:before', async () => {});
    pipeline.clear();
    unsubAfterClear();

    expect(pipeline.hasListeners('deploy:before')).toBe(false);
    expect(pipeline.hasListeners('deploy:after')).toBe(false);
  });

  it('r237: a second failing handler does not roll the same entries back again', async () => {
    const pipeline = new HookPipeline(() => mockContext);
    const rollback = vi.fn();
    const later = vi.fn(async () => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pipeline.tap('deploy:before', async () => undefined, { priority: 300, rollback });
    pipeline.tap('deploy:before', async () => { throw new Error('first'); }, { priority: 200 });
    pipeline.tap('deploy:before', async () => { throw new Error('second'); }, { priority: 100 });
    pipeline.tap('deploy:before', later, { priority: 50 });
    await pipeline.call('deploy:before', { service: { id: 1 } as any });
    expect(rollback).toHaveBeenCalledTimes(1);
    // The chain continues past broken handlers.
    expect(later).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('F384: a handler unsubscribed or cleared while the call is in flight is not invoked by it', async () => {
    for (const mode of ['unsubscribe', 'clear'] as const) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const pipeline = new HookPipeline(() => mockContext);
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let entered!: () => void;
        const enteredP = new Promise<void>((r) => { entered = r; });
        pipeline.tap('deploy:before', async () => {
          entered();
          await gate;
          return undefined;
        }, { priority: 200 });
        // Models a stopped sandbox plugin: it never answers.
        const stale = vi.fn(() => new Promise<undefined>(() => undefined));
        const unsubStale = pipeline.tap('deploy:before', stale, { priority: 100 });
        let settled = false;
        const p = pipeline.call('deploy:before', { service: { id: 1 } as any }).then(() => { settled = true; });
        await enteredP;
        if (mode === 'unsubscribe') unsubStale();
        else pipeline.clear();
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(stale, mode).not.toHaveBeenCalled();
        expect(settled, mode).toBe(true);
        await p;
      } finally {
        errSpy.mockRestore();
        vi.useRealTimers();
      }
    }
  });

  it('F385: a non-numeric priority does not reorder the other handlers', async () => {
    for (const bad of ['high', Number.NaN]) {
      const pipeline = new HookPipeline(() => mockContext);
      const trace: string[] = [];
      pipeline.tap('deploy:after', async () => { trace.push('low'); return undefined; }, { priority: 10 });
      pipeline.tap('deploy:after', async () => { trace.push('bad'); return undefined; }, { priority: bad as number });
      pipeline.tap('deploy:after', async () => { trace.push('high'); return undefined; }, { priority: 200 });
      await pipeline.call('deploy:after', { service: { id: 1 } as any, deployId: 1, success: true });
      expect(trace).toEqual(['high', 'bad', 'low']);
    }
  });
});
