import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, createFakeDb, domainRow, svcRow } from './helpers.js';
import { challengeRecordName, isOwnZone, requiresOwnershipProof } from '../src/lib/domainVerification.js';

/**
 * H-2, second layer: a hostname does not route until its claimant proves
 * control of the DNS zone.
 *
 * The create-time check (`domainHijack.test.ts`) settles contests between two
 * tenants of THIS instance. It cannot settle the first claim — whoever asks
 * first gets `app.victim.com`, and that router starts serving as soon as the
 * victim's DNS points here, or immediately for anyone who can set the Host
 * header themselves. Requests, cookies and Authorization headers for a domain
 * the claimant does not own would land in their container.
 */

const dnsMocks = vi.hoisted(() => ({ resolveTxt: vi.fn(async () => [] as string[][]) }));
vi.mock('node:dns/promises', () => dnsMocks);

const proxyMocks = vi.hoisted(() => ({ writeDynamicConfig: vi.fn(async () => undefined) }));
vi.mock('../src/engine/proxy.js', () => ({ ...proxyMocks, parseHeaders: () => [] }));

vi.mock('../src/lib/cloudflare.js', () => ({
  getDnsRecordsConfig: vi.fn(async () => ({ enabled: false, token: null, content: null })),
  createDnsRecord: vi.fn(async () => 'rec-1'),
  deleteDnsRecord: vi.fn(async () => undefined),
  detectPublicIp: vi.fn(async () => '203.0.113.5'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    wildcardDomain: 'apps.ninedeploy.test',
    publicUrl: 'https://panel.ninedeploy.test',
    isProd: false,
    paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
    jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
    port: 3000,
  },
}));

const { domainsRoutes } = await import('../src/modules/domains.js');

const MEMBER = 7;
const member = () => asUser({ id: MEMBER, isOperator: false });
const admin = () => asUser({ id: 1, isOperator: true });

beforeEach(() => {
  vi.clearAllMocks();
  dnsMocks.resolveTxt.mockResolvedValue([]);
});

/** Caller owns service 1; no other domain rows exist. */
async function app(over: Record<string, unknown> = {}) {
  const inserted: Record<string, unknown>[] = [];
  const a = await buildTestApp({
    db: createFakeDb({
      findFirst: { services: svcRow({ id: 1, ownerUserId: MEMBER }) },
      findMany: { domains: [] },
      select: { domains: [] },
      insert: {
        domains: (v: Record<string, unknown>) => {
          inserted.push(v);
          return [domainRow({ id: 5, serviceId: 1, ...v })];
        },
      },
      ...over,
    }),
  });
  await a.register(domainsRoutes);
  return { a, inserted };
}

describe('which claims need proof', () => {
  it('recognises the instance own zones', () => {
    expect(isOwnZone('web-1.apps.ninedeploy.test')).toBe(true);
    expect(isOwnZone('panel.ninedeploy.test')).toBe(true);
    expect(isOwnZone('APPS.NINEDEPLOY.TEST')).toBe(true);
    expect(isOwnZone('app.victim.com')).toBe(false);
    // not a suffix trick: "evilninedeploy.test" must not pass as own zone
    expect(isOwnZone('evilapps.ninedeploy.test.attacker.com')).toBe(false);
  });

  it('asks a member for proof only outside those zones', () => {
    expect(requiresOwnershipProof('app.victim.com', false)).toBe(true);
    expect(requiresOwnershipProof('web-1.apps.ninedeploy.test', false)).toBe(false);
  });

  it('exempts the instance operator', () => {
    expect(requiresOwnershipProof('app.victim.com', true)).toBe(false);
  });

  it('proves a wildcard claim on its base zone', () => {
    expect(challengeRecordName('*.victim.com')).toBe('_ninedeploy-challenge.victim.com');
    expect(challengeRecordName('app.victim.com')).toBe('_ninedeploy-challenge.app.victim.com');
  });
});

describe('claiming someone else’s hostname', () => {
  it('creates the row PENDING and hands back the challenge', async () => {
    const { a, inserted } = await app();
    const res = await a.inject({
      method: 'POST', url: '/1/domains', headers: member(),
      payload: { hostname: 'app.victim.com', path: '/', ssl: true },
    });
    expect(res.statusCode).toBe(200);
    expect(inserted[0]).toMatchObject({ status: 'pending' });
    expect(String(inserted[0]!['verificationToken'])).toMatch(/^nd-verify-[0-9a-f]{32}$/);
    expect(res.json().verification).toMatchObject({
      recordName: '_ninedeploy-challenge.app.victim.com',
      recordType: 'TXT',
    });
  });

  it('does not create a DNS provider record for an unproven claim', async () => {
    const { createDnsRecord, getDnsRecordsConfig } = await import('../src/lib/cloudflare.js');
    vi.mocked(getDnsRecordsConfig).mockResolvedValue({ enabled: true, token: 'cf', content: '203.0.113.5' } as never);
    const { a } = await app();
    await a.inject({
      method: 'POST', url: '/1/domains', headers: member(),
      payload: { hostname: 'app.victim.com', path: '/', ssl: true },
    });
    expect(createDnsRecord).not.toHaveBeenCalled();
  });

  it('routes immediately inside the instance own zone', async () => {
    const { a, inserted } = await app();
    const res = await a.inject({
      method: 'POST', url: '/1/domains', headers: member(),
      payload: { hostname: 'web-1.apps.ninedeploy.test', path: '/', ssl: true },
    });
    expect(res.statusCode).toBe(200);
    expect(inserted[0]).toMatchObject({ status: 'active' });
    expect(res.json().verification).toBeNull();
  });

  it('routes immediately for an admin', async () => {
    const { a, inserted } = await app({ findFirst: { services: svcRow({ id: 1, ownerUserId: 1 }) } });
    const res = await a.inject({
      method: 'POST', url: '/1/domains', headers: admin(),
      payload: { hostname: 'app.victim.com', path: '/', ssl: true },
    });
    expect(res.statusCode).toBe(200);
    expect(inserted[0]).toMatchObject({ status: 'active' });
  });
});

