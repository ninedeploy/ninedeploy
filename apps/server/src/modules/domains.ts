import { and, eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { domains, type Domain } from '@ninedeploy/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createDomain, domainPatch } from '@ninedeploy/schemas';
import { parseHeaders, writeDynamicConfig } from '../engine/proxy.js';
import { createDnsRecord, deleteDnsRecord, detectPublicIp, getDnsRecordsConfig } from '../lib/cloudflare.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { badRequest, conflict, notFound, parseId as num } from '../lib/errors.js';
import { getSettingString } from '../lib/settings.js';
import { classifyResolution, resolveHostAddresses } from '../lib/dnsStatus.js';
import { challengeRecordName, checkOwnershipRecord, newChallengeToken, requiresOwnershipProof } from '../lib/domainVerification.js';

/** Normalise pasted input to a bare hostname. Users routinely paste a full
 *  URL (`https://app.example.com/`) instead of the host, so scheme,
 *  credentials, port and anything after the host are discarded first; what
 *  remains is then lowercased — DNS is case-insensitive — and stripped of
 *  the insignificant trailing root dot. Empty output means unusable input. */
function normalizeHost(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      // `URL.hostname` drops credentials, port and path in one step.
      value = new URL(value).hostname;
    } catch {
      return '';
    }
  }
  // Scheme-less pastes can still carry a path (`app.example.com/`, `app.example.com/about`).
  value = value.split(/[/?#]/)[0] ?? '';
  // Traefik's Host matcher never sees a port.
  value = value.replace(/:\d+$/, '');
  return value.replace(/\.$/, '');
}

/**
 * True when two host patterns can match the same HTTP request — either an
 * exact match, or a `*.suffix` wildcard covering a single-label host under it
 * (which is exactly what `writeDynamicConfig` turns into a HostRegexp router).
 */
function hostsCollide(a: string, b: string): boolean {
  const x = normalizeHost(a);
  const y = normalizeHost(b);
  if (x === y) return true;
  const covers = (pattern: string, host: string): boolean =>
    pattern.startsWith('*.') && !host.startsWith('*.')
      ? new RegExp(`^[a-z0-9-]+\\.${pattern.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&')}$`).test(host)
      : false;
  return covers(x, y) || covers(y, x);
}

/**
 * Refuse a hostname the caller has no claim to.
 *
 * Traefik ranks routers by RULE LENGTH when no explicit priority is set, so a
 * second router for the same host with a longer rule — `Host(x) &&
 * PathPrefix(/api)` versus a bare `Host(x)` — silently outranks the original
 * and receives its traffic, `Authorization` headers included. The unique index
 * is on (hostname, path), so nothing stopped a second service from claiming
 * another tenant's host on a different path.
 *
 * This is deliberately NOT "one hostname, one service": sharing a host across
 * services on different paths is a legitimate routing pattern. The rule is
 * that every service already routing that host must be one the caller can
 * manage.
 */
async function assertHostnameClaimable(
  app: Parameters<FastifyPluginAsync>[0],
  hostname: string,
  serviceId: number,
  user: NonNullable<FastifyRequest['user']>,
): Promise<void> {
  // The panel's own hostname is never a service route: claiming it would put
  // an attacker-controlled container in front of the control plane's login.
  let panelDomain: string | null = null;
  try {
    panelDomain = (await getSettingString(app.db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? null;
  } catch {
    panelDomain = process.env['NINEDEPLOY_DOMAIN'] ?? null;
  }
  if (panelDomain && hostsCollide(hostname, panelDomain)) {
    throw conflict('That hostname is reserved for the NineDeploy panel');
  }

  const rows = await app.db.query.domains.findMany();
  for (const row of rows) {
    if (row.serviceId === serviceId) continue;
    if (!hostsCollide(row.hostname, hostname)) continue;
    try {
      // Admins pass; a member passes only for their own service.
      await loadServiceForUser(app.db, row.serviceId, user);
    } catch {
      // Same 409 whether the holder exists-but-is-foreign or the row is
      // orphaned — the caller learns only that the host is taken.
      throw conflict('That hostname is already routed by another service');
    }
  }
}

function serialize(d: Domain) {
  return {
    id: d.id,
    serviceId: d.serviceId,
    hostname: d.hostname,
    path: d.path,
    ssl: d.ssl,
    redirectWww: d.redirectWww,
    headers: d.headers ?? '[]',
    basicAuth: d.basicAuth ?? null,
    ipAllowlist: d.ipAllowlist ?? null,
    rateLimitAverage: d.rateLimitAverage ?? null,
    rateLimitBurst: d.rateLimitBurst ?? null,
    status: d.status,
    verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** What the caller has to publish in DNS for a domain still awaiting proof. */
function challengeFor(d: Domain): { recordName: string; recordType: 'TXT'; recordValue: string } | null {
  return d.status === 'pending' && d.verificationToken
    ? { recordName: challengeRecordName(d.hostname), recordType: 'TXT', recordValue: d.verificationToken }
    : null;
}

/** Domain (Traefik routing) management for a service. Mounted under /services. */
export const domainsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/domains', async (req) => {
    const id = num((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const rows = await app.db.query.domains.findMany({ where: eq(domains.serviceId, id) });
    return rows.map(serialize);
  });

  app.post('/:id/domains', async (req) => {
    const id = num((req.params as { id: string }).id);
    const input = createDomain.parse(req.body);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    // Store normalised: DNS is case-insensitive, so `Victim.Example.com` and
    // `victim.example.com` are the same route to Traefik — and would otherwise
    // be two different rows to the unique index and to the check below.
    const hostname = normalizeHost(input.hostname);
    if (!hostname) throw badRequest('Enter a valid hostname');
    await assertHostnameClaimable(app, hostname, id, req.user!);

    // H-2 layer 2: a hostname outside this instance's own zone is not routed
    // until its owner proves control of the DNS zone. Until then the row is
    // `pending`, and `writeDynamicConfig` skips it — so a first-come claim on
    // someone else's domain never receives their traffic.
    const needsProof = requiresOwnershipProof(hostname, req.user!.isOperator);
    const verificationToken = needsProof ? newChallengeToken() : null;

    const [d] = await app.db
      .insert(domains)
      .values({
        serviceId: id,
        hostname,
        path: input.path,
        ssl: input.ssl,
        redirectWww: input.redirectWww ?? false,
        headers: input.headers ?? null,
        basicAuth: input.basicAuth ?? null,
        ipAllowlist: input.ipAllowlist ?? null,
        rateLimitAverage: input.rateLimitAverage ?? null,
        rateLimitBurst: input.rateLimitBurst ?? null,
        status: needsProof ? 'pending' : 'active',
        verificationToken,
        verifiedAt: needsProof ? null : new Date(),
      })
      .returning()
      .catch((err: unknown) => {
        if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return [] as Domain[];
        throw err;
      });
    if (!d) throw conflict('A domain with that host already exists');
    // Cloudflare integration: create the DNS record for this hostname. The
    // domain is already usable (manual DNS); a provider failure is surfaced as
    // a flag on the response rather than failing the request.
    let dnsWarning: string | null = null;
    let dnsRecordId: string | null = null;
    const dnsCfg = await getDnsRecordsConfig(app.db);
    // Only for a domain that is already live — there is nothing to point at a
    // hostname whose ownership has not been established.
    if (!needsProof && dnsCfg.enabled && dnsCfg.token) {
      try {
        const content = dnsCfg.content || (await detectPublicIp());
        dnsRecordId = await createDnsRecord(dnsCfg.token, hostname, content);
        await app.db.update(domains).set({ dnsRecordId }).where(eq(domains.id, d.id));
      } catch (err) {
        dnsWarning = err instanceof Error ? err.message : String(err);
      }
    }
    await writeDynamicConfig(app.db);
    void audit(
      app.db,
      req.user!.id,
      'domain.add',
      hostname,
      dnsRecordId ? { dnsRecordId } : dnsWarning ? { dnsWarning } : undefined,
    );
    return { ...serialize(d), dnsRecordId, dnsWarning, verification: challengeFor(d) };
  });

  /**
   * Prove ownership of a pending domain and bring it live.
   *
   * Idempotent and safe to poll: DNS propagation takes minutes, so a failure
   * explains what was found rather than consuming the challenge.
   */
  app.post('/:id/domains/:domainId/verify', async (req) => {
    const id = num((req.params as { id: string }).id);
    const domainId = num((req.params as { domainId: string }).domainId);
    const verifySvc = await loadServiceForUser(app.db, id, req.user!);
    // Verification flips the domain live (and can mint provider DNS records):
    // a write on the service, so the `member` floor applies — a viewer seat
    // stays read-only.
    await assertServiceRole(app.db, verifySvc, req.user!, 'member');
    const d = await app.db.query.domains.findFirst({
      where: and(eq(domains.id, domainId), eq(domains.serviceId, id)),
    });
    if (!d) throw notFound('Domain not found');
    if (d.status === 'active') return { ...serialize(d), verified: true, verification: null };
    if (!d.verificationToken) throw conflict('This domain has no pending verification challenge');

    const result = await checkOwnershipRecord(d.hostname, d.verificationToken);
    if (!result.ok) {
      return {
        ...serialize(d),
        verified: false,
        error: result.error,
        found: result.found,
        verification: challengeFor(d),
      };
    }

    const [updated] = await app.db
      .update(domains)
      .set({ status: 'active', verifiedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(domains.id, domainId), eq(domains.serviceId, id)))
      .returning();
    if (!updated) throw notFound('Domain not found');

    // Now that the hostname is ours to route, the provider record can be made.
    let dnsWarning: string | null = null;
    const dnsCfg = await getDnsRecordsConfig(app.db);
    if (dnsCfg.enabled && dnsCfg.token) {
      try {
        const content = dnsCfg.content || (await detectPublicIp());
        const dnsRecordId = await createDnsRecord(dnsCfg.token, updated.hostname, content);
        await app.db.update(domains).set({ dnsRecordId }).where(eq(domains.id, updated.id));
      } catch (err) {
        dnsWarning = err instanceof Error ? err.message : String(err);
      }
    }

    await writeDynamicConfig(app.db);
    void audit(app.db, req.user!.id, 'domain.verified', updated.hostname);
    return { ...serialize(updated), verified: true, verification: null, dnsWarning };
  });

  /**
   * DNS status for a domain: does the hostname currently resolve to the
   * address this instance expects? Advisory — ownership challenges and
   * routing live elsewhere — but the fastest way to explain a domain that
   * "is added yet does not load" (the usual cause is DNS still pointing at
   * the old server).
   */
  app.get('/:id/domains/:domainId/dns', async (req) => {
    const id = num((req.params as { id: string }).id);
    const domainId = num((req.params as { domainId: string }).domainId);
    await loadServiceForUser(app.db, id, req.user!);
    const d = await app.db.query.domains.findFirst({
      where: and(eq(domains.id, domainId), eq(domains.serviceId, id)),
    });
    if (!d) throw notFound('Domain not found');

    // The expected address mirrors the auto-record flow: the operator's
    // explicit record content, else the detected public IP.
    const dnsCfg = await getDnsRecordsConfig(app.db);
    const expected: string[] = [];
    if (dnsCfg.content) expected.push(dnsCfg.content.trim());
    else {
      try {
        expected.push(await detectPublicIp());
      } catch {
        /* public-IP detection unavailable — report an empty expectation */
      }
    }

    const resolution = await resolveHostAddresses(d.hostname);
    const status = classifyResolution(resolution, expected);
    return { hostname: d.hostname, status, addresses: resolution, expected };
  });

  // Update routing extras: ssl, www→apex redirect, custom headers, basicAuth, ipAllowlist, rateLimit.
  app.patch('/:id/domains/:domainId', async (req) => {
    const id = num((req.params as { id: string }).id);
    const domainId = num((req.params as { domainId: string }).domainId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const input = domainPatch.parse(req.body ?? {});
    // Validate early so a malformed headers array never reaches Traefik.
    const values: Partial<typeof domains.$inferInsert> = {};
    if (input.ssl !== undefined) values.ssl = input.ssl;
    if (input.redirectWww !== undefined) values.redirectWww = input.redirectWww;
    if (input.headers !== undefined) {
      const parsed = parseHeaders(input.headers);
      values.headers = JSON.stringify(parsed);
    }
    if (input.basicAuth !== undefined) values.basicAuth = input.basicAuth;
    if (input.ipAllowlist !== undefined) values.ipAllowlist = input.ipAllowlist;
    if (input.rateLimitAverage !== undefined) values.rateLimitAverage = input.rateLimitAverage;
    if (input.rateLimitBurst !== undefined) values.rateLimitBurst = input.rateLimitBurst;
    const [d] = await app.db
      .update(domains)
      .set(values)
      .where(and(eq(domains.id, domainId), eq(domains.serviceId, id)))
      .returning();
    if (!d) throw notFound('Domain not found');
    await writeDynamicConfig(app.db);
    void audit(app.db, req.user!.id, 'domain.update', d.hostname);
    return serialize(d);
  });

  app.delete('/:id/domains/:domainId', async (req) => {
    const id = num((req.params as { id: string }).id);
    const domainId = num((req.params as { domainId: string }).domainId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const existing = await app.db.query.domains.findFirst({
      where: and(eq(domains.id, domainId), eq(domains.serviceId, id)),
    });
    await app.db.delete(domains).where(and(eq(domains.id, domainId), eq(domains.serviceId, id)));
    // Remove the provider DNS record (best-effort — a stale record only points
    // at the server, it no longer routes anywhere once Traefik rewrites).
    if (existing?.dnsRecordId) {
      const dnsCfg = await getDnsRecordsConfig(app.db);
      if (dnsCfg.enabled && dnsCfg.token) {
        await deleteDnsRecord(dnsCfg.token, existing.hostname, existing.dnsRecordId).catch(() => undefined);
      }
    }
    await writeDynamicConfig(app.db);
    void audit(app.db, req.user!.id, 'domain.delete', existing?.hostname ?? `#${domainId}`);
    return { ok: true };
  });
};
