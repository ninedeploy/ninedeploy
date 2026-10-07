import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { bridgeAuditEvents } from '../../src/kernel/auditBridge.js';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { TemplateBundlesPlugin } from '../../src/kernel/plugins/templateBundles.js';

/**
 * Tests for the Template Bundles observer plugin (Sprint 1, Gap G-04).
 *
 * The plugin's contract is intentionally narrow:
 *   - observes `audit.recorded` events whose action is `template.install`,
 *   - respects the `plugin:template-bundles:enabled` config toggle,
 *   - republishes matches as a typed `template.bundle.observed` custom event,
 *   - never throws into the audit bus (errors land on a sibling custom event).
 *
 * The tests below stand up a real `NineDeployKernel` with a mocked DB so the
 * event bus, config center, and plugin lifecycle all run end-to-end.
 */
describe('TemplateBundlesPlugin', () => {
  const makeDb = () => ({
    query: {
      configEntries: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      }),
    }),
  });

  const mockConfig = {
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-at-least-32-chars-long-12345',
    dataDir: '/tmp/ninedeploy-test',
  };

  /**
   * r034. `override_count` describes itself in the panel as "updated by the
   * observer when an override is matched" and nothing ever wrote it, so the
   * counter an operator reads was pinned at 0 however many templates they
   * installed.
   */
  it('increments override_count for each observed template install', async () => {
    const kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    const plugin = new TemplateBundlesPlugin();
    await kernel.registerPlugin(plugin);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    kernel.events.emitCustom('audit.recorded', { action: 'template.install', entity: 'template:ghost' });
    await settle();
    expect(await kernel.configCenter.get('plugin:template-bundles:override_count', 0)).toBe(1);

    kernel.events.emitCustom('audit.recorded', { action: 'template.install', entity: 'template:umami' });
    await settle();
    expect(await kernel.configCenter.get('plugin:template-bundles:override_count', 0)).toBe(2);

    // An unrelated audit action must not move the counter.
    kernel.events.emitCustom('audit.recorded', { action: 'service.start', entity: 'api #1' });
    await settle();
    expect(await kernel.configCenter.get('plugin:template-bundles:override_count', 0)).toBe(2);

    plugin.destroy();
  });

  it('registers the plugin with the expected id and version', () => {
    const plugin = new TemplateBundlesPlugin();
    expect(plugin.id).toBe('template-bundles');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.isOfficial).toBe(true);
  });

  it('declares its config schema and menu items at construction time', () => {
    const plugin = new TemplateBundlesPlugin();

    expect(plugin.configSchema).toBeDefined();
    const keys = plugin.configSchema!.map((d) => d.key);
    expect(keys).toContain('enabled');
    expect(keys).toContain('override_count');

    expect(plugin.menuItems).toBeDefined();
    const paletteItem = plugin.menuItems!.find((m) => m.slot === 'command:palette');
    expect(paletteItem).toBeDefined();
    expect(paletteItem?.label).toBe('Template Bundles');
  });

  it('republishes template.install audit events as template.bundle.observed', async () => {
    const kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    const plugin = new TemplateBundlesPlugin();
    await kernel.registerPlugin(plugin);

    const observed: unknown[] = [];
    const errors: unknown[] = [];
    kernel.events.onCustom('template.bundle.observed', (payload) => observed.push(payload));
    kernel.events.onCustom('template.bundle.observer_error', (payload) => errors.push(payload));

    kernel.events.emit('audit.recorded', {
      action: 'template.install',
      entity: 'template:n8n',
      actorUserId: 42,
      ts: '2026-08-28T12:00:00.000Z',
    });

    // The observer reads the config via a microtask; wait one tick.
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      action: 'template.install',
      entity: 'template:n8n',
      actorUserId: 42,
    });
  });

  it('ignores audit actions that are not template.install', async () => {
    const kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    const plugin = new TemplateBundlesPlugin();
    await kernel.registerPlugin(plugin);

    const observed: unknown[] = [];
    kernel.events.onCustom('template.bundle.observed', (payload) => observed.push(payload));

    kernel.events.emit('audit.recorded', {
      action: 'service.created',
      entity: 'service:1',
      actorUserId: 7,
      ts: '2026-08-28T12:00:00.000Z',
    });
    kernel.events.emit('audit.recorded', {
      action: 'plugin.install',
      entity: 'plugin:foo',
      actorUserId: 7,
      ts: '2026-08-28T12:00:00.000Z',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(observed).toEqual([]);
  });

  it('destroy() unsubscribes from the audit firehose', async () => {
    const kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    const plugin = new TemplateBundlesPlugin();
    await kernel.registerPlugin(plugin);

    const observed: unknown[] = [];
    kernel.events.onCustom('template.bundle.observed', (payload) => observed.push(payload));

    await plugin.destroy!(kernel as never);

    kernel.events.emit('audit.recorded', {
      action: 'template.install',
      entity: 'template:n8n',
      actorUserId: 1,
      ts: '2026-08-28T12:00:00.000Z',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(observed).toEqual([]);
  });

  it('surfaces config-center read failures as template.bundle.observer_error', async () => {
    // Build a DB whose configEntries.findFirst rejects. The plugin must not
    // throw into the audit bus; it must republish the error as a sibling
    // custom event so the operator can see it through the existing audit
    // observability path.
    const db = {
      query: {
        configEntries: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockRejectedValue(new Error('config db offline')),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        }),
      }),
    };

    const kernel = new NineDeployKernel(db as never, mockConfig);
    const plugin = new TemplateBundlesPlugin();
    await kernel.registerPlugin(plugin);

    const errors: unknown[] = [];
    const observed: unknown[] = [];
    kernel.events.onCustom('template.bundle.observer_error', (payload) => errors.push(payload));
    kernel.events.onCustom('template.bundle.observed', (payload) => observed.push(payload));

    kernel.events.emit('audit.recorded', {
      action: 'template.install',
      entity: 'template:n8n',
      actorUserId: 1,
      ts: '2026-08-28T12:00:00.000Z',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(observed).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'config db offline' });
  });

  /**
   * F337 (action half). The observer listened for `template.install`, which
   * nothing emits; the template deploy route audits `template.deploy`. Assert
   * the mount: read the action the route really audits and drive it through
   * the real audit bridge.
   */
  it('observes the audit action the template deploy route actually records', async () => {
    const routeSrc = readFileSync(new URL('../../src/modules/templates.ts', import.meta.url), 'utf8');
    const action = /audit\(\s*app\.db,\s*req\.user!\.id,\s*'(template\.[a-z_]+)',\s*`\$\{t\.name\} → /.exec(routeSrc)?.[1];
    expect(action).toBeDefined();

    const kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    const plugin = new TemplateBundlesPlugin();
    await kernel.registerPlugin(plugin);
    let publish: ((e: never) => void) | undefined;
    bridgeAuditEvents((cb) => {
      publish = cb as never;
      return () => {};
    }, kernel.events);
    const observed: unknown[] = [];
    kernel.events.onCustom('template.bundle.observed', (p) => observed.push(p));

    publish!({ action, entity: 'n8n → my-n8n', actorUserId: 1, ts: '2026-10-07T00:00:00.000Z' } as never);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(observed).toHaveLength(1);
    expect(await kernel.configCenter.get('plugin:template-bundles:override_count', 0)).toBe(1);
    plugin.destroy();
  });

  /**
   * F373. Each observation read the counter and wrote +1; a second read
   * landing while the first upsert was in flight saw the same old value, so
   * two installs counted once. Upserts are gated by deferreds, no sleeps.
   */
  it('counts concurrently observed installs exactly once each', async () => {
    const pending: Array<() => void> = [];
    const db = makeDb();
    db.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn(() => new Promise<void>((resolve) => pending.push(resolve))),
      }),
    });
    const kernel = new NineDeployKernel(db as never, mockConfig);
    const plugin = new TemplateBundlesPlugin();
    await kernel.registerPlugin(plugin);

    for (const name of ['ghost', 'umami', 'n8n']) {
      kernel.events.emit('audit.recorded', { action: 'template.install', entity: `template:${name}`, actorUserId: 1, ts: 't' });
    }
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      if (pending.length === 0) break;
      for (const release of pending.splice(0)) release();
    }

    expect(pending).toHaveLength(0);
    expect(await kernel.configCenter.get('plugin:template-bundles:override_count', 0)).toBe(3);
    plugin.destroy();
  });

  /**
   * F374. destroy() only unsubscribed, so an observation parked on the
   * `enabled` config read when the plugin was disabled still published
   * `template.bundle.observed` and wrote the counter afterwards. Gated order:
   * emit -> unregister -> release the read.
   */
  it('publishes and persists nothing for an observation in flight across unregister', async () => {
    const reads: Array<() => void> = [];
    const upserts: string[] = [];
    const db = makeDb();
    db.query.configEntries.findFirst = vi.fn(() => new Promise((resolve) => reads.push(() => resolve(undefined))));
    db.insert = vi.fn().mockReturnValue({
      values: vi.fn((row: { key: string }) => {
        upserts.push(row.key);
        return { onConflictDoUpdate: vi.fn().mockResolvedValue([]) };
      }),
    });
    const kernel = new NineDeployKernel(db as never, mockConfig);
    await kernel.registerPlugin(new TemplateBundlesPlugin());
    const observed: unknown[] = [];
    kernel.events.onCustom('template.bundle.observed', (p) => observed.push(p));

    kernel.events.emit('audit.recorded', { action: 'template.install', entity: 'template:n8n', actorUserId: 1, ts: 't' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(reads).toHaveLength(1);

    expect(await kernel.unregisterPlugin('template-bundles')).toBe(true);
    for (let round = 0; round < 10; round++) {
      for (const release of reads.splice(0)) release();
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(observed).toEqual([]);
    expect(upserts.filter((k) => k.endsWith(':override_count'))).toEqual([]);
  });
});
