import { inArray } from 'drizzle-orm';
import { services } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { getSetting, getSettingString, setSetting, setSettingJson, setSettingString } from '../lib/settings.js';
import { DOMAIN_POLICY_DEFAULTS, DOMAIN_POLICY_KEY, getDomainPolicy } from '../lib/domainPolicy.js';
import { invalidateTemplateCache } from '../templates/registry.js';
import {
  DNS_PROVIDERS,
  encryptDnsToken,
  ensureNetwork,
  ensureTraefik,
  getAcmeEmail,
  getDnsConfig,
  writeDynamicConfig,
} from '../engine/proxy.js';
import { activeKeyVersion, knownKeyVersions } from '../lib/crypto.js';
import { rotateSecretsWithReport } from '../lib/keyRotation.js';
import { unprocessable } from '../lib/errors.js';
import {
  ensureVaultAllowlistInitialised,
  getVaultConfig,
  setVaultAllowlist,
  setVaultConfig,
  testVault,
} from '../lib/vault.js';
import { clearEnrolmentToken, getEnrolmentToken, rotateEnrolmentToken } from '../lib/enrolment.js';
import { getDnsRecordsConfig, setDnsRecordsConfig, testCloudflareToken } from '../lib/cloudflare.js';
import { getNamecheapConfig, setNamecheapConfig } from '../lib/namecheap.js';
import { config } from '../config.js';
import { ALLOW_REGISTRATION_DEFAULT } from './auth.js';

