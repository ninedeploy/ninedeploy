import type { KernelContext, KernelPlugin } from '../types.js';

/**
 * Sticky IP plugin — Sprint 5, Gap G-15 (PR #22).
 *
 * Watches the `service.deployed` firehose and, when a project has a
 * `sticky_ip.ip` config-center entry, attaches the configured egress
 * IP to the project's network via the active `IEgressIpDriver`. The
 * attach is preceded by a `detach()` so a project switching IPs does not
 * leave a stale SNAT rule on the host. r239: that detach used to run on
 * `service.deploying`, so a FAILED deploy — whose previous release keeps
 * serving — silently lost its egress IP until the next success.
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
    const unsubDeployed = ctx.events.on('service.deployed', (payload) => {
      const record = payload as { status?: string; projectId?: number; projectIds?: number[] };
      if (record.status !== 'success') return;
      const ids = Array.isArray(record.projectIds) && record.projectIds.length > 0
        ? record.projectIds
        : typeof record.projectId === 'number'
          ? [record.projectId]
          : [];
      if (ids.length === 0) return;
      return Promise.all(ids.map((id) => this.attachForProject(ctx, id))).then(() => undefined);
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
      await this.detachForProject(ctx, projectId);
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
