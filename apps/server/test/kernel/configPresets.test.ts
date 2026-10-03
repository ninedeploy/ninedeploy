import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigPresetsPlugin } from '../../src/kernel/plugins/configPresets.js';
import { createFakeDb } from '../helpers.js';

interface FakeKernel {
  events: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn>; emitCustom: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn>; onCustom: ReturnType<typeof vi.fn>; listenerCount: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn> };
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
    menuRegistry: { registerMenuItem: vi.fn(), unregisterMenuItem: vi.fn(), getItemsForSlot: vi.fn().mockReturnValue([]), getAllItems: vi.fn().mockReturnValue([]), getPluginMenus: vi.fn().mockReturnValue([]), purgePluginMenus: vi.fn().mockReturnValue(0) },
    db: createFakeDb(),
    state: 'READY',
    config: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConfigPresetsPlugin', () => {
  it('exposes a stable id, version, and isOfficial flag', () => {
    const p = new ConfigPresetsPlugin();
    expect(p.id).toBe('config-presets');
    expect(p.isOfficial).toBe(true);
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('registers three config-center entries and a command-palette menu item', () => {
    const p = new ConfigPresetsPlugin();
    const schemaKeys = p.configSchema?.map((s) => s.key) ?? [];
    expect(schemaKeys).toContain('enabled');
    expect(schemaKeys).toContain('preset.list');
    expect(schemaKeys).toContain('preset.namespace');
    const menu = p.menuItems?.[0];
    expect(menu?.slot).toBe('command:palette');
    // The plugin owns the `preset.list` / `preset.<id>.values` rows in
    // the Config Center section, so the palette entry lands on that
    // section. There is no /settings/presets page.
    expect(menu?.route).toBe('/settings?section=config');
  });

  it('init is a no-op (passive plugin) and destroy releases nothing', () => {
    const kernel = newKernel();
    const p = new ConfigPresetsPlugin();
    p.init(kernel as never);
    expect(kernel.events.on).not.toHaveBeenCalled();
    expect(() => p.destroy()).not.toThrow();
  });
});