const togglePatch = z.object({ enabled: z.boolean() });
const emailPatch = z.object({ email: z.union([z.string().email().max(254), z.literal('')]) });
const domainPatch = z.object({
  domain: z.union([z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/).max(255), z.literal('')]),
});
// A registry source is either an https URL, an absolute filesystem path, or
// empty (= use the bundled registry).
const sourcePatch = z.object({ source: z.union([z.url().startsWith('https://'), z.string().regex(/^\//), z.literal('')]) });
// DNS-01 challenge config: provider from the supported list (or empty), an
// optional API token (omitted = keep the stored one), and an optional bare
// wildcard apex (e.g. example.com → *.example.com certificate).
const dnsPatch = z.object({
  provider: z.union([z.string().refine((p) => p === '' || p in DNS_PROVIDERS, 'Unsupported DNS provider'), z.literal('')]),
  token: z.string().min(1).max(4096).optional(),
  wildcardApex: z.union([z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/), z.literal('')]),
});
// Vault provider config: provider (or empty = off), optional token (omitted =
// keep stored), Infisical workspace id / Doppler project, environment slug.
const vaultPatch = z.object({
  provider: z.enum(['', 'infisical', 'doppler']),
  token: z.string().min(1).max(4096).optional(),
  projectId: z.union([z.string().max(255), z.literal('')]).optional(),
  environment: z.union([z.string().max(255), z.literal('')]).optional(),
});
// r510: which tenants may resolve vault references. Workspace ids, plus the
// legacy un-tagged service ids the upgrade seed grandfathered (omitted = keep).
const vaultAllowlistPatch = z.object({
  workspaceIds: z.array(z.number().int().positive()).max(1000),
  serviceIds: z.array(z.number().int().positive()).max(1000).optional(),
});
// Cloudflare DNS-record provisioning: toggle + optional token (omitted = keep)
// + explicit record content (IPv4 → A, hostname → CNAME; empty = auto-detect).
const dnsRecordsPatch = z.object({
  enabled: z.boolean(),
  token: z.string().min(10).max(4096).optional(),
  content: z.union([z.string().max(255), z.literal('')]).optional(),
});
// r634: domain-claim limits (see lib/domainPolicy.ts). Each field is
// optional — omitted keeps the current value; 0 disables that limit.
const policyInt = z.number().int().min(0).max(1_000_000);
const domainPolicyPatch = z
  .object({
    maxOwnZoneDomainsPerService: policyInt.optional(),
    maxDomainCreatesPerHour: policyInt.optional(),
    pendingExpiryDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict();
// Namecheap DNS-record provisioning: `apiUser` + `apiKey` (encrypted at rest)
// + `clientIp` (the server's public IP, which the operator must have
// whitelisted on the Namecheap account panel). All three are required
// together — a half-configured set is rejected so the operator has to
// re-run with the full triple.
const namecheapConfigPatch = z.object({
  apiUser: z.string().min(1).max(64),
  apiKey: z.string().min(10).max(4096),
  clientIp: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/, 'clientIp must be an IPv4 address'),
});

/**
 * Instance settings (admin-only). Mounted under /settings.
 * Exposes the open-registration toggle and the ACME (Let's Encrypt) email.
 */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  const applyTraefikSettings = async () => {
    const log = (line: string) => app.log.info({ component: 'settings' }, line);
    await ensureNetwork(log);
    await ensureTraefik(log, await getAcmeEmail(app.db), await getDnsConfig(app.db));
    await writeDynamicConfig(app.db);
  };
  const traefikApplyTimers = new Set<ReturnType<typeof setTimeout>>();

  // The settings request itself may be travelling through Traefik. Recreating
  // the proxy before its small JSON response reaches the browser would make a
  // successful save look like a network failure, so apply just after the
  // response has had time to flush. The watchdog provides a later retry if
  // Docker is temporarily unavailable.
  const scheduleTraefikSettingsApply = () => {
    const timer = setTimeout(() => {
      traefikApplyTimers.delete(timer);
      void applyTraefikSettings().catch((err) =>
        app.log.error({ err, component: 'settings' }, 'failed to apply Traefik settings'),
      );
    }, 1000);
    traefikApplyTimers.add(timer);
    timer.unref();
  };

  app.addHook('onClose', async () => {
    for (const timer of traefikApplyTimers) clearTimeout(timer);
    traefikApplyTimers.clear();
  });

  app.get('/', async () => ({
    allowRegistration: await getSetting(app.db, 'allow_registration', ALLOW_REGISTRATION_DEFAULT),
    // Effective email: DB setting wins, env var is the fallback.
    acmeEmail: (await getSettingString(app.db, 'acme_email', null)) ?? config.acmeEmail ?? null,
    templatesSource: (await getSettingString(app.db, 'templates_source', null)) ?? config.templatesSource ?? null,
    // Read at request time (not import time) so env-only setups report it.
    dnsProvider: (await getSettingString(app.db, 'dns_provider', null)) ?? process.env['NINEDEPLOY_DNS_PROVIDER'] ?? null,
    // Read at request time (not import time) so env-only setups report true.
    hasDnsToken: (await getSettingString(app.db, 'dns_token_encrypted', null)) !== null || !!process.env['NINEDEPLOY_DNS_TOKEN'],
    // Read at request time (not import time) so env-only setups report it.
    wildcardApex: (await getSettingString(app.db, 'wildcard_domain', null)) ?? (process.env['NINEDEPLOY_WILDCARD_DOMAIN'] || null),
    panelDomain: (await getSettingString(app.db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? null,
  }));

  app.put('/panel-domain', async (req) => {
    const { domain } = domainPatch.parse(req.body);
    await setSettingString(app.db, 'panel_domain', domain);
    await writeDynamicConfig(app.db).catch(() => undefined);
    void audit(app.db, req.user!.id, 'settings.panel_domain', domain || 'cleared');
    return { ok: true, panelDomain: domain || null };
  });

  // r634: operator-tunable domain-claim limits. GET answers the effective
  // values plus the defaults, so a UI or the CLI can show what "reset" means.
  app.get('/domain-policy', async () => ({
    policy: await getDomainPolicy(app.db),
    defaults: DOMAIN_POLICY_DEFAULTS,
  }));

  app.put('/domain-policy', async (req) => {
    const input = domainPolicyPatch.parse(req.body ?? {});
    const next = { ...(await getDomainPolicy(app.db)), ...input };
    await setSettingJson(app.db, DOMAIN_POLICY_KEY, next);
    void audit(app.db, req.user!.id, 'settings.domain_policy', JSON.stringify(next));
    return { ok: true, policy: next };
  });

  app.put('/allow-registration', async (req) => {
    const { enabled } = togglePatch.parse(req.body);
    await setSetting(app.db, 'allow_registration', enabled);
    void audit(app.db, req.user!.id, 'settings.registration', enabled ? 'enabled' : 'disabled');
    return { ok: true, allowRegistration: enabled };
  });

  app.put('/templates-source', async (req) => {
    const { source } = sourcePatch.parse(req.body);
    await setSettingString(app.db, 'templates_source', source);
    invalidateTemplateCache();
    void audit(app.db, req.user!.id, 'settings.templates', source || 'bundled');
    return { ok: true, templatesSource: source || null };
  });

  app.put('/dns', async (req) => {
    const input = dnsPatch.parse(req.body);
    await setSettingString(app.db, 'dns_provider', input.provider);
    if (input.token !== undefined) {
      await setSettingString(app.db, 'dns_token_encrypted', encryptDnsToken(input.token));
    }
    await setSettingString(app.db, 'wildcard_domain', input.wildcardApex);
    void audit(app.db, req.user!.id, 'settings.dns', `${input.provider || 'none'}${input.wildcardApex ? ` (*.${input.wildcardApex})` : ''}`);
    scheduleTraefikSettingsApply();
    return { ok: true, dnsProvider: input.provider || null, wildcardApex: input.wildcardApex || null, applied: 'live' };
  });

  app.put('/acme-email', async (req) => {
    const { email } = emailPatch.parse(req.body);
    await setSettingString(app.db, 'acme_email', email);
    void audit(app.db, req.user!.id, 'settings.acme', email || 'cleared');
    scheduleTraefikSettingsApply();
    return { ok: true, acmeEmail: email || null, applied: 'live' };
  });

  // ── Vault provider (deploy-time secret resolution) ───────────────────────
  // r510: the allowlist rides along (additive fields) with the names the UI
  // needs to render it — every workspace, and the grandfathered services.
  const vaultAllowlistView = async () => {
    const allowlist = await ensureVaultAllowlistInitialised(app.db);
    const allWorkspaces = await app.db.query.workspaces.findMany({ orderBy: (w, { asc }) => [asc(w.name)] });
    const legacy = allowlist.serviceIds.length
      ? await app.db.query.services.findMany({ where: inArray(services.id, allowlist.serviceIds) })
      : [];
    return {
      allowlist,
      workspaces: allWorkspaces.map((w) => ({ id: w.id, name: w.name })),
      allowedServices: legacy.map((s) => ({ id: s.id, name: s.name })),
    };
  };

  app.get('/vault', async () => {
    const cfg = await getVaultConfig(app.db);
    return {
      provider: cfg.provider,
      hasToken: !!cfg.token,
      projectId: cfg.projectId,
      environment: cfg.environment,
      ...(await vaultAllowlistView()),
    };
  });

  app.put('/vault/allowlist', async (req) => {
    const input = vaultAllowlistPatch.parse(req.body);
    const current = await ensureVaultAllowlistInitialised(app.db);
    const next = await setVaultAllowlist(app.db, {
      workspaceIds: input.workspaceIds,
      serviceIds: input.serviceIds ?? current.serviceIds,
    });
    void audit(
      app.db,
      req.user!.id,
      'settings.vault_allowlist',
      `workspaces [${next.workspaceIds.join(', ')}], services [${next.serviceIds.join(', ')}]`,
      { ...next },
    );
    return { ok: true, ...(await vaultAllowlistView()) };
  });

  app.put('/vault', async (req) => {
    const input = vaultPatch.parse(req.body);
    const current = await getVaultConfig(app.db);
    await setVaultConfig(app.db, {
      provider: input.provider === '' ? null : input.provider,
      // Omitted token = keep the stored one; the others follow the payload.
      token: input.token ?? (input.provider === current.provider ? current.token : null),
      projectId: input.projectId ?? null,
      environment: input.environment ?? null,
    });
    void audit(app.db, req.user!.id, 'settings.vault', input.provider || 'disabled');
    return { ok: true, provider: input.provider || null };
  });

  app.post('/vault/test', async () => {
    const count = await testVault(app.db);
    return { ok: true, secrets: count };
  });

  // ── DNS records (Cloudflare auto-provisioning) ───────────────────────────
  app.get('/dns-records', async () => {
    const cfg = await getDnsRecordsConfig(app.db);
    return { enabled: cfg.enabled, hasToken: !!cfg.token, content: cfg.content };
  });

  app.put('/dns-records', async (req) => {
    const input = dnsRecordsPatch.parse(req.body);
    await setDnsRecordsConfig(app.db, {
      enabled: input.enabled,
      token: input.token,
      content: input.content || null,
    });
    void audit(app.db, req.user!.id, 'settings.dns_records', input.enabled ? 'cloudflare' : 'disabled');
    return { ok: true, enabled: input.enabled };
  });

  app.post('/dns-records/test', async () => {
    const cfg = await getDnsRecordsConfig(app.db);
    if (!cfg.token) return { ok: false, error: 'No Cloudflare token configured' };
    const status = await testCloudflareToken(cfg.token);
    return { ok: true, status };
  });

  // ── Namecheap DNS records (G-07 PR-A) ─────────────────────────────────
  // Three values, all required together: the operator must have already
  // whitelisted the server's public IP on the Namecheap account panel.
  // The key is encrypted at rest by `setNamecheapConfig`; the username
  // and client IP are stored in plaintext because they are not secret
  // on their own.
  app.get('/dns-records/namecheap', async () => {
    const cfg = await getNamecheapConfig(app.db);
    return {
      configured: cfg !== null,
      apiUser: cfg?.apiUser ?? null,
      clientIp: cfg?.clientIp ?? null,
      hasKey: cfg !== null,
    };
  });

  app.put('/dns-records/namecheap', async (req) => {
    const input = namecheapConfigPatch.parse(req.body);
    await setNamecheapConfig(app.db, input);
    void audit(app.db, req.user!.id, 'settings.dns_records.namecheap', input.apiUser);
    return { ok: true, apiUser: input.apiUser };
  });

  // ── Node enrolment (M-6) ────────────────────────────────────────────────
  // `POST /v1/servers/announce` is the only unauthenticated write in the
  // product; it now demands this secret. These routes are admin-only (the
  // whole plugin is), and the token is returned in clear because the operator
  // has to paste it into the agent's NINEDEPLOY_ENROLMENT_TOKEN.
  app.get('/enrolment', async () => {
    const token = await getEnrolmentToken(app.db);
    return { enabled: !!token, token };
  });

  app.post('/enrolment/rotate', async (req) => {
    const token = await rotateEnrolmentToken(app.db);
    // The value itself is never audited — only the fact that it changed.
    void audit(app.db, req.user!.id, 'settings.enrolment_rotated');
    return { ok: true, enabled: true, token };
  });

  app.delete('/enrolment', async (req) => {
    await clearEnrolmentToken(app.db);
    void audit(app.db, req.user!.id, 'settings.enrolment_disabled');
    return { ok: true, enabled: false };
  });

  // ── Master-key rotation ─────────────────────────────────────────────────
  // `lib/keyRotation.ts` has always implemented the re-encryption sweep, and
  // `.env.example` has always told operators to "run `ninedeploy rotate-keys`"
  // — a command that did not exist. Nothing in the product called
  // `rotateSecrets`, so an operator who followed the documented procedure and
  // then dropped the retired key from NINEDEPLOY_MASTER_KEYS was left with a
  // database full of secrets sealed under a key the process no longer holds.
  // This is that missing call site.
  app.get('/master-key', async () => {
    const versions = knownKeyVersions();
    return {
      activeVersion: activeKeyVersion(),
      knownVersions: versions,
      // With one version in the ring there is nothing to rotate ONTO — the
      // operator has to add a higher-numbered key first.
      rotatable: versions.length > 1,
    };
  });

  app.post('/master-key/rotate', async (req) => {
    const versions = knownKeyVersions();
    if (versions.length < 2) {
      throw unprocessable(
        'Nothing to rotate onto: NINEDEPLOY_MASTER_KEYS holds a single key version. Add a new 32-byte key under a higher version and restart first.',
      );
    }
    const result = await rotateSecretsWithReport(app.db);
    void audit(
      app.db,
      req.user!.id,
      'settings.master_key_rotated',
      `v${result.activeVersion} (${result.rotated} values)`,
    );
    return {
      ...result,
      // The one thing an operator must know before completing the documented
      // procedure. Backup envelopes carry their own key version and are NOT
      // rewritten here.
      warning:
        result.backupsNotRotated > 0
          ? `${result.backupsNotRotated} stored backup(s) are still sealed under an older key version. Keep every old version in NINEDEPLOY_MASTER_KEYS until those backups have aged out — removing a key makes the backups taken under it permanently unrestorable.`
          : null,
    };
  });
};
