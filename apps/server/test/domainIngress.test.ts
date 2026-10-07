/**
 * Ingress hardening (0.10.42, r630–r637) against a REAL in-memory database
 * with the real migrations and the real domain routes.
 *
 * The claim rules live in the interaction between the stored hostname, the
 * role a caller holds on every service already routing it, the policy in the
 * settings table and what the proxy finally renders — a mocked db agrees with
 * any implementation of those. Only `writeDynamicConfig` (it writes the host's
 * Traefik file) and DNS lookups are stubbed; the render seam is exercised by
 * calling the real `renderDynamicConfig` on the same database.
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { load } from 'js-yaml';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  createDb,
  domains,
  serviceWorkspaces,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import { domainsRoutes } from '../src/modules/domains.js';
import { settingsRoutes } from '../src/modules/settings.js';
import { renderDynamicConfig } from '../src/engine/proxy.js';
import { applyManifestToService } from '../src/lib/applyManifestToService.js';
import { pruneExpiredPendingDomains } from '../src/plugins/housekeeping.js';
import { pendingTakeoverToken } from '../src/lib/domainVerification.js';
import { config } from '../src/config.js';
import { asUser, buildTestApp } from './helpers.js';

vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  // The real one writes the host's Traefik file and refreshes node proxies.
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const dns = vi.hoisted(() => ({ txt: new Map<string, string[]>() }));
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns/promises')>()),
  resolveTxt: vi.fn(async (name: string) => {
    const values = dns.txt.get(name);
    if (!values) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    return values.map((v) => [v]);
  }),
}));

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const ZONE = 'apps.example.com';
const OPERATOR = 1;
const ALICE = 7; // owns service "alpha"
const BOB = 8; // owns service "bravo"

let db: DB;
let alpha: number;
let bravo: number;
const savedZone = config.wildcardDomain;

const member = (id: number) => asUser({ id, isOperator: false });
const operator = () => asUser({ id: OPERATOR, isOperator: true });

async function app() {
  const a = await buildTestApp({ db });
  await a.register(domainsRoutes);
  await a.register(settingsRoutes, { prefix: '/settings' });
  return a;
}

async function addDomain(
  a: Awaited<ReturnType<typeof app>>,
  serviceId: number,
  payload: Record<string, unknown>,
  headers = member(ALICE),
) {
  return a.inject({ method: 'POST', url: `/${serviceId}/domains`, headers, payload: { path: '/', ...payload } });
}

async function row(hostname: string) {
  return db.query.domains.findFirst({ where: eq(domains.hostname, hostname) });
}

async function auditActions(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action));
}

/** Let the fire-and-forget audit() inserts land. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([
    { id: OPERATOR, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: ALICE, email: 'alice@example.com', passwordHash: 'x' },
    { id: BOB, email: 'bob@example.com', passwordHash: 'x' },
  ]);
  const [a] = await db
    .insert(services)
    .values({ name: 'alpha', slug: 'alpha', type: 'docker', port: 3000, runtimeId: 'nd-alpha', ownerUserId: ALICE })
    .returning();
  const [b] = await db
    .insert(services)
    .values({ name: 'bravo', slug: 'bravo', type: 'docker', port: 3000, runtimeId: 'nd-bravo', ownerUserId: BOB })
    .returning();
  alpha = a!.id;
  bravo = b!.id;
  config.wildcardDomain = ZONE;
  dns.txt.clear();
});

afterAll(() => {
  config.wildcardDomain = savedZone;
});

// ── r630 (I1) ────────────────────────────────────────────────────────────────
describe('r630: hostnames are validated at the boundary and re-checked at render', () => {
  it('refuses a hostname the proxy would have rewritten into a catch-all', async () => {
    const a = await app();
    const res = await addDomain(a, alpha, { hostname: '*_.apps.example.com' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not a valid hostname/);
    expect(await row('*_.apps.example.com')).toBeUndefined();
  });

  it('refuses a hostname that renders as somebody else’s', async () => {
    const a = await app();
    for (const hostname of ['vic_tim.apps.example.com', 'bravo .apps.example.com', 'a`b.example.com', '-lead.example.com']) {
      const res = await addDomain(a, alpha, { hostname, path: '/x' });
      expect(res.statusCode, hostname).toBe(400);
    }
  });

  it('accepts every legitimate shape: case-folded, IDN punycode (typed either way), wildcard, own zone', async () => {
    const a = await app();
    const cases: Array<[string, string, Record<string, string>]> = [
      ['Shop.Example.COM', 'shop.example.com', member(ALICE)],
      ['bücher.example', 'xn--bcher-kva.example', member(ALICE)],
      ['xn--mnchen-3ya.example', 'xn--mnchen-3ya.example', member(ALICE)],
      ['my-app.apps.example.com', 'my-app.apps.example.com', member(ALICE)],
      ['*.customer.example.net', '*.customer.example.net', operator()],
    ];
    for (const [input, stored, headers] of cases) {
      const res = await addDomain(a, alpha, { hostname: input }, headers);
      expect(res.statusCode, input).toBe(200);
      expect(res.json().hostname).toBe(stored);
    }
    expect((await row('my-app.apps.example.com'))?.status).toBe('active');
  });

  it('skips and audits a legacy row stored before validation; the rest of the file still renders', async () => {
    await db.insert(domains).values([
      { serviceId: alpha, hostname: '*_.apps.example.com', path: '/', ssl: false, status: 'active' },
      { serviceId: bravo, hostname: 'bravo.apps.example.com', path: '/', ssl: false, status: 'active' },
    ]);
    const yaml = await renderDynamicConfig(db, { serverId: null });
    expect(yaml).toContain('Host(`bravo.apps.example.com`)');
    expect(yaml).not.toContain('HostRegexp');
    expect(yaml).not.toContain('*.apps.example.com');
    expect(() => load(yaml)).not.toThrow();
    await settle();
    const audits = await auditActions('domain.render_skipped');
    expect(audits.map((r) => r.entity)).toEqual(['*_.apps.example.com']);
    // Once per process, not once per render.
    await renderDynamicConfig(db, { serverId: null });
    await settle();
    expect(await auditActions('domain.render_skipped')).toHaveLength(1);
  });
});

// ── r632 (I3) ────────────────────────────────────────────────────────────────
describe('r632: a viewer seat on the holder is not enough to share its hostname', () => {
  async function seat(role: 'viewer' | 'member') {
    const [ws] = await db.insert(workspaces).values({ name: 'team', slug: 'team', ownerId: BOB }).returning();
    await db.insert(serviceWorkspaces).values({ serviceId: bravo, workspaceId: ws!.id });
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: ALICE, role });
    await db.insert(domains).values({ serviceId: bravo, hostname: 'shop.example.org', path: '/', status: 'active' });
  }

  it('refuses a longer-rule route on a host held by a service the caller only views', async () => {
    await seat('viewer');
    const res = await addDomain(await app(), alpha, { hostname: 'shop.example.org', path: '/api' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('That hostname is already routed by another service');
  });

  it('still lets a member of the holder share the host on another path', async () => {
    await seat('member');
    const res = await addDomain(await app(), alpha, { hostname: 'shop.example.org', path: '/api' });
    expect(res.statusCode).toBe(200);
  });
});

// ── r633 (I4) ────────────────────────────────────────────────────────────────
describe('r633: the www companion passes the same claim rules as the host', () => {
  it("refuses a redirect whose companion is another service's automatic domain", async () => {
    const res = await addDomain(await app(), alpha, { hostname: 'www.bravo.apps.example.com', redirectWww: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/also routes bravo\.apps\.example\.com/);
    // Without the redirect the www name itself is an ordinary own-zone claim.
    expect((await addDomain(await app(), alpha, { hostname: 'www.bravo.apps.example.com' })).statusCode).toBe(200);
  });

  it("refuses a redirect (create or toggle) whose companion another service routes", async () => {
    await db.insert(domains).values({ serviceId: bravo, hostname: 'www.shop.apps.example.com', path: '/', status: 'active' });
    const a = await app();
    expect((await addDomain(a, alpha, { hostname: 'shop.apps.example.com', redirectWww: true })).statusCode).toBe(409);

    const created = await addDomain(a, alpha, { hostname: 'shop.apps.example.com' });
    expect(created.statusCode).toBe(200);
    const toggle = await a.inject({
      method: 'PATCH',
      url: `/${alpha}/domains/${created.json().id}`,
      headers: member(ALICE),
      payload: { redirectWww: true },
    });
    expect(toggle.statusCode).toBe(409);
    expect((await row('shop.apps.example.com'))?.redirectWww).toBe(false);
  });

  it('a www host goes live with its redirect only once the apex is proved too', async () => {
    const a = await app();
    const created = await addDomain(a, alpha, { hostname: 'www.example.org', redirectWww: true });
    expect(created.statusCode).toBe(200);
    const token = created.json().verification.recordValue as string;
    dns.txt.set('_ninedeploy-challenge.www.example.org', [token]);
    const verify = () => a.inject({ method: 'POST', url: `/${alpha}/domains/${created.json().id}/verify`, headers: member(ALICE) });

    const first = await verify();
    expect(first.json().verified).toBe(false);
    expect(first.json().error).toMatch(/_ninedeploy-challenge\.example\.org/);
    expect((await row('www.example.org'))?.status).toBe('pending');

    dns.txt.set('_ninedeploy-challenge.example.org', [token]);
    expect((await verify()).json().verified).toBe(true);
  });

  it('the proxy never extends a pair over another service’s claim, even a pending one', async () => {
    await db.insert(domains).values([
      { serviceId: alpha, hostname: 'example.net', path: '/', ssl: false, redirectWww: true, status: 'active' },
      { serviceId: bravo, hostname: 'www.example.net', path: '/', ssl: false, status: 'pending' },
    ]);
    const yaml = await renderDynamicConfig(db, { serverId: null });
    expect(yaml).toContain('rule: "Host(`example.net`)"');
    expect(yaml).not.toContain('www.example.net');
  });

  // F156: the reverse direction — an ACTIVE redirect routes its companion, so
  // that host is held as much as the stored one. Only the stored hostname used
  // to be compared: a pending foreign claim on the companion made the proxy
  // drop the holder's www route, and an own-zone one went live and took it.
  it("refuses a claim on the companion another service's active redirect routes; the pair stays", async () => {
    await db.insert(domains).values({ serviceId: alpha, hostname: 'example.net', path: '/', ssl: false, redirectWww: true, status: 'active' });
    const res = await addDomain(await app(), bravo, { hostname: 'www.example.net', ssl: false }, member(BOB));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already routed by another service/);
    expect(await renderDynamicConfig(db, { serverId: null })).toContain('Host(`example.net`) || Host(`www.example.net`)');
  });

  it('refuses an own-zone claim on such a companion — nothing goes live for the claimant', async () => {
    await db.insert(domains).values({ serviceId: alpha, hostname: 'shop.apps.example.com', path: '/', ssl: false, redirectWww: true, status: 'active' });
    const res = await addDomain(await app(), bravo, { hostname: 'www.shop.apps.example.com', ssl: false }, member(BOB));
    expect(res.statusCode).toBe(409);
    expect(await db.query.domains.findFirst({ where: eq(domains.serviceId, bravo) })).toBeUndefined();
  });

  it('a PENDING redirect row holds no companion and is not evicted by a claim on it', async () => {
    await db.insert(domains).values({ serviceId: alpha, hostname: 'example.net', path: '/', ssl: false, redirectWww: true, status: 'pending' });
    const res = await addDomain(await app(), bravo, { hostname: 'www.example.net', ssl: false }, member(BOB));
    expect(res.statusCode).toBe(200);
    expect((await row('example.net'))?.status).toBe('pending');
  });
});

// ── r634 (I5) ────────────────────────────────────────────────────────────────
describe('r634: own-zone domains are capped and adds are rate limited (operators exempt)', () => {
  async function setPolicy(a: Awaited<ReturnType<typeof app>>, policy: Record<string, number>) {
    const res = await a.inject({ method: 'PUT', url: '/settings/domain-policy', headers: operator(), payload: policy });
    expect(res.statusCode).toBe(200);
  }

  it('ships generous defaults the operator can read and change', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/settings/domain-policy', headers: operator() });
    expect(res.json().policy).toEqual({ maxOwnZoneDomainsPerService: 50, maxDomainCreatesPerHour: 30, pendingExpiryDays: 30 });
    await setPolicy(a, { maxOwnZoneDomainsPerService: 5 });
    const after = await a.inject({ method: 'GET', url: '/settings/domain-policy', headers: operator() });
    expect(after.json().policy).toMatchObject({ maxOwnZoneDomainsPerService: 5, maxDomainCreatesPerHour: 30 });
    // Members cannot touch it.
    expect((await a.inject({ method: 'PUT', url: '/settings/domain-policy', headers: member(ALICE), payload: {} })).statusCode).toBe(403);
  });

  it('caps own-zone domains per service, never removing existing ones', async () => {
    const a = await app();
    await setPolicy(a, { maxOwnZoneDomainsPerService: 2 });
    expect((await addDomain(a, alpha, { hostname: 'one.apps.example.com' })).statusCode).toBe(200);
    expect((await addDomain(a, alpha, { hostname: 'two.apps.example.com' })).statusCode).toBe(200);
    const third = await addDomain(a, alpha, { hostname: 'three.apps.example.com' });
    expect(third.statusCode).toBe(409);
    expect(third.json().error.message).toMatch(/maxOwnZoneDomainsPerService/);
    // Outside the own zone the DNS proof is the throttle — no cap.
    expect((await addDomain(a, alpha, { hostname: 'shop.example.org' })).statusCode).toBe(200);
    // Operators are exempt.
    expect((await addDomain(a, alpha, { hostname: 'three.apps.example.com' }, operator())).statusCode).toBe(200);
    expect(await db.select().from(domains).where(eq(domains.serviceId, alpha))).toHaveLength(4);
  });

  it('rate-limits adds per account, counting deleted ones', async () => {
    const a = await app();
    await setPolicy(a, { maxDomainCreatesPerHour: 2 });
    const first = await addDomain(a, alpha, { hostname: 'one.apps.example.com' });
    await a.inject({ method: 'DELETE', url: `/${alpha}/domains/${first.json().id}`, headers: member(ALICE) });
    await settle();
    expect((await addDomain(a, alpha, { hostname: 'two.apps.example.com' })).statusCode).toBe(200);
    await settle();
    const third = await addDomain(a, alpha, { hostname: 'three.apps.example.com' });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('rate_limited');
    expect((await addDomain(a, alpha, { hostname: 'three.apps.example.com' }, operator())).statusCode).toBe(200);
  });

  it('holds manifest routes to the same per-service cap', async () => {
    const a = await app();
    await setPolicy(a, { maxOwnZoneDomainsPerService: 1 });
    const result = await applyManifestToService(db, alpha, {
      version: '1',
      routes: [
        { host: 'one.apps.example.com', path: '/', ssl: true },
        { host: 'two.apps.example.com', path: '/', ssl: true },
      ],
    } as never);
    expect(result.routesUpserted).toBe(1);
    expect(result.warnings.join('\n')).toMatch(/two\.apps\.example\.com\/ skipped/);
  });
});

// ── r635 (I6) ────────────────────────────────────────────────────────────────
describe('r635: an unverified claim cannot squat a hostname forever', () => {
  it('a claimant who proves the zone replaces another service’s pending row', async () => {
    await db.insert(domains).values({
      serviceId: bravo,
      hostname: 'victim.example.org',
      path: '/',
      status: 'pending',
      verificationToken: 'nd-verify-squatter',
    });
    const a = await app();
    const refused = await addDomain(a, alpha, { hostname: 'victim.example.org' });
    expect(refused.statusCode).toBe(409);
    const token = pendingTakeoverToken(alpha, 'victim.example.org');
    expect(refused.json().error.message).toContain(token);
    expect(refused.json().error.message).toContain('_ninedeploy-challenge.victim.example.org');

    dns.txt.set('_ninedeploy-challenge.victim.example.org', [token]);
    const taken = await addDomain(a, alpha, { hostname: 'victim.example.org' });
    expect(taken.statusCode).toBe(200);
    expect(taken.json().status).toBe('active');
    const rows = await db.select().from(domains).where(eq(domains.hostname, 'victim.example.org'));
    expect(rows.map((r) => r.serviceId)).toEqual([alpha]);
    await settle();
    expect((await auditActions('domain.pending_evicted'))[0]?.entity).toBe('victim.example.org');
  });

  it('a VERIFIED foreign row is never taken over', async () => {
    await db.insert(domains).values({ serviceId: bravo, hostname: 'victim.example.org', path: '/', status: 'active' });
    dns.txt.set('_ninedeploy-challenge.victim.example.org', [pendingTakeoverToken(alpha, 'victim.example.org')]);
    const res = await addDomain(await app(), alpha, { hostname: 'victim.example.org' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('That hostname is already routed by another service');
  });

  it('housekeeping expires pending rows past the policy window and audits each', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await db.insert(domains).values([
      { serviceId: bravo, hostname: 'stale.example.org', path: '/', status: 'pending', createdAt: old },
      { serviceId: bravo, hostname: 'fresh.example.org', path: '/', status: 'pending' },
      { serviceId: bravo, hostname: 'live.example.org', path: '/', status: 'active', createdAt: old },
    ]);
    expect(await pruneExpiredPendingDomains(db)).toBe(1);
    const left = (await db.select().from(domains)).map((r) => r.hostname).sort();
    expect(left).toEqual(['fresh.example.org', 'live.example.org']);
    await settle();
    expect((await auditActions('domain.pending_expired')).map((r) => r.entity)).toEqual(['stale.example.org']);
  });
});

// ── r636 (I7) ────────────────────────────────────────────────────────────────
describe('r636: Basic Auth is stored hashed and never shown as plaintext', () => {
  it('hashes on create and on patch; a round-trip of the shown value is byte-stable', async () => {
    const a = await app();
    const created = await addDomain(a, alpha, { hostname: 'auth.apps.example.com', basicAuth: 'admin:s3cret' });
    expect(created.statusCode).toBe(200);
    const stored = (await row('auth.apps.example.com'))!.basicAuth!;
    expect(stored).not.toContain('s3cret');
    expect(JSON.parse(stored)).toEqual([expect.stringMatching(/^admin:\$apr1\$[./0-9A-Za-z]{8}\$[./0-9A-Za-z]{22}$/)]);
    expect(created.json().basicAuth).toBe(stored);

    const patched = await a.inject({
      method: 'PATCH',
      url: `/${alpha}/domains/${created.json().id}`,
      headers: member(ALICE),
      payload: { basicAuth: created.json().basicAuth, ipAllowlist: '10.0.0.0/8' },
    });
    expect(patched.statusCode).toBe(200);
    expect((await row('auth.apps.example.com'))!.basicAuth).toBe(stored);
  });

  it('shows a legacy plaintext row hashed (as rendered) to members and not at all to viewers', async () => {
    await db.insert(domains).values({
      serviceId: bravo,
      hostname: 'legacy.example.org',
      path: '/',
      status: 'active',
      basicAuth: '["bob:hunter2"]',
    });
    const [ws] = await db.insert(workspaces).values({ name: 'team', slug: 'team', ownerId: BOB }).returning();
    await db.insert(serviceWorkspaces).values({ serviceId: bravo, workspaceId: ws!.id });
    // r694: the creator's owner role rides on a seat where the service lives.
    await db.insert(workspaceMembers).values([
      { workspaceId: ws!.id, userId: BOB, role: 'owner' },
      { workspaceId: ws!.id, userId: ALICE, role: 'viewer' },
    ]);
    const a = await app();

    const asOwner = await a.inject({ method: 'GET', url: `/${bravo}/domains`, headers: member(BOB) });
    const shown = asOwner.json()[0].basicAuth as string;
    expect(shown).not.toContain('hunter2');
    const yaml = await renderDynamicConfig(db, { serverId: null });
    expect(yaml).toContain(JSON.parse(shown)[0]);
    expect(yaml).not.toContain('hunter2');

    const asViewer = await a.inject({ method: 'GET', url: `/${bravo}/domains`, headers: member(ALICE) });
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.json()[0].basicAuth).toBeNull();
    expect(asViewer.json()[0].hostname).toBe('legacy.example.org');
  });
});
