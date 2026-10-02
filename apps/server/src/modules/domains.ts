import { and, eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { domains, type Domain } from '@ninedeploy/db';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createDomain, domainPatch } from '@ninedeploy/schemas';
import { parseHeaders, writeDynamicConfig } from '../engine/proxy.js';
import { createDnsRecord, deleteDnsRecord, detectPublicIp, getDnsRecordsConfig, listDnsRecordsByName } from '../lib/cloudflare.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertServiceRole, roleAtLeast, serviceRole } from '../lib/resourceAccess.js';
import { badRequest, conflict, HttpError, notFound, parseId as num } from '../lib/errors.js';
import { getSettingString } from '../lib/settings.js';
import { classifyResolution, resolveHostAddresses } from '../lib/dnsStatus.js';
import {
  challengeRecordName,
  checkOwnershipRecord,
  companionOutsideProof,
  hostsCollide,
  isRoutableHostname,
  newChallengeToken,
  normalizeHost,
  pendingTakeoverToken,
  requiresOwnershipProof,
  ownZoneClaimRefusal,
  unroutableHostnameMessage,
  wwwCompanionHost,
} from '../lib/domainVerification.js';
import { domainCapRefusal, getDomainPolicy } from '../lib/domainPolicy.js';
import { basicAuthForDisplay, basicAuthForStorage } from '../lib/htpasswd.js';

type AppInstance = Parameters<FastifyPluginAsync>[0];
type RequestUser = NonNullable<FastifyRequest['user']>;

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
 * manage — and "manage" means a `member` seat on it (r632): a viewer seat
 * only lets you read a service, and used to be enough to stack a longer-rule
 * router on its hostname.
 *
 * r635: a foreign row that is only `pending` (never proved) is not a holder.
 * It is returned instead of refused, so the caller can take the hostname over
 * by proving the zone — a first-come unverified claim used to block the real
 * owner forever.
 */
async function assertHostnameClaimable(
  app: AppInstance,
  hostname: string,
  serviceId: number,
  user: RequestUser,
): Promise<Domain[]> {
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
  const unverified: Domain[] = [];
  for (const row of rows) {
    if (row.serviceId === serviceId) continue;
    if (!hostsCollide(row.hostname, hostname)) continue;
    let manageable = false;
    try {
      // Admins pass; a member passes only for a service they can WRITE to.
      const holder = await loadServiceForUser(app.db, row.serviceId, user);
      await assertServiceRole(app.db, holder, user, 'member');
      manageable = true;
    } catch {
      /* foreign, viewer-only, or orphaned — decided below */
    }
    if (manageable) continue;
    if (row.status === 'pending') {
      unverified.push(row);
      continue;
    }
    // Same 409 whether the holder exists-but-is-foreign or the row is
    // orphaned — the caller learns only that the host is taken.
    throw conflict('That hostname is already routed by another service');
  }
  return unverified;
}

/**
 * r633: a `redirectWww` domain routes — and orders a certificate for — its
 * companion host as well (`www.` form of an apex, apex of a `www.` host), so
 * the companion has to pass the same claim rules as the hostname itself. It
 * used to ride along unchecked: another tenant's host, a reserved automatic
 * domain or the panel's own name could be pulled in through the toggle.
 * Unlike the hostname, an unverified foreign claim on the companion is not
 * taken over here — the redirect waits for it to be removed or expire.
 */
async function assertCompanionClaimable(
  app: AppInstance,
  hostname: string,
  serviceId: number,
  user: RequestUser,
): Promise<void> {
  const companion = wwwCompanionHost(hostname);
  if (!companion) return;
  const refuse = (why: string) =>
    conflict(`The www redirect also routes ${companion}, and ${why}. Turn the www redirect off for this domain.`);
  let unverified: Domain[];
  try {
    unverified = await assertHostnameClaimable(app, companion, serviceId, user);
  } catch (err) {
    throw refuse(err instanceof Error ? err.message.replace(/^That hostname/, 'that hostname') : 'it is taken');
  }
  if (unverified.length > 0) throw refuse('another service has a claim on it awaiting verification');
  if (!user.isOperator) {
    const zoneRefusal = await ownZoneClaimRefusal(app.db, serviceId, companion);
    if (zoneRefusal) throw refuse(`it ${zoneRefusal}`);
  }
}

