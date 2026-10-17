/**
 * 0.16.1 Automatic URLs (lib/autoUrl.ts) against a real migrated SQLite:
 * the upgrade default, the fresh-install sslip.io seed, the settings routes,
 * "Generate domain", and the own-zone reservation of each service's name.
 */
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, domains, servers, services, settings, users } from '@ninedeploy/db';

const cfg = vi.hoisted(() => ({
  config: {
    wildcardDomain: '',
    publicUrl: 'http://203.0.113.10:3000',
    isProd: false,
    paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
    jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
    port: 3000,
  },
}));
vi.mock('../src/config.js', () => cfg);

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);

const proxyMocks = vi.hoisted(() => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async (): Promise<string | null> => null),
}));
vi.mock('../src/engine/proxy.js', () => ({ ...proxyMocks, parseHeaders: () => [] }));

vi.mock('../src/lib/cloudflare.js', () => ({
  getDnsRecordsConfig: vi.fn(async () => ({ enabled: false, token: null, content: null })),
  createDnsRecord: vi.fn(async () => 'rec-1'),
  deleteDnsRecord: vi.fn(async () => undefined),
  listDnsRecordsByName: vi.fn(async () => []),
  detectPublicIp: vi.fn(async () => '198.51.100.7'),
}));

const autoUrl = await import('../src/lib/autoUrl.js');
const { isOwnZone, ownZoneClaimRefusal } = await import('../src/lib/domainVerification.js');
const { domainsRoutes } = await import('../src/modules/domains.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
const OWNER = 7;

beforeEach(async () => {
  vi.clearAllMocks();
  cfg.config.wildcardDomain = '';
  cfg.config.publicUrl = 'http://203.0.113.10:3000';
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([1, OWNER].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x' })));
  // Reset the module's in-memory copy to what this fresh database says.
  await autoUrl.getAutoUrlConfig(db);
});

afterEach(() => close());

async function addService(slug: string, over: Partial<typeof services.$inferInsert> = {}) {
  const [row] = await db.insert(services).values({ name: slug, slug, ownerUserId: OWNER, ...over }).returning();
  return row!;
}

describe('address checks', () => {
  it('tells public IPv4 addresses from private, CGNAT, loopback and link-local ones', () => {
    for (const ip of ['203.0.113.10', '8.8.8.8', '1.2.3.4']) expect(autoUrl.isPublicIpv4(ip)).toBe(true);
    for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.2', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '1.2.3', 'x.y.z.w'])
      expect(autoUrl.isPublicIpv4(ip)).toBe(false);
  });
});

describe('upgrade default', () => {
  it('is off without a setting row: no automatic host, no extra own zone', async () => {
    const svc = await addService('api');
    expect(await autoUrl.getAutoUrlConfig(db)).toMatchObject({ mode: 'off', source: 'setting' });
    expect(await autoUrl.autoHostFor(db, svc)).toBeNull();
    expect(autoUrl.autoUrlPreview('api')).toBeNull();
    expect(isOwnZone('api.203.0.113.10.sslip.io')).toBe(false);
  });

  it('keeps NINEDEPLOY_WILDCARD_DOMAIN in charge, over any setting', async () => {
    cfg.config.wildcardDomain = 'apps.example.com';
    await autoUrl.setAutoUrlConfig(db, { mode: 'sslip', ip: '203.0.113.10' });
    const svc = await addService('api');
    expect(await autoUrl.getAutoUrlConfig(db)).toMatchObject({ mode: 'domain', domain: 'apps.example.com', source: 'env' });
    expect(await autoUrl.autoHostFor(db, svc)).toEqual({ hostname: 'api.apps.example.com', ssl: 'acme' });
  });

  it('spells env-wildcard hosts exactly as before 0.16.1, so existing rows still match', async () => {
    cfg.config.wildcardDomain = 'Apps.Example.com';
    const svc = await addService('api');
    expect(await autoUrl.autoHostFor(db, svc)).toEqual({ hostname: 'api.Apps.Example.com', ssl: 'acme' });
    expect(autoUrl.autoUrlPreview('api')).toBe('api.Apps.Example.com');
  });
});

describe('fresh install seed', () => {
  it('turns on sslip.io when the installer recorded a public IPv4', async () => {
    await autoUrl.seedFreshInstallAutoUrl(db);
    expect(await autoUrl.getAutoUrlConfig(db)).toMatchObject({ mode: 'sslip', ip: '203.0.113.10' });
  });

  it('leaves a private address, a hostname, an existing choice or an existing service alone', async () => {
    cfg.config.publicUrl = 'http://10.0.0.4:3000';
    await autoUrl.seedFreshInstallAutoUrl(db);
    cfg.config.publicUrl = 'https://panel.example.com';
    await autoUrl.seedFreshInstallAutoUrl(db);
    expect(await db.query.settings.findFirst({ where: eq(settings.key, autoUrl.AUTO_URL_MODE_KEY) })).toBeUndefined();

    cfg.config.publicUrl = 'http://203.0.113.10:3000';
    await addService('existing');
    await autoUrl.seedFreshInstallAutoUrl(db);
    expect(await db.query.settings.findFirst({ where: eq(settings.key, autoUrl.AUTO_URL_MODE_KEY) })).toBeUndefined();

    await db.delete(services);
    await autoUrl.setAutoUrlConfig(db, { mode: 'off' });
    await autoUrl.seedFreshInstallAutoUrl(db);
    expect((await autoUrl.getAutoUrlConfig(db)).mode).toBe('off');
  });
});

describe('hostnames', () => {
  it('sslip.io: <slug>.<ip>.sslip.io on plain HTTP; a node uses its own address', async () => {
    await autoUrl.setAutoUrlConfig(db, { mode: 'sslip', ip: '203.0.113.10' });
    const panelSvc = await addService('web');
    expect(await autoUrl.autoHostFor(db, panelSvc)).toEqual({ hostname: 'web.203.0.113.10.sslip.io', ssl: false });

    const [ipNode] = await db.insert(servers).values({ name: 'n1', host: '198.51.100.20', tokenEncrypted: 'v1:x' }).returning();
    const [dnsNode] = await db.insert(servers).values({ name: 'n2', host: 'node2.example.com', tokenEncrypted: 'v1:x' }).returning();
    expect(await autoUrl.autoHostFor(db, await addService('on-ip', { serverId: ipNode!.id }))).toEqual({
      hostname: 'on-ip.198.51.100.20.sslip.io',
      ssl: false,
    });
    expect(await autoUrl.autoHostFor(db, await addService('on-dns', { serverId: dnsNode!.id }))).toBeNull();
  });

  it('domain mode: <slug>.<domain> with TLS when ACME is on; half-configured modes are off', async () => {
    await autoUrl.setAutoUrlConfig(db, { mode: 'domain', domain: '*.Apps.Example.com.' });
    expect(await autoUrl.autoHostFor(db, await addService('api'))).toEqual({ hostname: 'api.apps.example.com', ssl: 'acme' });
    await autoUrl.setAutoUrlConfig(db, { mode: 'domain', domain: '' });
    expect((await autoUrl.getAutoUrlConfig(db)).mode).toBe('off');
    await autoUrl.setAutoUrlConfig(db, { mode: 'sslip', ip: '' });
    expect((await autoUrl.getAutoUrlConfig(db)).mode).toBe('off');
  });
});

describe('own-zone reservation', () => {
  it("refuses another tenant's claim on a service's sslip.io name, and wildcards", async () => {
    await autoUrl.setAutoUrlConfig(db, { mode: 'sslip', ip: '203.0.113.10' });
    const victim = await addService('shop');
    const claimant = await addService('mine');
    expect(isOwnZone('shop.203.0.113.10.sslip.io')).toBe(true);
    expect(await ownZoneClaimRefusal(db, claimant.id, 'shop.203.0.113.10.sslip.io')).toMatch(/automatic domain of service "shop"/);
    expect(await ownZoneClaimRefusal(db, victim.id, 'shop.203.0.113.10.sslip.io')).toBeNull();
    expect(await ownZoneClaimRefusal(db, claimant.id, '*.203.0.113.10.sslip.io')).toMatch(/wildcard/);
    // A free name in the zone is the claimant's to take (no DNS proof possible there).
    expect(await ownZoneClaimRefusal(db, claimant.id, 'free-name.203.0.113.10.sslip.io')).toBeNull();
  });

  it('reserves names under a Settings base domain the same way', async () => {
    await autoUrl.setAutoUrlConfig(db, { mode: 'domain', domain: 'apps.example.com' });
    await addService('shop');
    const claimant = await addService('mine');
    expect(isOwnZone('shop.apps.example.com')).toBe(true);
    expect(await ownZoneClaimRefusal(db, claimant.id, 'shop.apps.example.com')).toMatch(/automatic domain/);
  });
});

describe('POST /:id/domains/auto (Generate domain)', () => {
  async function app() {
    const a = await buildTestApp({ db });
    await a.register(domainsRoutes);
    return a;
  }
  const owner = () => asUser({ id: OWNER, isOperator: true });

  it('says how to turn automatic URLs on while they are off', async () => {
    const svc = await addService('api');
    const res = await (await app()).inject({ method: 'POST', url: `/${svc.id}/domains/auto`, headers: owner() });
    expect(res.statusCode).toBe(409);
    expect(res.json().message ?? res.body).toMatch(/Settings → Automatic URLs/);
  });

  it('adds the active sslip.io domain once, reloads the proxy, and is idempotent', async () => {
    await autoUrl.setAutoUrlConfig(db, { mode: 'sslip', ip: '203.0.113.10' });
    const svc = await addService('api');
    const a = await app();
    const first = await a.inject({ method: 'POST', url: `/${svc.id}/domains/auto`, headers: owner() });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ hostname: 'api.203.0.113.10.sslip.io', ssl: false, status: 'active', created: true });
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalledTimes(1);
    const again = await a.inject({ method: 'POST', url: `/${svc.id}/domains/auto`, headers: owner() });
    expect(again.json()).toMatchObject({ created: false });
    expect(await db.select().from(domains).where(eq(domains.serviceId, svc.id))).toHaveLength(1);
  });

  it('refuses when another service already routes the name', async () => {
    await autoUrl.setAutoUrlConfig(db, { mode: 'sslip', ip: '203.0.113.10' });
    const svc = await addService('api');
    const other = await addService('other');
    await db.insert(domains).values({ serviceId: other.id, hostname: 'api.203.0.113.10.sslip.io', path: '/', status: 'active' });
    const res = await (await app()).inject({ method: 'POST', url: `/${svc.id}/domains/auto`, headers: owner() });
    expect(res.statusCode).toBe(409);
  });
});

