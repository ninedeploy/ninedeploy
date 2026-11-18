/** Faults at the proxy I/O boundary, with real route, SQLite and YAML rendering. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, services, settings, users, type DB } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { load } from 'js-yaml';

vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/panelUpstream.js', async (original) => ({
  ...(await original<typeof import('../src/lib/panelUpstream.js')>()), wakeUnreachableReason: async () => null, detectPanelOnNetwork: async () => undefined,
}));
vi.mock('../src/lib/traefikCustomConfig.js', () => ({ materialiseCustomConfig: async () => undefined }));
vi.mock('../src/engine/proxy.js', async (original) => ({
  ...(await original<typeof import('../src/engine/proxy.js')>()), writeDynamicConfig: vi.fn(),
  ensureNetwork: async () => undefined, ensureTraefik: async () => false, traefikInputs: async () => ({}), materialiseCertificatesFile: async () => undefined,
}));
const { renderDynamicConfig, writeDynamicConfig } = await import('../src/engine/proxy.js');
const { domainForwardAuthRoutes } = await import('../src/modules/forwardAuth.js');
const { serviceMaintenanceRoutes } = await import('../src/modules/maintenance.js');
const { recoverProxySettings } = await import('../src/lib/proxySettingApply.js');
const { setSettingJson } = await import('../src/lib/settings.js');
const { default: traefikPlugin } = await import('../src/plugins/traefik.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { migratedDb, closeMigratedDb } = await import('./lib/githubAppKit.js');
let db: DB;
let active: string;
const features = [
  { name: 'forward auth', url: '/domains/11/forward-auth', on: { forwardAuth: { minRole: 'admin' } }, off: { forwardAuth: null }, field: 'forwardAuth' },
  { name: 'maintenance', url: '/services/5/maintenance', on: { maintenance: { title: 'Upgrading' } }, off: { maintenance: null }, field: 'maintenance' },
  { name: 'error pages', url: '/services/5/error-pages', on: { pages: { '502': '<h1>Unavailable</h1>' } }, off: { pages: {} }, field: 'pages' },
] as const;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 7, email: 'owner@example.com', passwordHash: 'x' });
  await db.insert(services).values({ id: 5, name: 'shop', slug: 'shop', type: 'docker', ownerUserId: 7, runtimeId: 'shop-1', port: 3000, status: 'running' });
  await db.insert(domains).values({ id: 11, serviceId: 5, hostname: 'shop.example.com', status: 'active' });
  active = await renderDynamicConfig(db, { serverId: null });
  vi.mocked(writeDynamicConfig).mockReset().mockImplementation(async () => { active = await renderDynamicConfig(db, { serverId: null }); });
});

describe('unfinished proxy writes', () => {
  it('restores interrupted changes at actual plugin boot and on a healthy watchdog tick', async () => {
    const seed = async () => {
      await setSettingJson(db, 'proxy_apply_domain:11:forward_auth', { serverId: null, previous: { present: false, value: null } });
      await setSettingJson(db, 'forward_auth:11', { minRole: 'viewer' });
    };
    await seed();
    const a = await app();
    await a.register(traefikPlugin);
    await a.ready();
    expect((await a.inject({ url: features[0].url, headers })).json()).toEqual({ domainId: 11, forwardAuth: null });
    vi.useFakeTimers();
    try {
      // Use a fresh plugin instance so its interval is owned by the fake clock.
      await a.close();
      const b = await app();
      await b.register(traefikPlugin);
      await b.ready();
      try {
        await seed();
        expect((await b.inject({ url: features[0].url, headers })).statusCode).toBe(503);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect((await b.inject({ url: features[0].url, headers })).json()).toEqual({ domainId: 11, forwardAuth: null });
      } finally { await b.close(); }
    } finally { vi.useRealTimers(); await a.close(); }
  });
  it('keeps a failed rollback visibly unconfirmed until the watchdog restores it', async () => {
    const a = await app();
    try {
      vi.mocked(writeDynamicConfig).mockRejectedValueOnce(new Error('ack lost')).mockRejectedValueOnce(new Error('still down'));
      const failed = await a.inject({ method: 'PUT', url: features[0].url, headers, payload: features[0].on });
      expect(failed.statusCode).toBe(503);
      const unknown = await a.inject({ url: features[0].url, headers });
      expect(unknown.statusCode).toBe(503);
      expect(unknown.json().error.code).toBe('proxy_setting_unconfirmed');
      await recoverProxySettings(db);
      expect((await a.inject({ url: features[0].url, headers })).json()).toEqual({ domainId: 11, forwardAuth: null });
      expect(await db.query.settings.findFirst({ where: eq(settings.key, 'proxy_apply_domain:11:forward_auth') })).toBeUndefined();
    } finally { await a.close(); }
  });

  it('restores an interrupted write from its durable journal, retaining malformed fail-closed protection', async () => {
    // The previous value is deliberately unreadable: rollback must not treat it as off.
    await setSettingJson(db, 'proxy_apply_domain:11:forward_auth', { serverId: null, previous: { present: true, value: 'unreadable protection' } });
    await setSettingJson(db, 'forward_auth:11', { minRole: 'viewer' });
    await recoverProxySettings(db);
    expect((await db.query.settings.findFirst({ where: eq(settings.key, 'forward_auth:11') }))?.value).toBe('unreadable protection');
    expect(active).toContain('mw_shop_11_fa');
    expect(writeDynamicConfig).toHaveBeenLastCalledWith(db, { confirmLocalRouting: true });
    await recoverProxySettings(db); // Idempotent.
    expect(writeDynamicConfig).toHaveBeenCalledTimes(1);
  });

  it('does not recreate a deleted owner or silently discard a malformed rollback record', async () => {
    await setSettingJson(db, 'proxy_apply_service:99:maintenance', { serverId: null, previous: { present: true, value: { title: 'old' } } });
    await recoverProxySettings(db);
    expect(await db.query.settings.findFirst({ where: eq(settings.key, 'maintenance:99') })).toBeUndefined();
    await setSettingJson(db, 'proxy_apply_domain:11:forward_auth', { broken: true });
    await expect(recoverProxySettings(db)).rejects.toMatchObject({ code: 'proxy_setting_unconfirmed' });
    expect(await db.query.settings.findFirst({ where: eq(settings.key, 'proxy_apply_domain:11:forward_auth') })).toBeDefined();
  });

  it('serializes an overlapping successful save behind a failed save and its rollback', async () => {
    const a = await app();
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(writeDynamicConfig).mockImplementationOnce(async () => { entered(); await barrier; throw new Error('ack lost'); });
    const first = a.inject({ method: 'PUT', url: features[0].url, headers, payload: features[0].on }).then((r) => r);
    try {
      await started;
      const second = a.inject({ method: 'PUT', url: features[0].url, headers, payload: { forwardAuth: { minRole: 'member' } } }).then((r) => r);
      release();
      expect((await first).statusCode).toBe(502);
      expect((await second).statusCode).toBe(200);
      expect((await a.inject({ url: features[0].url, headers })).json()).toEqual({ domainId: 11, forwardAuth: { minRole: 'member' } });
      expect(writeDynamicConfig).toHaveBeenCalledTimes(3);
    } finally { release(); await a.close(); }
  });
});
afterEach(() => closeMigratedDb(db));
async function app() {
  const a = await buildTestApp({ db });
  await a.register(domainForwardAuthRoutes, { prefix: '/domains' });
  await a.register(serviceMaintenanceRoutes, { prefix: '/services' });
  return a;
}
const headers = asUser({ id: 7, isOperator: false });

it('applies successful settings and refuses an unauthorized change without writing routing', async () => {
  const a = await app();
  try {
    for (const feature of features) {
      const result = await a.inject({ method: 'PUT', url: feature.url, headers, payload: feature.on });
      expect(result.statusCode).toBe(200);
      expect((await a.inject({ url: feature.url, headers })).json()).toEqual(result.json());
    }
    const writes = vi.mocked(writeDynamicConfig).mock.calls.length;
    const denied = await a.inject({ method: 'PUT', url: features[0].url, headers: asUser({ id: 999, isOperator: false }), payload: features[0].off });
    expect(denied.statusCode).toBe(404);
    expect(writeDynamicConfig).toHaveBeenCalledTimes(writes);
  } finally { await a.close(); }
});

describe.each(features)('$name application', (feature) => {
  it.each(['render', 'write', 'ack'] as const)('rejects an unconfirmed enable after a %s failure and restores routing before retry', async (stage) => {
    const a = await app();
    try {
      const before = (await a.inject({ url: feature.url, headers })).json();
      const previousRouting = load(active);
      vi.mocked(writeDynamicConfig).mockImplementationOnce(async () => {
        if (stage !== 'render') {
          const rendered = await renderDynamicConfig(db, { serverId: null });
          if (stage === 'ack') active = rendered; // Written; acknowledgement lost.
        }
        throw new Error(`injected ${stage} failure`);
      });
      const failed = await a.inject({ method: 'PUT', url: feature.url, headers, payload: feature.on });
      expect(failed.statusCode, failed.body).toBe(502);
      expect((await a.inject({ url: feature.url, headers })).json()).toEqual(before);
      expect(load(active)).toEqual(previousRouting);
      const retry = await a.inject({ method: 'PUT', url: feature.url, headers, payload: feature.on });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()[feature.field]).not.toEqual(before[feature.field]);
      expect(load(active)).not.toEqual(previousRouting);
      expect(writeDynamicConfig).toHaveBeenLastCalledWith(db, { confirmLocalRouting: true });
    } finally { await a.close(); }
  });

  it('also rolls back a failed disable, preserving the exact previous setting', async () => {
    const a = await app();
    try {
      const enabled = await a.inject({ method: 'PUT', url: feature.url, headers, payload: feature.on });
      expect(enabled.statusCode).toBe(200); // Unaffected control.
      const previousRouting = load(active);
      vi.mocked(writeDynamicConfig).mockRejectedValueOnce(new Error('disk full'));
      const failed = await a.inject({ method: 'PUT', url: feature.url, headers, payload: feature.off });
      expect(failed.statusCode, failed.body).toBe(502);
      expect((await a.inject({ url: feature.url, headers })).json()).toEqual(enabled.json());
      expect(load(active)).toEqual(previousRouting);
    } finally { await a.close(); }
  });
});
