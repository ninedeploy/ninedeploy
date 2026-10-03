import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/eventBus.js';

describe('EventBus', () => {
  it('subscribes and emits typed domain events', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const handler2 = vi.fn();

    const unsub = bus.on('service.created', handler);
    const unsub2 = bus.on('service.created', handler2);
    bus.emit('service.created', { serviceId: 1, projectId: 2, name: 'web-api' });

    expect(handler).toHaveBeenCalledWith({ serviceId: 1, projectId: 2, name: 'web-api' });
    expect(handler2).toHaveBeenCalledWith({ serviceId: 1, projectId: 2, name: 'web-api' });
    expect(bus.listenerCount('service.created')).toBe(2);

    // Unsub first listener while second is still active
    unsub();
    expect(bus.listenerCount('service.created')).toBe(1);

    // Unsub second listener so count becomes 0 and deletes set
    unsub2();
    expect(bus.listenerCount('service.created')).toBe(0);

    bus.emit('service.created', { serviceId: 1, projectId: 2, name: 'web-api' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handles once subscriptions', async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.once('service.stopped', handler);
    bus.emit('service.stopped', { serviceId: 42 });
    bus.emit('service.stopped', { serviceId: 42 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ serviceId: 42 });
  });

  it('isolates synchronous and asynchronous listener errors in error boundaries', async () => {
    const bus = new EventBus();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Sync throw
    bus.onCustom('custom.sync', () => {
      throw new Error('Sync explosion');
    });

    // Async reject
    bus.onCustom('custom.async', async () => {
      throw new Error('Async explosion');
    });

    // Valid listener
    const valid = vi.fn();
    bus.onCustom('custom.sync', valid);
    bus.onCustom('custom.async', valid);

    bus.emitCustom('custom.sync', { hello: 'world' });
    bus.emitCustom('custom.async', { hello: 'world' });

    await new Promise((r) => setTimeout(r, 10));

    expect(valid).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('handles wildcard listener execution and error boundaries', async () => {
    const bus = new EventBus();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Wildcard sync throw
    bus.onCustom('*', () => {
      throw new Error('Wildcard sync boom');
    });

    // Wildcard async reject
    bus.onCustom('*', async () => {
      throw new Error('Wildcard async boom');
    });

    const validWildcard = vi.fn();
    bus.onCustom('*', validWildcard);

    bus.emitCustom('custom.event', { data: 123 });
    // Emit '*' directly
    bus.emitCustom('*', { direct: true });

    await new Promise((r) => setTimeout(r, 10));

    expect(validWildcard).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('manages listeners cleanup and count', () => {
    const bus = new EventBus();
    expect(bus.listenerCount('unknown')).toBe(0);

    const u1 = bus.onCustom('ev1', () => {});
    const u2 = bus.onCustom('ev1', () => {});
    const u3 = bus.onCustom('ev2', () => {});

    expect(bus.listenerCount('ev1')).toBe(2);
    expect(bus.listenerCount('ev2')).toBe(1);

    bus.removeAllListeners('ev1');
    expect(bus.listenerCount('ev1')).toBe(0);
    expect(bus.listenerCount('ev2')).toBe(1);

    bus.removeAllListeners();
    expect(bus.listenerCount('ev2')).toBe(0);

    // Unsub after removal shouldn't crash
    u1();
    u2();
    u3();
  });
});
