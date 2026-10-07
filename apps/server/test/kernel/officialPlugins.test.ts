import { describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { CloudflareTunnelsPlugin } from '../../src/kernel/plugins/cloudflareTunnels.js';
import { ManifestGeneratorPlugin } from '../../src/kernel/plugins/manifestGenerator.js';
import { NotificationsDispatcherPlugin } from '../../src/kernel/plugins/notifications.js';
import { TemplateBundlesPlugin } from '../../src/kernel/plugins/templateBundles.js';
import { TelemetryStreamerPlugin } from '../../src/kernel/plugins/telemetry.js';

describe('Official Kernel Plugins', () => {
  const mockDb = {
    query: {
      configEntries: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue([]) }) }),
  };

  const mockConfig = {
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-at-least-32-chars-long-12345',
    dataDir: '/tmp/ninedeploy-test',
  };

  describe('NotificationsDispatcherPlugin', () => {
    it('initializes and handles domain events for notifications', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new NotificationsDispatcherPlugin();

      await kernel.registerPlugin(plugin);

      const notifications: unknown[] = [];
      kernel.events.on('notification.queued', (payload) => {
        notifications.push(payload);
      });
      // Re-emission is async now: the plugin awaits `alert_on_deploy_success`
      // and `rate_limit_per_minute` from the config centre before publishing.
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      // 1. Deployment status changed (failed)
      kernel.events.emit('deployment.status_changed', { deploymentId: 10, serviceName: 'api', status: 'failed' });
      await settle();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        title: 'Deployment failed',
        body: 'Service api deployment #10 changed to failed',
        level: 'error',
      });

      // 2. Deployment status changed (success)
      kernel.events.emit('deployment.status_changed', { deploymentId: 11, serviceName: 'web', status: 'ready' });
      await settle();
      expect(notifications).toHaveLength(2);
      expect(notifications[1]).toEqual({
        title: 'Deployment ready',
        body: 'Service web deployment #11 changed to ready',
        level: 'info',
      });

      // 3. Deployment status without name/id — F628: no fabricated "#0"
      kernel.events.emit('deployment.status_changed', {});
      await settle();
      expect(notifications).toHaveLength(3);
      expect(notifications[2]).toEqual({
        title: 'Deployment Updated',
        body: 'Service Unknown deployment changed to undefined',
        level: 'info',
      });

      // 4. Service health changed (unhealthy)
      kernel.events.emit('service.health_changed', { serviceId: 5, status: 'unhealthy' });
      await settle();
      expect(notifications).toHaveLength(4);
      expect(notifications[3]).toEqual({
        title: 'Service Health Alert',
        body: 'Service #5 transitioned to unhealthy',
        level: 'error',
      });

      // 5. Service health changed (dead status and empty serviceId)
      kernel.events.emit('service.health_changed', { status: 'dead' });
      await settle();
      expect(notifications).toHaveLength(5);
      expect(notifications[4]).toEqual({
        title: 'Service Health Alert',
        body: 'Service #0 transitioned to dead',
        level: 'error',
      });

      // 6. Service health changed (healthy - should not notify)
      kernel.events.emit('service.health_changed', { serviceId: 5, status: 'healthy' });
      await settle();
      expect(notifications).toHaveLength(5);

      // 7. Backup completed (r437: the bridge carries the database NAME)
      kernel.events.emit('backup.completed', { database: 'pg-primary' });
      await settle();
      expect(notifications).toHaveLength(6);
      expect(notifications[5]).toEqual({
        title: 'Database Backup Completed',
        body: 'Database "pg-primary" backup succeeded',
        level: 'info',
      });

      // 8. Backup completed with an empty payload — honest "unknown", not a
      // fabricated "#0 (0 bytes)" (r437)
      kernel.events.emit('backup.completed', {});
      await settle();
      expect(notifications).toHaveLength(7);
      expect(notifications[6]).toEqual({
        title: 'Database Backup Completed',
        body: 'Database "unknown" backup succeeded',
        level: 'info',
      });

      // Destroy
      plugin.destroy();
    });

    /**
     * r034. Both keys were declared in `configSchema` — so the panel rendered
     * and saved them — while nothing in the plugin ever read one. Switching
     * "Alert on Deployment Success" off changed nothing, and the "Max Alerts
     * Per Minute" cap that advertises itself as preventing "alert storming
     * during cascade container restarts" capped nothing.
     */
    it('honours alert_on_deploy_success', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new NotificationsDispatcherPlugin();
      await kernel.registerPlugin(plugin);
      await kernel.configCenter.set('plugin:notifications-dispatcher:alert_on_deploy_success', false);

      const notifications: unknown[] = [];
      kernel.events.on('notification.queued', (p) => notifications.push(p));
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      // `auditBridge` maps `deploy.success` onto status: 'success'.
      kernel.events.emit('deployment.status_changed', { deploymentId: 1, serviceName: 'api', status: 'success' });
      await settle();
      expect(notifications).toHaveLength(0);

      // A FAILURE is never suppressed by the success switch.
      kernel.events.emit('deployment.status_changed', { deploymentId: 2, serviceName: 'api', status: 'failed' });
      await settle();
      expect(notifications).toHaveLength(1);

      plugin.destroy();
    });

    it('caps emissions at rate_limit_per_minute within the sliding window', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new NotificationsDispatcherPlugin();
      await kernel.registerPlugin(plugin);
      await kernel.configCenter.set('plugin:notifications-dispatcher:rate_limit_per_minute', 2);

      const notifications: unknown[] = [];
      const limited: unknown[] = [];
      kernel.events.on('notification.queued', (p) => notifications.push(p));
      kernel.events.onCustom('notification.rate_limited', (p) => limited.push(p));
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      // A cascade of five container deaths in the same minute.
      for (let i = 0; i < 5; i++) {
        kernel.events.emit('service.health_changed', { serviceId: i, status: 'dead' });
        await settle();
      }

      expect(notifications).toHaveLength(2);
      expect(limited).toHaveLength(3);

      plugin.destroy();
    });

    it('still delivers the alert when the config centre itself fails', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new NotificationsDispatcherPlugin();
      await kernel.registerPlugin(plugin);
      vi.spyOn(kernel.configCenter, 'get').mockRejectedValue(new Error('config centre down'));

      const notifications: unknown[] = [];
      kernel.events.on('notification.queued', (p) => notifications.push(p));
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      kernel.events.emit('service.health_changed', { serviceId: 1, status: 'dead' });
      await settle();
      // Dropping an alert because the settings could not be read would be the
      // wrong failure: deliver, then let the operator fix the config centre.
      expect(notifications).toHaveLength(1);

      plugin.destroy();
    });

    it('treats a corrupted rate limit as no limit rather than silence', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new NotificationsDispatcherPlugin();
      await kernel.registerPlugin(plugin);
      await kernel.configCenter.set('plugin:notifications-dispatcher:rate_limit_per_minute', 'not-a-number');

      const notifications: unknown[] = [];
      kernel.events.on('notification.queued', (p) => notifications.push(p));
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      for (let i = 0; i < 3; i++) {
        kernel.events.emit('service.health_changed', { serviceId: i, status: 'dead' });
        await settle();
      }
      expect(notifications).toHaveLength(3);

      plugin.destroy();
    });
  });

  describe('CloudflareTunnelsPlugin', () => {
    it('registers menu item and executes deploy.after hook', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new CloudflareTunnelsPlugin();

      await kernel.registerPlugin(plugin);

      // Verify menu item registered
      const items = kernel.menuRegistry.getItemsForSlot('sidebar:secondary', true);
      const tunnelItem = items.find((i) => i.id === 'cf-tunnels-nav');
      expect(tunnelItem).toBeDefined();
      expect(tunnelItem?.route).toBe('/tunnels');

      // Verify hook execution
      const routeEvents: unknown[] = [];
      kernel.events.on('tunnel.route_evaluated', (payload) => {
        routeEvents.push(payload);
      });

      const result = await kernel.hooks.call('deploy.after', { serviceId: 100, domain: 'api.example.com' });
      expect(result).toEqual({ serviceId: 100, domain: 'api.example.com' });
      expect(routeEvents).toHaveLength(1);
      expect(routeEvents[0]).toEqual({ serviceId: 100, domain: 'api.example.com' });

      plugin.destroy();
    });
  });

  describe('TelemetryStreamerPlugin', () => {
    it('listens on wildcard events and emits telemetry records', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new TelemetryStreamerPlugin();

      await kernel.registerPlugin(plugin);

      const telemetry: unknown[] = [];
      kernel.events.on('telemetry.recorded', (payload) => {
        telemetry.push(payload);
      });

      kernel.events.emit('custom.system_event', { key: 'value' });

      expect(telemetry).toHaveLength(1);
      const record = telemetry[0] as { sourceEvent: string; data: { key: string }; timestamp: string };
      expect(record.sourceEvent).toBe('custom.system_event');
      expect(record.data).toEqual({ key: 'value' });
      expect(record.timestamp).toBeDefined();

      // Emit telemetry.recorded directly - should not re-record (recursion guard)
      kernel.events.emit('telemetry.recorded', { test: true });
      expect(telemetry).toHaveLength(2); // The direct listener catches it, but no new telemetry event is spawned

      plugin.destroy();
    });
  });

  describe('TemplateBundlesPlugin', () => {
    it('republishes template.install audit events and ignores the rest', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new TemplateBundlesPlugin();
      await kernel.registerPlugin(plugin);

      const observed: unknown[] = [];
      kernel.events.onCustom('template.bundle.observed', (payload) => observed.push(payload));

      kernel.events.emit('audit.recorded', {
        action: 'template.install',
        entity: 'template:n8n',
        actorUserId: 42,
        ts: '2026-08-28T12:00:00.000Z',
      });
      kernel.events.emit('audit.recorded', {
        action: 'service.created',
        entity: 'service:1',
        actorUserId: 7,
        ts: '2026-08-28T12:00:01.000Z',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ action: 'template.install', entity: 'template:n8n' });

      plugin.destroy();
    });
  });

  describe('ManifestGeneratorPlugin', () => {
    it('reacts to template.bundle.observed and emits manifest.generated', async () => {
      const kernel = new NineDeployKernel(mockDb as never, mockConfig);
      const plugin = new ManifestGeneratorPlugin();
      await kernel.registerPlugin(plugin);

      const generated: unknown[] = [];
      kernel.events.onCustom('manifest.generated', (payload) => generated.push(payload));

      kernel.events.emitCustom('template.bundle.observed', {
        action: 'template.install',
        entity: 'template:n8n',
        actorUserId: 1,
        ts: '2026-08-28T12:00:00.000Z',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(generated).toHaveLength(1);
      expect(generated[0]).toMatchObject({
        templateId: 'n8n',
        manifest: { version: '1', run: { port: 5678 } },
      });
    });
  });
});

