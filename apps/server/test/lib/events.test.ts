import { describe, expect, it, vi } from 'vitest';
import { eventBus } from '../../src/lib/events.js';

describe('eventBus', () => {
  it('publishes events to subscribers with strictly increasing ids', () => {
    const seen: Array<{ id: number; action: string }> = [];
    const unsub = eventBus.subscribe((e) => seen.push(e));

    eventBus.publish('service.created', 'web');
    eventBus.publish('deploy.started');

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ action: 'service.created', entity: 'web' });
    expect(seen[1]).toMatchObject({ action: 'deploy.started', entity: null });
    // Timestamp-based ids: strictly increasing (stable across restarts).
    expect(seen[1]!.id).toBeGreaterThan(seen[0]!.id);
    expect(seen[0]!.id).toBeGreaterThan(Date.now() - 60_000);
    unsub();
  });

  it('unsubscribe stops delivery', () => {
    const cb = vi.fn();
    const unsub = eventBus.subscribe(cb);
    eventBus.publish('a.b');
    unsub();
    eventBus.publish('c.d');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('backlog returns the recent events and trims to 100', () => {
    for (let i = 0; i < 150; i++) eventBus.publish('bulk.event');
    const backlog = eventBus.backlog();
    expect(backlog).toHaveLength(100);
    // Oldest retained event has the highest id after trimming.
    expect(backlog[0]!.id).toBe(backlog[99]!.id - 99);
    expect(backlog[99]!.id).toBe(backlog[0]!.id + 99);
  });

  it('publish with an explicit null entity keeps entity null', () => {
    const cb = vi.fn();
    const unsub = eventBus.subscribe(cb);
    eventBus.publish('x.y', null);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ entity: null }));
    unsub();
  });
});
