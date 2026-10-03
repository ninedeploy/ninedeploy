import { describe, expect, it } from 'vitest';
import { createKeyedOperationGuard } from '../../src/lib/keyedOperationGuard.js';

describe('keyed operation guard', () => {
  it('queues the same key, allows other keys, and releases a failed operation', async () => {
    const guard = createKeyedOperationGuard<number>();
    const events: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = guard(1, async () => {
      events.push('first');
      await pending;
      throw new Error('operation failed');
    });
    const firstResult = expect(first).rejects.toThrow('operation failed');
    const second = guard(1, async () => { events.push('second'); });
    await guard(2, async () => { events.push('independent'); });
    expect(events).toEqual(['first', 'independent']);
    release();
    await firstResult;
    await second;
    expect(events).toEqual(['first', 'independent', 'second']);
    await guard(1, async () => { events.push('third'); });
    expect(events.at(-1)).toBe('third');
  });
});
