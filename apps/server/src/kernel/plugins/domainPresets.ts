import { detectPublicIp } from '../../lib/cloudflare.js';
import { getSettingString } from '../../lib/settings.js';
import type { KernelContext, KernelPlugin } from '../types.js';

/**
 * Domain Presets plugin — Sprint 2, Gap G-07 (PR-C).
 *
 * Watches the `audit.recorded` firehose for `domain.add` actions and, when
 * the operator has configured a DNS provider (Cloudflare or DNSimple today),
 * creates the matching record automatically so the operator does not have to
 * open the vendor console and paste an A or CNAME. This is the feature
 * Coolify and Dokploy already ship as "automatic DNS"; the kernel's
 * `IDomainProvider` interface (added in G-07 PR-A) is what makes it
 * vendor-agnostic.
 *
 * Contract:
 *   - `enabled` (default `true`) is the master switch. When `false`, the
 *     plugin is registered (so the menu and config schema remain visible)
 *     but every audit short-circuits before the network.
 *   - The provider is selected from the existing `dns_records_provider`
 *     setting (`cloudflare` | `dnsimple` | `''`). An empty / unknown value
 *     means "no provider configured yet" — the plugin stays silent.
 *   - The record content comes from `dns_records_content` when set, or from
 *     `detectPublicIp()` when not (same convention `modules/domains.ts`
 *     already uses for manual creates).
 *   - Record type is `A` when the content looks like an IPv4 address,
 *     `CNAME` otherwise — mirrors `lib/cloudflare.ts:createDnsRecord`.
 *   - The plugin NEVER throws. Every failure is surfaced as a
 *     `domain.preset.failed` custom event on the kernel bus so the audit
 *     pipeline picks it up.
 *   - Success is published as `domain.preset.applied` with the provider's
 *     recordId so an operator can correlate the upstream-side id with
 *     the panel-side row.
 *   - All audit actions other than `domain.add` are ignored.
 *   - `destroy()` clears every subscription registered in `init()`.
 */
export class DomainPresetsPlugin implements KernelPlugin {
  readonly id = 'domain-presets';
  readonly name = 'Domain Presets';
  readonly version = '0.1.0';
  readonly description =
    'Automatically creates DNS records for new domains via the configured IDomainProvider (Cloudflare or DNSimple). (G-07)';
  readonly author = 'NineDeploy Core';
  readonly icon = 'Workflow';
  readonly isOfficial = true;

  readonly configSchema = [
    {
      key: 'enabled',
      type: 'boolean' as const,
      isSecret: false,
      label: 'Enable Domain Presets',
      category: 'plugin:domain-presets',
      defaultValue: true,
      description:
        'When enabled, a successful domain.add audit event automatically creates a matching DNS record via the active IDomainProvider.',
      tags: ['domain', 'dns', 'preset'],
    },
  ];

  readonly menuItems = [
    {
      id: 'domain-presets-command',
      slot: 'command:palette' as const,
      label: 'Domain Presets',
      route: '/settings?section=plugins',
      icon: 'Workflow',
      order: 91,
      permission: 'admin' as const,
    },
  ];

  private unsubs: Array<() => void> = [];

  init(ctx: KernelContext): void {
    const unsub = ctx.events.on('audit.recorded', (payload) => {
      // Fire-and-forget — the audit bus must not block on the network.
      return this.handle(ctx, payload);
    });
    this.unsubs.push(unsub);
  }

  destroy(): void {
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }

  private async handle(
    ctx: KernelContext,
    payload: { action?: string; entity?: string | null; actorUserId?: number | null; ts?: string },
  ): Promise<void> {
    if (payload.action !== 'domain.add') return;
    const hostname = payload.entity;
    if (!hostname) return;

    try {
      const enabled = await ctx.configCenter.get<boolean>('plugin:domain-presets:enabled', true);
      if (!enabled) return;

      const providerName = await getSettingString(ctx.db, 'dns_records_provider', '');
      if (!providerName) return;

      const provider = ctx.registry.getDomainProvider(providerName);
      if (!provider) {
        this.publishFailed(ctx, hostname, `No IDomainProvider registered for "${providerName}"`);
        return;
      }

      const zone = await provider.findZoneForHost(hostname);
      if (!zone) {
        this.publishFailed(ctx, hostname, `No zone matches "${hostname}"`);
        return;
      }

      const configured = await getSettingString(ctx.db, 'dns_records_content', null);
      const content = configured && configured.length > 0 ? configured : await detectPublicIp();
      const type: 'A' | 'CNAME' = /^\d{1,3}(\.\d{1,3}){3}$/.test(content) ? 'A' : 'CNAME';

      const result = await provider.createRecord(zone.id, {
        hostname,
        type,
        content,
        ttl: 1,
      });

      ctx.events.emitCustom('domain.preset.applied', {
        hostname,
        provider: provider.name,
        zone: zone.name,
        recordId: result.recordId,
        type,
        content,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      this.publishFailed(ctx, hostname, err instanceof Error ? err.message : String(err));
    }
  }

  private publishFailed(ctx: KernelContext, hostname: string, reason: string): void {
    ctx.events.emitCustom('domain.preset.failed', {
      hostname,
      reason,
      ts: new Date().toISOString(),
    });
  }
}
