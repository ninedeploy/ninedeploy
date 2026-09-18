import type { KernelContext, KernelPlugin } from '../types.js';

/**
 * Sticky IP plugin — Sprint 5, Gap G-15 (PR #22).
 *
 * Watches the `service.deployed` firehose and, when a project has a
 * `sticky_ip.ip` config-center entry, attaches the configured egress
 * IP to the project's network via the active `IEgressIpDriver`. The
 * matching `service.deploying` listener runs the corresponding
 * `detach()` so a project switching IPs does not leave a stale SNAT
 * rule on the host.
 *
 * Contract:
 *   - `enabled` (default `true`) is the master switch. When `false`,
 *     the listener is set up but every event short-circuits before
 *     the driver.
 *   - The plugin NEVER throws. A missing / failed iptables call
 *     surfaces as a `metric.egress.unavailable` custom event so the
 *     audit pipeline picks it up. Deploys continue with the host's
 *     IP as a fallback.
 *   - `destroy()` clears both subscriptions.
 */
export class StickyIpPlugin implements KernelPlugin {
  readonly id = 'sticky-ip';
  readonly name = 'Sticky IP';
  readonly version = '0.1.0';
  readonly description =
    'Attaches a stable outbound IP per project via iptables SNAT rules, so each tenant gets a distinct egress IP. (G-15)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Network';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'enabled',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Enable Sticky IP',
      category: 'plugin:sticky-ip',
      defaultValue: true,
      description: 'Master switch. When false, the plugin observes deploys but never touches the egress driver.',
      tags: ['network', 'egress'],
    },
  ];

  readonly menuItems = [
    {
      id: 'sticky-ip-command',
      slot: 'command:palette' as const,
      label: 'Sticky IP',
      route: '/settings?section=plugins',
      icon: 'Network',
      order: 96,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    const unsubDeploying = ctx.events.on('service.deploying', (payload) => {
      const record = payload as { serviceId?: number; projectId?: number };
      if (typeof record.projectId !== 'number') return;
      // Detach any pre-existing SNAT so a project switching IPs
      // does not leak the old rule. The attach() below re-applies
      // with the new IP.
      return this.detachForProject(ctx, record.projectId);
    });
    this.unsubs.push(unsubDeploying);

    const unsubDeployed = ctx.events.on('service.deployed', (payload) => {
      const record = payload as { status?: string; projectId?: number };
      if (record.status !== 'success') return;
      if (typeof record.projectId !== 'number') return;
      return this.attachForProject(ctx, record.projectId);
    });
    this.unsubs.push(unsubDeployed);
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private async attachForProject(ctx: KernelContext, projectId: number): Promise<void> {
    try {
      const [enabled, ip] = await Promise.all([
        ctx.configCenter.get<boolean>('plugin:sticky-ip:enabled', true),
        ctx.configCenter.get<string | null>(`project:${projectId}:sticky_ip.ip`, null),
      ]);
      if (!enabled) return;
      if (!ip) return;
      const driver = ctx.registry.listEgressIpDrivers()[0];
      if (!driver) {
        ctx.events.emitCustom('metric.egress.unavailable', {
          projectId,
          reason: 'No IEgressIpDriver is registered on the kernel',
          ts: Date.now(),
        });
        return;
      }
      await driver.attach({ projectId }, ip);
    } catch (err) {
      ctx.events.emitCustom('metric.egress.unavailable', {
        projectId,
        reason: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      });
    }
  }

  private async detachForProject(ctx: KernelContext, projectId: number): Promise<void> {
    try {
      const driver = ctx.registry.listEgressIpDrivers()[0];
      if (!driver) return;
      await driver.detach({ projectId });
    } catch {
      // Detach is best-effort — a stale SNAT rule is annoying but
      // not a deploy blocker. The next `attach()` will overwrite
      // it anyway.
    }
  }
}
