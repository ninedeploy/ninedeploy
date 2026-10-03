import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StickySessionPlugin } from '../../src/kernel/plugins/stickySession.js';
import { createFakeDb } from '../helpers.js';

let lastKey = '';
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => {
      if (col && (col as { name?: string }).name === 'key') lastKey = String(value);
      return actual.eq(col, value);
    },
  };
});

function settingsDb(over: Record<string, unknown> = {}) {
  return createFakeDb({
    findFirst: {
      settings: () => (lastKey in over ? { key: lastKey, value: over[lastKey] } : undefined),
    },
  });
}

interface FakeKernel {
  events: {
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    emitCustom: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    onCustom: ReturnType<typeof vi.fn>;
    listenerCount: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
  };
  configCenter: { get: ReturnType<typeof vi.fn> };
  registry: { getDomainProvider: ReturnType<typeof vi.fn> };
  hooks: { tap: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn>; hasListeners: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
  menuRegistry: { registerMenuItem: ReturnType<typeof vi.fn>; unregisterMenuItem: ReturnType<typeof vi.fn>; getItemsForSlot: ReturnType<typeof vi.fn>; getAllItems: ReturnType<typeof vi.fn>; getPluginMenus: ReturnType<typeof vi.fn>; purgePluginMenus: ReturnType<typeof vi.fn> };
  db: unknown;
  state: string;
  config: unknown;
}

function newKernel(): FakeKernel {
  return {
    events: {
      on: vi.fn().mockReturnValue(() => {}),
      emit: vi.fn(),
      emitCustom: vi.fn(),
      once: vi.fn().mockReturnValue(() => {}),
      onCustom: vi.fn().mockReturnValue(() => {}),
      listenerCount: vi.fn().mockReturnValue(0),
      removeAllListeners: vi.fn(),
    },
    configCenter: { get: vi.fn() },
    registry: { getDomainProvider: vi.fn() },
    hooks: { tap: vi.fn(), call: vi.fn(), hasListeners: vi.fn().mockReturnValue(false), clear: vi.fn() },
    menuRegistry: { registerMenuItem: vi.fn(), unregisterMenuItem: vi.fn(), getItemsForSlot: vi.fn().mockReturnValue([]), getAllItems: vi.fn().mockReturnValue([]), getPluginMenus: vi.fn().mockReturnValue([]), purgePluginMenos: vi.fn(), purgePluginMenus: vi.fn().mockReturnValue(0) },
    db: createFakeDb(),
    state: 'READY',
    config: {},
  } as unknown as FakeKernel;
}

let savedKey: string;
beforeEach(() => { savedKey = lastKey; lastKey = ''; });
afterEach(() => { lastKey = savedKey; });

describe('StickySessionPlugin', () => {
  it('exposes a stable id, version, and isOfficial flag', () => {
    const p = new StickySessionPlugin();
    expect(p.id).toBe('sticky-session');
    expect(p.isOfficial).toBe(true);
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('registers one command-palette menu item pointing at the services settings page', () => {
    const p = new StickySessionPlugin();
    const item = p.menuItems?.[0];
    expect(item?.slot).toBe('command:palette');
    expect(item?.route).toBe('/settings/services');
    expect(item?.permission).toBe('admin');
  });

  it('init subscribes exactly once to service.deployed; destroy releases it', () => {
    const kernel = newKernel();
    const p = new StickySessionPlugin();
    p.init(kernel as never);
    expect(kernel.events.on).toHaveBeenCalledTimes(1);
    expect(kernel.events.on.mock.calls[0]?.[0]).toBe('service.deployed');
    p.destroy();
  });

  it('emits proxy.sticky_session.activated when the flag is "true"', async () => {
    const db = settingsDb({ 'sticky_session:42:enabled': 'true' });
    const kernel = { ...newKernel(), db } as unknown as FakeKernel;
    const p = new StickySessionPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ serviceId: 42 });
    // The plugin is fire-and-forget; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).toHaveBeenCalledWith(
      'proxy.sticky_session.activated',
      expect.objectContaining({ serviceId: 42, cookieName: 'ninedeploy_sticky', maxAge: 86400 }),
    );
  });

  it('does not emit when the flag is off (or missing)', async () => {
    const db = settingsDb({}); // no entry
    const kernel = { ...newKernel(), db } as unknown as FakeKernel;
    const p = new StickySessionPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({ serviceId: 42 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).not.toHaveBeenCalled();
  });

  it('does not throw when the payload omits serviceId', async () => {
    const kernel = newKernel();
    const p = new StickySessionPlugin();
    p.init(kernel as never);
    const handler = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    handler({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kernel.events.emitCustom).not.toHaveBeenCalled();
  });
});
