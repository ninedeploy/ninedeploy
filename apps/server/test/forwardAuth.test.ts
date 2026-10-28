/**
 * G2.3 forward auth on a migrated SQLite: the management route, the panel
 * grant, and the verify endpoint Traefik asks, through the whole sign-in
 * (redirect with a state cookie → grant → callback → session cookie).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { domains, services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/panelOrigin.js', () => ({ panelOrigin: vi.fn(async () => 'https://panel.example.com') }));
vi.mock('../src/lib/panelUpstream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/panelUpstream.js')>()),
  wakeUnreachableReason: vi.fn(async () => null),
}));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const { domainForwardAuthRoutes, forwardAuthGrantRoutes, forwardAuthVerifyRoutes } = await import('../src/modules/forwardAuth.js');
const { resetForwardAuthState } = await import('../src/lib/forwardAuth.js');
const { renderDynamicConfig } = await import('../src/engine/proxy.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
const OWNER = 7;
const OUTSIDER = 9;
beforeEach(async () => {
  resetForwardAuthState();
  db = await migratedDb();
  await db.insert(users).values([
    { id: OWNER, email: 'owner@example.com', passwordHash: 'x' },
    { id: OUTSIDER, email: 'out@example.com', passwordHash: 'x' },
  ]);
  await db.insert(services).values({ id: 5, name: 'grafana', slug: 'grafana', type: 'docker', branch: 'main', ownerUserId: OWNER, runtimeId: 'grafana-1', port: 3000, status: 'running' } as never);
  await db.insert(domains).values({ id: 11, serviceId: 5, hostname: 'grafana.example.com', path: '/', ssl: true, status: 'active' } as never);
});
afterEach(() => closeMigratedDb(db));

async function app() {
  const a = await buildTestApp({ db });
  await a.register(domainForwardAuthRoutes, { prefix: '/domains' });
  await a.register(forwardAuthGrantRoutes, { prefix: '/forward-auth' });
  await a.register(forwardAuthVerifyRoutes);
  return a;
}

const member = asUser({ id: OWNER, isOperator: false });
const traefik = (uri: string, extra: Record<string, string> = {}) => ({
  'x-forwarded-host': 'grafana.example.com',
  'x-forwarded-proto': 'https',
  'x-forwarded-method': 'GET',
  'x-forwarded-uri': uri,
  ...extra,
});
const setCookies = (res: { headers: Record<string, unknown> }) => ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);
const value = (cookies: string[], name: string) => cookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1);

describe('forward auth', () => {
  it('signs a member in through the panel and lets the session through until they sign out everywhere', async () => {
    const a = await app();
    expect((await a.inject({ method: 'PUT', url: '/domains/11/forward-auth', headers: member, payload: { forwardAuth: { minRole: 'viewer' } } })).json()).toEqual({
      domainId: 11,
      forwardAuth: { minRole: 'viewer' },
    });

    // 1. No session: a browser goes to the panel with a state cookie; an API client gets 401.
    const first = await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik('/d/home?x=1', { accept: 'text/html' }) });
    expect(first.statusCode).toBe(302);
    const signIn = new URL(String(first.headers.location));
    expect(`${signIn.origin}${signIn.pathname}`).toBe('https://panel.example.com/forward-auth');
    expect(signIn.searchParams.get('rd')).toBe('https://grafana.example.com/d/home?x=1');
    const state = value(setCookies(first), 'nd_fa_state_11')!;
    expect(signIn.searchParams.get('state')).toBe(state);
    expect(setCookies(first)[0]).toMatch(/HttpOnly; SameSite=Lax; Secure/);
    expect((await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik('/api/x') })).statusCode).toBe(401);

    // 2. The panel page trades the session for a one-time code.
    const grant = await a.inject({ method: 'POST', url: '/forward-auth/grant', headers: member, payload: { domainId: 11, returnTo: 'https://grafana.example.com/d/home?x=1', state } });
    expect(grant.statusCode).toBe(200);
    const callback = new URL(grant.json().url);
    expect(callback.pathname).toBe('/_nd/fa/callback');

    // 3. Without the state cookie the code is refused (and spent); with it, the session cookie is set.
    const stolen = await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik(`${callback.pathname}${callback.search}`) });
    expect(stolen.statusCode).toBe(403);
    const grant2 = await a.inject({ method: 'POST', url: '/forward-auth/grant', headers: member, payload: { domainId: 11, returnTo: 'https://grafana.example.com/d/home?x=1', state } });
    const cb2 = new URL(grant2.json().url);
    const done = await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik(`${cb2.pathname}${cb2.search}`, { cookie: `nd_fa_state_11=${state}` }) });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('https://grafana.example.com/d/home?x=1');
    const session = value(setCookies(done), 'nd_fa_11')!;
    expect(session).toBeTruthy();
    // A code works once.
    expect((await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik(`${cb2.pathname}${cb2.search}`, { cookie: `nd_fa_state_11=${state}` }) })).statusCode).toBe(403);

    // 4. The session lets requests through, with the user's email for the app.
    const ok = await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik('/api/x', { cookie: `nd_fa_11=${session}` }) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-forwarded-user']).toBe('owner@example.com');
    // Not on another host, and not for another domain id.
    expect((await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik('/', { cookie: `nd_fa_11=${session}`, 'x-forwarded-host': 'evil.example.com' }) })).statusCode).toBe(403);

    // Signing out everywhere bumps the token version: the cookie stops working (after the 30 s cache).
    await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, OWNER));
    resetForwardAuthState();
    expect((await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik('/api/x', { cookie: `nd_fa_11=${session}` }) })).statusCode).toBe(401);
    await a.close();
  });

  it('refuses a grant to someone without the role, and a return URL off the domain', async () => {
    const a = await app();
    await a.inject({ method: 'PUT', url: '/domains/11/forward-auth', headers: member, payload: { forwardAuth: { minRole: 'admin' } } });
    const state = 'abcdefghijklmnopqrstuv';
    const outsider = await a.inject({ method: 'POST', url: '/forward-auth/grant', headers: asUser({ id: OUTSIDER, isOperator: false }), payload: { domainId: 11, returnTo: 'https://grafana.example.com/', state } });
    expect(outsider.statusCode).toBe(403);
    const away = await a.inject({ method: 'POST', url: '/forward-auth/grant', headers: member, payload: { domainId: 11, returnTo: 'https://evil.example.com/', state } });
    expect(away.statusCode).toBe(400);
    // Off: the domain is not protected any more and the grant has nothing to give.
    await a.inject({ method: 'PUT', url: '/domains/11/forward-auth', headers: member, payload: { forwardAuth: null } });
    expect((await a.inject({ method: 'POST', url: '/forward-auth/grant', headers: member, payload: { domainId: 11, returnTo: 'https://grafana.example.com/', state } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/_nd/fa/verify/11', headers: traefik('/') })).statusCode).toBe(200);
    await a.close();
  });

  it('puts the forwardAuth middleware first on the protected domain', async () => {
    const a = await app();
    await a.inject({ method: 'PUT', url: '/domains/11/forward-auth', headers: member, payload: { forwardAuth: {} } });
    await a.close();
    const yaml = await renderDynamicConfig(db, { serverId: null });
    expect(yaml).toContain('    mw_grafana_11_fa:\n      forwardAuth:\n        address: "http://');
    expect(yaml).toContain('/_nd/fa/verify/11"\n        trustForwardHeader: false\n');
    expect(yaml).toMatch(/grafana_11:\n[\s\S]*?middlewares:\n {8}- mw_grafana_11_fa/);
  });
});
