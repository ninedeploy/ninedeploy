/**
 * O4: the panel IP allow-list on the real app (every plugin and route mounted,
 * infrastructure plugins stubbed as in app.test.ts). Sign-in and sessions from
 * an outside address are refused, disguised paths included; integrations,
 * loopback and listed addresses are not.
 */
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/plugins/worker.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/traefik.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/publicDatabaseAccess.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/databaseImports.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/terminals.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/trafficAnalytics.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/nodeDatabases.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/collector.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/backupScheduler.js', () => ({ default: vi.fn(async () => undefined) }));

const tmp = path.join(os.tmpdir(), `ninedeploy-panel-access-${process.pid}-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

type App = Awaited<ReturnType<typeof import('../src/app.js')['buildApp']>>;
let app: App;
const OUTSIDE = '198.51.100.1';
const LISTED = '203.0.113.9';
const JWT = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2ln';
const code = (body: string): string | undefined => {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
};

beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NINEDEPLOY_DATA_DIR', tmp);
  vi.stubEnv('NINEDEPLOY_DB_PATH', path.join(tmp, 'ninedeploy.db'));
  app = await (await import('../src/app.js')).buildApp();
  await app.ready();
  const { writePanelAccess } = await import('../src/lib/panelAccess.js');
  await writePanelAccess(app.db, { enabled: true, cidrs: ['203.0.113.0/24'], includeTokens: false });
}, 60_000);
afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows SQLite file lock, as in app.test.ts */
  }
});

const req = (method: 'GET' | 'POST', url: string, remoteAddress: string, headers: Record<string, string> = {}, payload?: object) =>
  app.inject({ method, url, remoteAddress, headers, ...(payload && { payload }) });

describe('panel IP allow-list on the mounted app', () => {
  it('refuses sign-in from an outside address, however the path is spelled', async () => {
    for (const url of ['/v1/auth/login', '/v1/%61uth/login', '/v1/auth/login?x=1']) {
      const res = await req('POST', url, OUTSIDE, {}, { email: 'a@example.com', password: 'x' });
      expect(res.statusCode, url).toBe(403);
      expect(code(res.body), url).toBe('panel_access_denied');
    }
    // A listed address reaches the login handler (and fails on the password, not the list).
    const listed = await req('POST', '/v1/auth/login', LISTED, {}, { email: 'a@example.com', password: 'x' });
    expect(code(listed.body)).not.toBe('panel_access_denied');
  });

  it('refuses a session from an outside address over HTTP and on the event socket route', async () => {
    for (const url of ['/v1/services', '/v1/%73ervices', '/v1/events']) {
      const res = await req('GET', url, OUTSIDE, { authorization: JWT });
      expect(res.statusCode, url).toBe(403);
      expect(code(res.body), url).toBe('panel_access_denied');
    }
    // A path no route matches answers 404 and serves nothing either way.
    expect((await req('GET', '/v1/no-such-route', OUTSIDE, { authorization: JWT })).statusCode).toBe(404);
    // The database Studio proxy's own cookie counts as a session.
    const studio = await req('GET', '/v1/databases/1/studio-proxy/', OUTSIDE, { cookie: 'nd-studio-1=abc' });
    expect(code(studio.body)).toBe('panel_access_denied');
    const ws = await req('GET', '/v1/events', OUTSIDE, { 'sec-websocket-protocol': `ninedeploy.v1, ninedeploy.bearer.${JWT.slice(7)}` });
    expect(code(ws.body)).toBe('panel_access_denied');
  });

  it('lets a session from a listed address or loopback reach authentication', async () => {
    for (const ip of [LISTED, '127.0.0.1', '::ffff:203.0.113.20']) {
      const res = await req('GET', '/v1/services', ip, { authorization: JWT });
      expect(res.statusCode, ip).toBe(401);
    }
  });

  it('leaves API tokens and integrations alone', async () => {
    expect((await req('GET', '/v1/services', OUTSIDE, { authorization: 'Bearer opaque-api-token' })).statusCode).toBe(401);
    expect((await req('GET', '/health', OUTSIDE)).statusCode).toBe(200);
    for (const [method, url] of [
      ['POST', '/v1/hooks/github'],
      ['POST', '/v1/registry-hooks/1/token'],
      ['POST', '/v1/deploy-hooks/token'],
      ['GET', '/v1/status/acme'],
      ['POST', '/v1/ci/runner/claim'],
      ['GET', '/scim/v2/Users'],
      ['POST', '/api/1/envelope/'],
      ['POST', '/v1/oauth/token'],
      ['GET', '/v1/auth/saml/1/metadata'],
    ] as const) {
      const res = await req(method, url, OUTSIDE, url.startsWith('/scim') ? { authorization: 'Bearer scim' } : {});
      expect(code(res.body), `${method} ${url}`).not.toBe('panel_access_denied');
    }
  });

  it('the kill switch reaches the Docker container and the config', async () => {
    const { readFileSync } = await import('node:fs');
    const compose = readFileSync(new URL('../../../docker-compose.prod.yml', import.meta.url), 'utf8');
    expect(compose).toContain('NINEDEPLOY_PANEL_ACCESS: ${NINEDEPLOY_PANEL_ACCESS:-on}');
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_PANEL_ACCESS', 'off');
    expect((await import('../src/config.js')).config.panelAccessOverride).toBe(true);
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_PANEL_ACCESS', 'on');
    expect((await import('../src/config.js')).config.panelAccessOverride).toBe(false);
  });

  it('the settings route refuses a list without the caller’s address', async () => {
    const { wouldAllow } = await import('../src/lib/panelAccess.js');
    expect(wouldAllow({ enabled: true, cidrs: ['10.0.0.0/8'], includeTokens: false }, LISTED)).toBe(false);
  });
});
