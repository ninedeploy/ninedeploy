import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { detectPublicIp } from '../lib/cloudflare.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getSettingString } from '../lib/settings.js';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Domain Presets HTTP surface — Sprint 2, Gap G-07 (PR-D).
 *
 * Thin operator-side counterpart of the `DomainPresetsPlugin` and the
 * `IDomainProvider` registry (G-07 PR-A / PR-B / PR-C). The plugin reacts
 * to the audit firehose so a `domain.add` from the panel can create the
 * matching DNS record on its own; this module lets a CLI caller do the
 * same thing on demand, without having to round-trip through the
 * panel's `domain.add` flow.
 *
 * Contract:
 *   - Every route is mounted under `/v1/domain-presets` and requires the
 *     standard `app.authenticate` hook.
 *   - The provider is selected from the existing `dns_records_provider`
 *     setting (`cloudflare-zone` | `dnsimple` | …). An empty value means
 *     "no provider configured" — the apply route fails fast with 400
 *     instead of silently doing nothing.
 *   - The content of the new record comes from the request body when
 *     supplied, else from `dns_records_content` (the panel's static
 *     override), else from `detectPublicIp()` — same precedence the
 *     audit-bus path uses.
 *   - Record type is `A` for an IPv4-shaped content, `CNAME` otherwise
 *     — mirrors `lib/cloudflare.ts:createDnsRecord`.
 *   - A successful apply emits a `domain.preset.manual` audit event so
 *     the rest of the panel (activity log, audit firehose subscribers)
 *     stays consistent with the plugin's own `domain.preset.applied`
 *     path.
 */
const applySchema = z.object({
  hostname: z.string().min(1).max(253),
  /** Optional content override; falls back to settings or `detectPublicIp()`. */
  content: z.string().min(1).optional(),
});

export const domainPresetsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async () => {
    const providers = app.kernel.registry.listDomainProviders();
    return { providers: providers.map((p) => p.name) };
  });

  // Operator-gated: the DNS provider token is configured admin-only
  // (settings PUT /dns is requireAdmin) and this route spends it. Any
  // authenticated member could otherwise create records in every zone the
  // operator's token can write.
  app.post('/apply', { preHandler: app.requireAdmin }, async (req) => {
    const input = applySchema.parse(req.body);
    const providerName = await getSettingString(app.db, 'dns_records_provider', '');
    if (!providerName) {
      throw badRequest('No DNS provider configured. Set dns_records_provider in settings.');
    }
    const provider = app.kernel.registry.getDomainProvider(providerName);
    if (!provider) {
      throw badRequest(`No IDomainProvider registered for "${providerName}"`);
    }
    const zone = await provider.findZoneForHost(input.hostname);
    if (!zone) {
      throw notFound(`No zone matches "${input.hostname}"`);
    }
    const configured = await getSettingString(app.db, 'dns_records_content', null);
    const content = input.content ?? (configured && configured.length > 0 ? configured : await detectPublicIp());
    const type: 'A' | 'CNAME' = /^\d{1,3}(\.\d{1,3}){3}$/.test(content) ? 'A' : 'CNAME';
    const result = await provider.createRecord(zone.id, {
      hostname: input.hostname,
      type,
      content,
      ttl: 1,
    });
    void audit(app.db, req.user!.id, 'domain.preset.manual', input.hostname, {
      provider: provider.name,
      zone: zone.name,
      recordId: result.recordId,
      type,
    });
    return {
      hostname: input.hostname,
      provider: provider.name,
      zone: zone.name,
      recordId: result.recordId,
      type,
      content,
    };
  });
};
