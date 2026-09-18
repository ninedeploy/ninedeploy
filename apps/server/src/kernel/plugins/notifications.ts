import type { KernelContext, KernelPlugin } from '../types.js';

export class NotificationsDispatcherPlugin implements KernelPlugin {
  readonly id = 'notifications-dispatcher';
  readonly name = 'Event-Driven Notification Dispatcher';
  readonly version = '1.0.0';
  readonly description = 'Subscribes to domain events and dispatches alerts to configured channels (Telegram, Discord, Slack, Webhooks)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Bell';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'rate_limit_per_minute',
      type: 'number' as const,
      isSecret: false,
      label: 'Max Alerts Per Minute',
      category: 'plugin:notifications-dispatcher',
      defaultValue: 30,
      description: 'Prevents alert storming during cascade container restarts',
      tags: ['notifications', 'rate-limit'],
    },
    {
      key: 'alert_on_deploy_success',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Alert on Deployment Success',
      category: 'plugin:notifications-dispatcher',
      defaultValue: true,
      tags: ['notifications', 'deploy'],
    },
  ];

  readonly menuItems = [
    {
      id: 'notifications-dispatcher-command',
      slot: 'command:palette' as const,
      label: 'Notification Channels',
      route: '/settings?section=notifications',
      icon: 'Bell',
      order: 80,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];
  /**
   * Emission timestamps inside the current sliding minute, for
   * `rate_limit_per_minute`. Bounded by the limit itself — entries older than
   * 60 s are dropped on every check, so this never grows.
   */
  private recentEmits: number[] = [];

  init(ctx: KernelContext): void {
    // 1. Listen for deployment events
    const unsub1 = ctx.events.on('deployment.status_changed', (payload) => {
      const data = payload as { deploymentId?: number; status?: string; serviceName?: string };
      return this.publish(
        ctx,
        {
          title: `Deployment ${data.status ?? 'Updated'}`,
          body: `Service ${data.serviceName ?? 'Unknown'} deployment #${data.deploymentId ?? 0} changed to ${data.status}`,
          level: data.status === 'failed' ? 'error' : 'info',
        },
        // `auditBridge` maps `deploy.success` onto this event with
        // `status: 'success'`; that is the one the operator can switch off.
        { isDeploySuccess: data.status === 'success' },
      );
    });

    // 2. Listen for service health changes
    const unsub2 = ctx.events.on('service.health_changed', (payload) => {
      const data = payload as { serviceId?: number; status?: string };
      if (data.status === 'unhealthy' || data.status === 'dead') {
        return this.publish(ctx, {
          title: `Service Health Alert`,
          body: `Service #${data.serviceId ?? 0} transitioned to ${data.status}`,
          level: 'error',
        });
      }
    });

    // 3. Listen for backup completion/failures
    const unsub3 = ctx.events.on('backup.completed', (payload) => {
      const data = payload as { databaseId?: number; sizeBytes?: number };
      return this.publish(ctx, {
        title: 'Database Backup Completed',
        body: `Database #${data.databaseId ?? 0} backup succeeded (${data.sizeBytes ?? 0} bytes)`,
        level: 'info',
      });
    });

    this.unsubs.push(unsub1, unsub2, unsub3);
  }

  /**
   * Apply the plugin's two operator settings, then re-emit as
   * `notification.queued`.
   *
   * Both settings were declared in `configSchema` — and therefore rendered and
   * saved in the panel — while nothing read them: `rate_limit_per_minute`
   * promised to prevent "alert storming during cascade container restarts" and
   * capped nothing, and switching `alert_on_deploy_success` off changed
   * nothing. A setting that is accepted and ignored is worse than no setting.
   *
   * Never throws: a config read that fails falls back to the schema defaults,
   * because dropping a notification is preferable to breaking the audit bus
   * this listener runs on.
   */
  private async publish(
    ctx: KernelContext,
    notification: { title: string; body: string; level: 'info' | 'warn' | 'error' },
    opts: { isDeploySuccess?: boolean } = {},
  ): Promise<void> {
    try {
      if (opts.isDeploySuccess) {
        const onSuccess = await ctx.configCenter.get<boolean>(
          'plugin:notifications-dispatcher:alert_on_deploy_success',
          true,
        );
        if (!onSuccess) return;
      }

      const limit = await ctx.configCenter.get<number>(
        'plugin:notifications-dispatcher:rate_limit_per_minute',
        30,
      );
      if (!this.withinRateLimit(limit)) {
        // Report the drop once per suppressed alert so the storm is still
        // visible to anything watching the bus, without fanning out.
        ctx.events.emitCustom('notification.rate_limited', {
          title: notification.title,
          limit,
          ts: Date.now(),
        });
        return;
      }

      ctx.events.emit('notification.queued', notification);
    } catch {
      // A config-center failure must not take the audit firehose down.
      ctx.events.emit('notification.queued', notification);
    }
  }

  /**
   * Sliding one-minute window. A limit of 0 or less disables emission
   * entirely; a non-finite value is treated as "no limit" so a corrupted
   * config row cannot silence every alert.
   */
  private withinRateLimit(limit: number): boolean {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return true;
    if (limit <= 0) return false;
    const cutoff = Date.now() - 60_000;
    this.recentEmits = this.recentEmits.filter((t) => t > cutoff);
    if (this.recentEmits.length >= limit) return false;
    this.recentEmits.push(Date.now());
    return true;
  }

  destroy(): void {
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
    this.recentEmits = [];
  }
}