/**
 * r633: the companion a www-stored domain's own TXT proof does not cover must
 * be proved with the SAME challenge value at its own record name. Null when
 * proved (or nothing needs proving), else what to tell the caller.
 */
async function companionProofError(
  hostname: string,
  token: string,
  isOperator: boolean,
): Promise<{ error: string; found: string[] } | null> {
  const outside = companionOutsideProof(hostname);
  if (!outside || !requiresOwnershipProof(outside, isOperator)) return null;
  const result = await checkOwnershipRecord(outside, token);
  if (result.ok) return null;
  return {
    error: `The www redirect also routes ${outside}, which the record for ${hostname} does not prove you control: publish the same TXT value at ${challengeRecordName(outside)} too, or turn the www redirect off.`,
    found: result.found,
  };
}

/** `showAuth` false hides Basic Auth from a viewer seat; it is never shown as plaintext (r636). */
function serialize(d: Domain, showAuth = true) {
  return {
    id: d.id,
    serviceId: d.serviceId,
    hostname: d.hostname,
    path: d.path,
    ssl: d.ssl,
    redirectWww: d.redirectWww,
    headers: d.headers ?? '[]',
    basicAuth: showAuth ? basicAuthForDisplay(d.basicAuth) : null,
    ipAllowlist: d.ipAllowlist ?? null,
    rateLimitAverage: d.rateLimitAverage ?? null,
    rateLimitBurst: d.rateLimitBurst ?? null,
    status: d.status,
    verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/**
 * Ensure the companion www/apex record exists in the provider zone. A www
 * redirect routes (and requests a certificate for) the companion host too —
 * without DNS pointing here, that certificate can never issue. Idempotent: a
 * zone that already has a record for the host — created manually or by an
 * earlier toggle — is left alone rather than gaining a duplicate.
 */
async function ensureCompanionRecord(token: string, hostname: string, content: string): Promise<void> {
  const companion = wwwCompanionHost(hostname);
  if (!companion) return;
  const existing = await listDnsRecordsByName(token, companion);
  if (existing.length === 0) await createDnsRecord(token, companion, content);
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
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // r636: Basic Auth credentials are for the people who can change them —
    // a viewer seat reads the routing, not the password hashes.
    const role = await serviceRole(app.db, svc, req.user!);
    const showAuth = role !== null && roleAtLeast(role, 'member');
    const rows = await app.db.query.domains.findMany({ where: eq(domains.serviceId, id) });
    return rows.map((d) => serialize(d, showAuth));
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
    // r630: only the exact shape the proxy renders verbatim may be stored —
    // every check below compares this string, and Traefik must route it.
    if (!isRoutableHostname(hostname)) throw badRequest(unroutableHostnameMessage(hostname));
    const user = req.user!;
    const policy = await getDomainPolicy(app.db);
    if (!user.isOperator) {
      // r634: own-zone names cost no proof, so they are capped per service,
      // and every add (deleted ones included) counts against an hourly rate.
      const cap = await domainCapRefusal(app.db, policy, id, hostname, user.id);
      if (cap) throw new HttpError(cap.status, cap.status === 429 ? 'rate_limited' : 'conflict', cap.message);
    }
    const unverified = await assertHostnameClaimable(app, hostname, id, user);
    if (!user.isOperator) {
      const refusal = await ownZoneClaimRefusal(app.db, id, hostname);
      if (refusal) throw conflict(`${hostname} ${refusal}`);
    }
    if (input.redirectWww) await assertCompanionClaimable(app, hostname, id, user);

    // H-2 layer 2: a hostname outside this instance's own zone is not routed
    // until its owner proves control of the DNS zone. Until then the row is
    // `pending`, and `writeDynamicConfig` skips it — so a first-come claim on
    // someone else's domain never receives their traffic.
    let needsProof = requiresOwnershipProof(hostname, user.isOperator);
    let verificationToken = needsProof ? newChallengeToken() : null;

    // r635: the hostname is held only by other services' UNVERIFIED rows. A
    // claimant who proves the zone (a TXT value bound to this service and
    // host) replaces them and goes live at once; anyone else is told how.
    if (unverified.length > 0) {
      const token = pendingTakeoverToken(id, hostname);
      const proof = await checkOwnershipRecord(hostname, token);
      if (!proof.ok) {
        const expiry =
          policy.pendingExpiryDays > 0 ? ` Unverified claims are removed after ${policy.pendingExpiryDays} days.` : '';
        throw conflict(
          `That hostname is claimed by another service but not verified yet. A verified claim replaces an unverified one: if you control ${hostname}, publish a TXT record at ${challengeRecordName(hostname)} with the value "${token}" and add the domain again.${expiry}`,
        );
      }
      if (input.redirectWww) {
        const companion = await companionProofError(hostname, token, user.isOperator);
        if (companion) throw conflict(companion.error);
      }
      for (const row of unverified) {
        await app.db.delete(domains).where(eq(domains.id, row.id));
        void audit(app.db, user.id, 'domain.pending_evicted', row.hostname, {
          domainId: row.id,
          serviceId: row.serviceId,
          claimantServiceId: id,
        });
      }
      needsProof = false;
      verificationToken = token;
    }

    const [d] = await app.db
      .insert(domains)
      .values({
        serviceId: id,
        hostname,
        path: input.path,
        ssl: input.ssl,
        redirectWww: input.redirectWww ?? false,
        headers: input.headers ?? null,
        // r636: Traefik only accepts hashed htpasswd secrets.
        basicAuth: basicAuthForStorage(input.basicAuth),
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
        if (input.redirectWww) await ensureCompanionRecord(dnsCfg.token, hostname, content);
      } catch (err) {
        dnsWarning = err instanceof Error ? err.message : String(err);
      }
    }
    await writeDynamicConfig(app.db);
    void audit(
      app.db,
      user.id,
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
    // r633: going live also routes the www companion — an apex the host's own
    // record does not prove needs the same value at its own name.
    if (d.redirectWww) {
      const companion = await companionProofError(d.hostname, d.verificationToken, req.user!.isOperator);
      if (companion) return { ...serialize(d), verified: false, ...companion, verification: challengeFor(d) };
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
        // A redirectWww domain routes (and orders a certificate for) its
        // companion host too — the record must exist the moment the domain
        // goes active, not only when the toggle is (re-)saved.
        if (updated.redirectWww) await ensureCompanionRecord(dnsCfg.token, updated.hostname, content);
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
    const current = await app.db.query.domains.findFirst({
      where: and(eq(domains.id, domainId), eq(domains.serviceId, id)),
    });
    if (!current) throw notFound('Domain not found');
    // r633: switching the www redirect ON adds the companion host to routing
    // and ACME — it must pass the claim rules, and an apex outside the
    // domain's proof must be proved with the same challenge value. Only the
    // off→on transition is checked: a redirect that already routes keeps
    // working across re-saves.
    if (input.redirectWww === true && !current.redirectWww) {
      await assertCompanionClaimable(app, current.hostname, id, req.user!);
      const outside = current.status === 'active' ? companionOutsideProof(current.hostname) : null;
      if (outside && requiresOwnershipProof(outside, req.user!.isOperator)) {
        if (!current.verificationToken) {
          throw conflict(
            `The www redirect also routes ${outside}, and there is no proof you control it. Add ${outside} as a domain of its own and verify it, or ask an operator to turn the redirect on.`,
          );
        }
        if (await companionProofError(current.hostname, current.verificationToken, req.user!.isOperator)) {
          throw conflict(
            `The www redirect also routes ${outside}: publish a TXT record at ${challengeRecordName(outside)} with the value "${current.verificationToken}" (the value that verified ${current.hostname}), then turn the redirect on again.`,
          );
        }
      }
    }
    // Validate early so a malformed headers array never reaches Traefik.
    const values: Partial<typeof domains.$inferInsert> = {};
    if (input.ssl !== undefined) values.ssl = input.ssl;
    if (input.redirectWww !== undefined) values.redirectWww = input.redirectWww;
    if (input.headers !== undefined) {
      const parsed = parseHeaders(input.headers);
      values.headers = JSON.stringify(parsed);
    }
    // r636: hash on write; already-hashed entries (what GET shows) are kept.
    if (input.basicAuth !== undefined) values.basicAuth = basicAuthForStorage(input.basicAuth);
    if (input.ipAllowlist !== undefined) values.ipAllowlist = input.ipAllowlist;
    if (input.rateLimitAverage !== undefined) values.rateLimitAverage = input.rateLimitAverage;
    if (input.rateLimitBurst !== undefined) values.rateLimitBurst = input.rateLimitBurst;
    const [d] = await app.db
      .update(domains)
      .set(values)
      .where(and(eq(domains.id, domainId), eq(domains.serviceId, id)))
      .returning();
    if (!d) throw notFound('Domain not found');
    // A patch that leaves redirectWww ON adds the companion host to routing
    // and to ACME — it needs a DNS record like the stored hostname has one.
    // `ensureCompanionRecord` is idempotent (a zone record that already exists
    // is left alone), so no-op re-saves cost only one provider list call.
    // Best effort like every provider interaction: the toggle itself must not
    // fail over DNS, the warning rides along on the response instead.
    let dnsWarning: string | null = null;
    if (input.redirectWww === true && d.status === 'active') {
      const dnsCfg = await getDnsRecordsConfig(app.db);
      if (dnsCfg.enabled && dnsCfg.token) {
        try {
          await ensureCompanionRecord(dnsCfg.token, d.hostname, dnsCfg.content || (await detectPublicIp()));
        } catch (err) {
          dnsWarning = err instanceof Error ? err.message : String(err);
        }
      }
    }
    await writeDynamicConfig(app.db);
    void audit(app.db, req.user!.id, 'domain.update', d.hostname);
    return dnsWarning ? { ...serialize(d), dnsWarning } : serialize(d);
  });

  app.delete('/:id/domains/:domainId', async (req) => {
    const id = num((req.params as { id: string }).id);
    const domainId = num((req.params as { domainId: string }).domainId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const existing = await app.db.query.domains.findFirst({
      where: and(eq(domains.id, domainId), eq(domains.serviceId, id)),
    });
    // r691: another service's domain id (or none) answered 200, rewrote the
    // proxy config and audited `domain.delete #<id>` — for a domain the caller
    // never touched. A miss is a 404 now, before any side effect.
    if (!existing) throw notFound('Domain not found');
    await app.db.delete(domains).where(and(eq(domains.id, domainId), eq(domains.serviceId, id)));
    // Remove the provider DNS record (best-effort — a stale record only points
    // at the server, it no longer routes anywhere once Traefik rewrites).
    if (existing.dnsRecordId) {
      const dnsCfg = await getDnsRecordsConfig(app.db);
      if (dnsCfg.enabled && dnsCfg.token) {
        await deleteDnsRecord(dnsCfg.token, existing.hostname, existing.dnsRecordId).catch(() => undefined);
      }
    }
    await writeDynamicConfig(app.db);
    void audit(app.db, req.user!.id, 'domain.delete', existing.hostname);
    return { ok: true };
  });
};
