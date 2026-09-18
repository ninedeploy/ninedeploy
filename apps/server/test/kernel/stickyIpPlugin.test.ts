/**
 * Sticky IP plugin — kernel coverage (Sprint 5 G-15, PR #22).
 *
 * Drives the plugin through the real `NineDeployKernel` so the
 * `IEventBus` subscription wiring, the `configCenter` reads, and
 * the `IEgressIpDriver` lookup are exercised end-to-end. A fake
 * `IEgressIpDriver` is registered so the attach/detach paths
 * (including the error → `metric.egress.unavailable` fallback) can
 * be observed without touching the host iptables.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { StickyIpPlugin } from '../../src/kernel/plugins/stickyIpPlugin.js';
import type { EgressIpRule, EgressIpSelector, IEgressIpDriver } from '../../src/kernel/types.js';

const mockDb = {
  query: {
    configEntries: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(undefined),
    },
  },
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue([]) }),
  }),
};

const mockConfig = {
  port: 3000,
  host: '0.0.0.0',
  jwtSecret: 'test-secret-at-least-32-chars-long-12345',
  dataDir: '/tmp/ninedeploy-test',
};

interface CustomEventRecord {
  event: string;
  payload: unknown;
}

async function waitFor(predicate: () => boolean, maxMs = 200): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function captureCustom(kernel: NineDeployKernel): CustomEventRecord[] {
  const out: CustomEventRecord[] = [];
  kernel.events.onCustom('*', (event, payload) => {
    out.push({ event, payload });
  });
  // The bus's wildcard listener is a Vitest shim — use emitCustom + a
  // dedicated subscriber to capture exactly what we want.
  return out;
}

function captureEvent(kernel: NineDeployKernel, name: string): unknown[] {
  const out: unknown[] = [];
  kernel.events.onCustom(name, (payload) => out.push(payload));
  return out;
}

describe('StickyIpPlugin', () => {
  let kernel: NineDeployKernel;
  let plugin: StickyIpPlugin;
  let driver: IEgressIpDriver & { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    kernel = new NineDeployKernel(mockDb as never, mockConfig);
    plugin = new StickyIpPlugin();
    driver = {
      name: 'fake-iptables',
      attach: vi.fn(async (selector: EgressIpSelector, ip: string): Promise<EgressIpRule> => ({
        selector,
        ip,
        createdAt: new Date().toISOString(),
      })),
      detach: vi.fn(async (_selector: EgressIpSelector): Promise<void> => undefined),
      list: vi.fn(async (): Promise<EgressIpRule[]> => []),
    };
    await kernel.registerPlugin(plugin);
    kernel.registry.registerEgressIpDriver(driver);
  });

  describe('metadata', () => {
    it('exposes the official plugin identity and the master-switch config schema', () => {
      expect(plugin.id).toBe('sticky-ip');
      expect(plugin.name).toBe('Sticky IP');
      expect(plugin.version).toBe('0.1.0');
      expect(plugin.author).toBe('NineDeploy Core');
      expect(plugin.isOfficial).toBe(true);
      expect(plugin.icon).toBe('Network');
      expect(plugin.configSchema).toHaveLength(1);
      const enabled = plugin.configSchema[0]!;
      expect(enabled.key).toBe('enabled');
      expect(enabled.type).toBe('boolean');
      expect(enabled.defaultValue).toBe(true);
      expect(enabled.isSecret).toBe(false);
    });

    it('exposes a sidebar command-palette menu item with admin permission', () => {
      expect(plugin.menuItems).toHaveLength(1);
      const item = plugin.menuItems[0]!;
      expect(item.id).toBe('sticky-ip-command');
      expect(item.slot).toBe('command:palette');
      expect(item.label).toBe('Sticky IP');
      expect(item.route).toBe('/settings?section=plugins');
      expect(item.permission).toBe('admin');
    });
  });

  describe('service.deployed attach path', () => {
    it('attaches the configured egress IP when the deploy succeeds', async () => {
      // Enabled + ip both default in configCenter: enabled → true, ip → '203.0.113.5'
      await kernel.configCenter.set('plugin:sticky-ip:enabled', true);
      await kernel.configCenter.set('project:42:sticky_ip.ip', '203.0.113.5');

      kernel.events.emit('service.deployed', { status: 'success', projectId: 42 });

      await waitFor(() => driver.attach.mock.calls.length > 0);
      expect(driver.attach).toHaveBeenCalledWith({ projectId: 42 }, '203.0.113.5');
    });

    it('skips attach when the deploy status is not success', async () => {
      await kernel.configCenter.set('project:7:sticky_ip.ip', '203.0.113.99');
      kernel.events.emit('service.deployed', { status: 'failed', projectId: 7 });
      await new Promise((r) => setTimeout(r, 20));
      expect(driver.attach).not.toHaveBeenCalled();
    });

    it('skips attach when the event has no projectId', async () => {
      await kernel.configCenter.set('project:7:sticky_ip.ip', '203.0.113.99');
      kernel.events.emit('service.deployed', { status: 'success' });
      await new Promise((r) => setTimeout(r, 20));
      expect(driver.attach).not.toHaveBeenCalled();
    });

    it('skips attach when the master switch is disabled', async () => {
      await kernel.configCenter.set('plugin:sticky-ip:enabled', false);
      await kernel.configCenter.set('project:3:sticky_ip.ip', '203.0.113.10');
      kernel.events.emit('service.deployed', { status: 'success', projectId: 3 });
      await new Promise((r) => setTimeout(r, 20));
      expect(driver.attach).not.toHaveBeenCalled();
    });

    it('skips attach when the project has no sticky_ip.ip configured', async () => {
      await kernel.configCenter.set('plugin:sticky-ip:enabled', true);
      kernel.events.emit('service.deployed', { status: 'success', projectId: 5 });
      await new Promise((r) => setTimeout(r, 20));
      expect(driver.attach).not.toHaveBeenCalled();
    });

    it('emits metric.egress.unavailable when no driver is registered', async () => {
      const unreg = new NineDeployKernel(mockDb as never, mockConfig);
      const p = new StickyIpPlugin();
      await unreg.registerPlugin(p);
      // No driver registered on this kernel — the lookup returns [].
      const events = captureEvent(unreg, 'metric.egress.unavailable');
      await unreg.configCenter.set('plugin:sticky-ip:enabled', true);
      await unreg.configCenter.set('project:1:sticky_ip.ip', '203.0.113.1');
      unreg.events.emit('service.deployed', { status: 'success', projectId: 1 });
      await waitFor(() => events.length > 0);
      expect(events[0]).toMatchObject({
        projectId: 1,
        reason: 'No IEgressIpDriver is registered on the kernel',
      });
      p.destroy();
    });

    it('emits metric.egress.unavailable when driver.attach throws', async () => {
      driver.attach.mockRejectedValueOnce(new Error('iptables: Permission denied'));
      await kernel.configCenter.set('plugin:sticky-ip:enabled', true);
      await kernel.configCenter.set('project:8:sticky_ip.ip', '198.51.100.7');
      const events = captureEvent(kernel, 'metric.egress.unavailable');
      kernel.events.emit('service.deployed', { status: 'success', projectId: 8 });
      await waitFor(() => events.length > 0);
      expect(events[0]).toMatchObject({
        projectId: 8,
        reason: 'iptables: Permission denied',
      });
    });

    it('stringifies non-Error throw values in the metric payload', async () => {
      // Some iptables wrappers reject with a string or a plain
      // object. The plugin must not crash on `err.message` access
      // and must emit a usable `reason` field either way.
      driver.attach.mockRejectedValueOnce('egress: ip not routable');
      await kernel.configCenter.set('plugin:sticky-ip:enabled', true);
      await kernel.configCenter.set('project:9:sticky_ip.ip', '198.51.100.9');
      const events = captureEvent(kernel, 'metric.egress.unavailable');
      kernel.events.emit('service.deployed', { status: 'success', projectId: 9 });
      await waitFor(() => events.length > 0);
      expect(events[0]).toMatchObject({
        projectId: 9,
        reason: 'egress: ip not routable',
      });
    });
  });

  describe('r239: detach runs only as part of a successful re-attach', () => {
    it('does not detach when a deploy merely starts (a failed deploy keeps its egress IP)', async () => {
      kernel.events.emit('service.deploying', { serviceId: 1, deployId: 1, projectId: 11 });
      await new Promise((r) => setTimeout(r, 20));
      expect(driver.detach).not.toHaveBeenCalled();
    });

    it('detaches the old rule before attaching the new IP', async () => {
      await kernel.configCenter.set('project:11:sticky_ip.ip', '203.0.113.11');
      kernel.events.emit('service.deployed', { serviceId: 1, deployId: 1, status: 'success', projectId: 11 });
      await waitFor(() => driver.attach.mock.calls.length > 0);
      expect(driver.detach).toHaveBeenCalledWith({ projectId: 11 });
      expect(driver.detach.mock.invocationCallOrder[0]!).toBeLessThan(driver.attach.mock.invocationCallOrder[0]!);
    });

    it('attaches for every linked project', async () => {
      await kernel.configCenter.set('project:31:sticky_ip.ip', '203.0.113.31');
      await kernel.configCenter.set('project:32:sticky_ip.ip', '203.0.113.32');
      kernel.events.emit('service.deployed', { serviceId: 1, deployId: 1, status: 'success', projectId: 31, projectIds: [31, 32] });
      await waitFor(() => driver.attach.mock.calls.length > 1);
      expect(driver.attach).toHaveBeenCalledWith({ projectId: 32 }, '203.0.113.32');
    });

    it('a failing detach does not block the attach', async () => {
      driver.detach.mockRejectedValueOnce(new Error('connection refused'));
      await kernel.configCenter.set('project:99:sticky_ip.ip', '203.0.113.99');
      kernel.events.emit('service.deployed', { serviceId: 1, deployId: 1, status: 'success', projectId: 99 });
      await waitFor(() => driver.attach.mock.calls.length > 0);
      expect(driver.attach).toHaveBeenCalledWith({ projectId: 99 }, '203.0.113.99');
    });
  });

  describe('lifecycle', () => {
    it('clears both subscriptions on destroy() — no events fire after', async () => {
      await kernel.configCenter.set('project:13:sticky_ip.ip', '203.0.113.13');
      plugin.destroy();

      kernel.events.emit('service.deploying', { projectId: 13 });
      kernel.events.emit('service.deployed', { status: 'success', projectId: 13 });
      await new Promise((r) => setTimeout(r, 20));
      expect(driver.attach).not.toHaveBeenCalled();
      expect(driver.detach).not.toHaveBeenCalled();
    });

    it('survives a second init() lifecycle (re-init after destroy)', async () => {
      // The kernel disallows two plugins with the same id, so we
      // spin up a second kernel and prove the same plugin class can
      // re-init cleanly (the realistic operator flow is upgrade +
      // restart, not hot-replace).
      const secondKernel = new NineDeployKernel(mockDb as never, mockConfig);
      const secondPlugin = new StickyIpPlugin();
      await secondKernel.registerPlugin(secondPlugin);
      secondKernel.registry.registerEgressIpDriver(driver);
      await secondKernel.configCenter.set('project:21:sticky_ip.ip', '203.0.113.21');
      secondKernel.events.emit('service.deployed', { status: 'success', projectId: 21 });
      await waitFor(() => driver.attach.mock.calls.length > 0);
      expect(driver.attach).toHaveBeenCalledWith({ projectId: 21 }, '203.0.113.21');
      secondPlugin.destroy();
    });
  });
});

// silence the unused-capture warning on the wildcard helper
void captureCustom;