describe('POST /:id/domains/:domainId/verify', () => {
  async function verifyApp(domain: Record<string, unknown>) {
    const updated: Record<string, unknown>[] = [];
    const a = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, ownerUserId: MEMBER }),
          domains: domainRow({ id: 5, serviceId: 1, hostname: 'app.victim.com', ...domain }),
        },
        update: {
          domains: (v: Record<string, unknown>) => {
            updated.push(v);
            return [domainRow({ id: 5, serviceId: 1, hostname: 'app.victim.com', ...domain, ...v })];
          },
        },
      }),
    });
    await a.register(domainsRoutes);
    return { a, updated };
  }

  const pending = { status: 'pending', verificationToken: 'nd-verify-abc', verifiedAt: null };

  it('stays pending when the TXT record is absent', async () => {
    dnsMocks.resolveTxt.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    const { a, updated } = await verifyApp(pending);
    const res = await a.inject({ method: 'POST', url: '/1/domains/5/verify', headers: member() });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(false);
    expect(res.json().error).toMatch(/No TXT record found/);
    expect(updated).toHaveLength(0);
    expect(proxyMocks.writeDynamicConfig).not.toHaveBeenCalled();
  });

  it('stays pending when the TXT record holds a different value', async () => {
    dnsMocks.resolveTxt.mockResolvedValue([['nd-verify-somethingelse']]);
    const { a, updated } = await verifyApp(pending);
    const res = await a.inject({ method: 'POST', url: '/1/domains/5/verify', headers: member() });
    expect(res.json().verified).toBe(false);
    expect(updated).toHaveLength(0);
  });

  it('goes active when the record matches, including a chunked TXT value', async () => {
    dnsMocks.resolveTxt.mockResolvedValue([['unrelated'], ['nd-verify-', 'abc']]);
    const { a, updated } = await verifyApp(pending);
    const res = await a.inject({ method: 'POST', url: '/1/domains/5/verify', headers: member() });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
    expect(updated[0]).toMatchObject({ status: 'active' });
    expect(updated[0]!['verifiedAt']).toBeInstanceOf(Date);
    // only NOW is Traefik told about it
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('is idempotent once active', async () => {
    const { a, updated } = await verifyApp({ status: 'active', verificationToken: null });
    const res = await a.inject({ method: 'POST', url: '/1/domains/5/verify', headers: member() });
    expect(res.json().verified).toBe(true);
    expect(updated).toHaveLength(0);
    expect(dnsMocks.resolveTxt).not.toHaveBeenCalled();
  });
});

// The enforcement point itself — that `writeDynamicConfig` never describes a
// pending domain to Traefik — is covered in test/proxy.test.ts, which already
// has the filesystem harness for reading the generated dynamic.yml.

describe('r223: own-zone first-come claims', () => {
  /** services.findFirst: call 1 is the caller's service, later calls the slug lookup. */
  const servicesBySlug = (other: Record<string, unknown> | undefined) => {
    let calls = 0;
    return () => (++calls === 1 ? svcRow({ id: 1, ownerUserId: MEMBER }) : other);
  };

  it("refuses a member claiming another service's automatic domain", async () => {
    const { a, inserted } = await app({
      findFirst: { services: servicesBySlug(svcRow({ id: 2, name: 'billing', slug: 'billing', ownerUserId: 99 })) },
    });
    const res = await a.inject({
      method: 'POST', url: '/1/domains', headers: member(), payload: { hostname: 'billing.apps.ninedeploy.test' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/automatic domain of service "billing"/);
    expect(inserted).toHaveLength(0);
  });

  it('refuses a member wildcard on the instance zone', async () => {
    const { a, inserted } = await app({ findFirst: { services: servicesBySlug(undefined) } });
    const res = await a.inject({
      method: 'POST', url: '/1/domains', headers: member(), payload: { hostname: '*.apps.ninedeploy.test' },
    });
    expect(res.statusCode).toBe(409);
    expect(inserted).toHaveLength(0);
  });

  it('still lets a member take an unreserved own-zone name, and an operator anything', async () => {
    const free = await app({ findFirst: { services: servicesBySlug(undefined) } });
    const ok = await free.a.inject({
      method: 'POST', url: '/1/domains', headers: member(), payload: { hostname: 'fresh.apps.ninedeploy.test' },
    });
    expect(ok.statusCode).toBe(200);
    const op = await app({
      findFirst: { services: servicesBySlug(svcRow({ id: 2, name: 'billing', slug: 'billing' })) },
    });
    const opRes = await op.a.inject({
      method: 'POST', url: '/1/domains', headers: admin(), payload: { hostname: 'billing.apps.ninedeploy.test' },
    });
    expect(opRes.statusCode).toBe(200);
  });
});