describe('settings routes', () => {
  async function app() {
    const { settingsRoutes } = await import('../src/modules/settings.js');
    const a = await buildTestApp({ db });
    await a.register(settingsRoutes);
    return a;
  }
  const op = () => asUser({ id: 1, isOperator: true });

  it('reports the upgrade default and the installer address as the suggestion', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/auto-url', headers: op() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      effective: { mode: 'off' },
      stored: { mode: 'off', domain: null, ip: null },
      envWildcard: null,
      suggestedIp: '203.0.113.10',
    });
  });

  it('saves a mode, refuses a half-filled one, and audits the change', async () => {
    const a = await app();
    expect((await a.inject({ method: 'PUT', url: '/auto-url', headers: op(), payload: { mode: 'sslip' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: '/auto-url', headers: op(), payload: { mode: 'sslip', ip: '300.1.1.1' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PUT', url: '/auto-url', headers: op(), payload: { mode: 'domain', domain: 'x.sslip.io' } })).statusCode).toBe(400);
    const ok = await a.inject({ method: 'PUT', url: '/auto-url', headers: op(), payload: { mode: 'sslip', ip: '203.0.113.10' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().effective).toMatchObject({ mode: 'sslip', ip: '203.0.113.10' });
    expect(auditMock.audit).toHaveBeenCalledWith(db, 1, 'settings.auto_url', 'sslip (203.0.113.10)');
    // The claim rules see it at once.
    expect(isOwnZone('x.203.0.113.10.sslip.io')).toBe(true);
  });

  it('detects the public IP only when asked', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/auto-url/detect-ip', headers: op() });
    expect(res.json()).toEqual({ ip: '198.51.100.7', public: true });
  });

  it('is operator-only', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/auto-url', headers: asUser({ id: OWNER, isOperator: false }) });
    expect(res.statusCode).toBe(403);
  });
});
