/** O4: `/v1/settings/panel-access` — operator only, interactive only, and never saves a list that locks the caller out. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);

const { panelAccessRoutes } = await import('../src/modules/panelAccess.js');
const { readPanelAccess, resetPanelAccessCache } = await import('../src/lib/panelAccess.js');
const { asUser, buildTestApp } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  auditMock.audit.mockReset();
});
afterEach(() => {
  resetPanelAccessCache();
  closeMigratedDb(db);
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(panelAccessRoutes, { prefix: '/settings/panel-access' });
  return a;
}
const put = (a: Awaited<ReturnType<typeof app>>, payload: object, remoteAddress = '203.0.113.9', headers = asUser()) =>
  a.inject({ method: 'PUT', url: '/settings/panel-access', remoteAddress, headers, payload });

describe('panel access settings', () => {
  it('shows the stored list and the caller’s address', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/settings/panel-access', remoteAddress: '::ffff:203.0.113.9', headers: asUser() });
    expect(res.json()).toEqual({ enabled: false, cidrs: [], includeTokens: false, yourIp: '203.0.113.9', overridden: false });
    await a.close();
  });

  it('saves a list that contains the caller, de-duplicated, and audits it', async () => {
    const a = await app();
    const res = await put(a, { enabled: true, cidrs: ['203.0.113.0/24', '203.0.113.0/24', '2001:db8::/32'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, cidrs: ['203.0.113.0/24', '2001:db8::/32'], includeTokens: false });
    expect(await readPanelAccess(db)).toEqual({ enabled: true, cidrs: ['203.0.113.0/24', '2001:db8::/32'], includeTokens: false });
    expect(auditMock.audit).toHaveBeenCalledWith(db, 1, 'settings.panel_access', 'on', expect.objectContaining({ enabled: true }));
    await a.close();
  });

  it('refuses a list without the caller, an empty list turned on, and invalid entries', async () => {
    const a = await app();
    const lockout = await put(a, { enabled: true, cidrs: ['10.0.0.0/8'] });
    expect(lockout.statusCode).toBe(409);
    expect(lockout.body).toContain('203.0.113.9');
    expect((await put(a, { enabled: true, cidrs: [] })).statusCode).toBe(400);
    expect((await put(a, { enabled: true, cidrs: ['example.com'] })).statusCode).toBe(400);
    expect((await put(a, { enabled: true, cidrs: ['203.0.113.0/40'] })).statusCode).toBe(400);
    expect((await readPanelAccess(db)).enabled).toBe(false);
    // From loopback (a shell on the panel host) any list may be saved.
    expect((await put(a, { enabled: true, cidrs: ['10.0.0.0/8'] }, '127.0.0.1')).statusCode).toBe(200);
    // Turning it off never needs the caller's address.
    expect((await put(a, { enabled: false, cidrs: ['10.0.0.0/8'] }, '198.51.100.1')).statusCode).toBe(200);
    await a.close();
  });

  it('is for operators, and API tokens may not change it', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/settings/panel-access', headers: asUser({ id: 2, role: 'member', isOperator: false }) })).statusCode).toBe(403);
    const token = await put(a, { enabled: false, cidrs: [] }, '203.0.113.9', { ...asUser(), 'x-test-token-scopes': 'operator' });
    expect(token.statusCode).toBe(403);
    await a.close();
  });
});
