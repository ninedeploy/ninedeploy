/** O4: the panel IP allow-list's matching, classification and lock-out rules. */
import { afterEach, describe, expect, it } from 'vitest';
import type { DB } from '@ninedeploy/db';
import {
  buildMatcher,
  credentialKind,
  isSignInRoute,
  normalizeIp,
  panelAccessConfig,
  panelAccessVerdict,
  parseEntry,
  resetPanelAccessCache,
  wouldAllow,
  writePanelAccess,
} from '../../src/lib/panelAccess.js';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.c2ln';

describe('entries', () => {
  it('parses addresses and CIDR ranges of both families', () => {
    expect(parseEntry('203.0.113.9')).toEqual({ address: '203.0.113.9', prefix: 32, family: 'ipv4' });
    expect(parseEntry(' 203.0.113.0/24 ')).toEqual({ address: '203.0.113.0', prefix: 24, family: 'ipv4' });
    expect(parseEntry('2001:db8::/32')).toEqual({ address: '2001:db8::', prefix: 32, family: 'ipv6' });
    expect(parseEntry('::ffff:198.51.100.7')).toEqual({ address: '198.51.100.7', prefix: 32, family: 'ipv4' });
    for (const bad of ['', 'example.com', '203.0.113.0/33', '2001:db8::/129', '1.2.3.4/24/1', '1.2.3.4/x', '300.1.1.1']) expect(parseEntry(bad)).toBeNull();
  });

  it('matches IPv4, IPv6 and IPv4-mapped clients', () => {
    const allows = buildMatcher(['203.0.113.0/24', '2001:db8::/32', '198.51.100.7']);
    expect(allows('203.0.113.200')).toBe(true);
    expect(allows('::ffff:203.0.113.200')).toBe(true);
    expect(allows('203.0.114.1')).toBe(false);
    expect(allows('2001:db8:1::5')).toBe(true);
    expect(allows('2001:db9::5')).toBe(false);
    expect(allows('198.51.100.7')).toBe(true);
    expect(allows('198.51.100.8')).toBe(false);
    expect(allows('garbage')).toBe(false);
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  it('validates the stored shape and caps the list', () => {
    expect(panelAccessConfig.safeParse({ enabled: true, cidrs: ['10.0.0.0/8'] }).success).toBe(true);
    expect(panelAccessConfig.safeParse({ enabled: true, cidrs: ['nope'] }).success).toBe(false);
    expect(panelAccessConfig.safeParse({ enabled: true, cidrs: Array.from({ length: 65 }, (_, i) => `10.0.0.${i % 250}`) }).success).toBe(false);
  });

  it('refuses a list that would lock the caller out, except from loopback', () => {
    expect(wouldAllow({ enabled: true, cidrs: ['203.0.113.0/24'], includeTokens: false }, '198.51.100.1')).toBe(false);
    expect(wouldAllow({ enabled: true, cidrs: ['203.0.113.0/24'], includeTokens: false }, '203.0.113.5')).toBe(true);
    expect(wouldAllow({ enabled: true, cidrs: [], includeTokens: false }, '127.0.0.1')).toBe(true);
    expect(wouldAllow({ enabled: false, cidrs: [], includeTokens: false }, '198.51.100.1')).toBe(true);
  });
});

describe('classification', () => {
  it('names the sign-in routes and leaves IdP metadata and OAuth token calls out', () => {
    for (const [m, p] of [
      ['POST', '/v1/auth/login'], ['POST', '/v1/auth/refresh'], ['POST', '/v1/auth/passkey/login/verify'], ['GET', '/v1/auth/oidc/:slug/callback'],
      ['POST', '/v1/auth/saml/:id/acs'], ['GET', '/v1/sso/:name/login'], ['POST', '/v1/sso/:name/saml-callback'], ['GET', '/v1/oauth/authorize'], ['POST', '/v1/oauth/authorize'],
    ] as const) expect(isSignInRoute(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [
      ['GET', '/v1/auth/saml/:id/metadata'], ['POST', '/v1/oauth/token'], ['POST', '/v1/oauth/register'], ['POST', '/v1/oauth/revoke'],
      ['GET', '/v1/sso/providers'], ['POST', '/v1/hooks/github'], ['GET', '/health'],
    ] as const) expect(isSignInRoute(m, p), `${m} ${p}`).toBe(false);
  });

  it('tells a session from a token, over HTTP and WebSocket', () => {
    expect(credentialKind({ authorization: `Bearer ${JWT}` })).toBe('session');
    expect(credentialKind({ authorization: 'Bearer ndt_abcdef' })).toBe('token');
    expect(credentialKind({ authorization: 'Bearer ndmcp_abcdef' })).toBe('token');
    expect(credentialKind({ 'sec-websocket-protocol': `ninedeploy.v1, ninedeploy.bearer.${JWT}` })).toBe('session');
    expect(credentialKind({})).toBe('none');
    expect(credentialKind({ cookie: 'theme=dark; nd-studio-7=abc.def' })).toBe('session');
    expect(credentialKind({ cookie: 'x-nd-studio-7=abc' })).toBe('none');
    expect(credentialKind({ authorization: 'Basic abc' })).toBe('none');
  });
});

describe('verdict against a stored configuration', () => {
  let db: DB | undefined;
  afterEach(() => {
    resetPanelAccessCache();
    if (db) closeMigratedDb(db);
    db = undefined;
  });
  const outside = { ip: '198.51.100.1', headers: {} as Record<string, string> };

  it('only restricts once enabled; the kill switch and loopback always pass', async () => {
    db = await migratedDb();
    const login = { ...outside, method: 'POST', routeUrl: '/v1/auth/login' };
    expect(await panelAccessVerdict(db, login, { disabled: false })).toBe('allow');
    await writePanelAccess(db, { enabled: true, cidrs: ['203.0.113.0/24'], includeTokens: false });
    expect(await panelAccessVerdict(db, login, { disabled: false })).toBe('deny');
    expect(await panelAccessVerdict(db, { ...login, ip: '203.0.113.9' }, { disabled: false })).toBe('allow');
    expect(await panelAccessVerdict(db, { ...login, ip: '127.0.0.1' }, { disabled: false })).toBe('allow');
    expect(await panelAccessVerdict(db, { ...login, ip: '::ffff:127.0.0.1' }, { disabled: false })).toBe('allow');
    expect(await panelAccessVerdict(db, login, { disabled: true })).toBe('allow');
  });

  it('denies sessions, lets tokens through unless included, and never touches credential-less routes', async () => {
    db = await migratedDb();
    await writePanelAccess(db, { enabled: true, cidrs: ['203.0.113.0/24'], includeTokens: false });
    const at = (routeUrl: string | undefined, headers: Record<string, string> = {}, method = 'GET') => panelAccessVerdict(db!, { ip: outside.ip, method, routeUrl, headers }, { disabled: false });
    expect(await at('/v1/services', { authorization: `Bearer ${JWT}` })).toBe('deny');
    expect(await at('/v1/services', { authorization: 'Bearer ndt_x' })).toBe('allow');
    expect(await at('/v1/mcp', { authorization: 'Bearer ndmcp_x' }, 'POST')).toBe('allow');
    for (const url of ['/v1/hooks/github', '/v1/registry-hooks/:serviceId/:token', '/v1/deploy-hooks/:token', '/v1/badges/:id', '/v1/status/:slug', '/v1/ci/runner/claim', '/scim/v2/Users', '/api/:serviceId/envelope/', '/health', '/', '/*', '/v1/oauth/token']) {
      expect(await at(url, {}, url.startsWith('/v1/ci') || url.includes('hooks') || url.includes('envelope') || url.endsWith('token') ? 'POST' : 'GET'), url).toBe('allow');
    }
    // App traffic Traefik hands the panel keeps the app's own bearer header.
    for (const url of ['/_nd/wake/*', '/_nd/fa/verify/:domainId', '/_nd/maintenance/:serviceId', '/api/:serviceId/envelope/']) {
      expect(await at(url, { authorization: `Bearer ${JWT}` }), url).toBe('allow');
    }
    await writePanelAccess(db, { enabled: true, cidrs: ['203.0.113.0/24'], includeTokens: true });
    expect(await at('/v1/services', { authorization: 'Bearer ndt_x' })).toBe('deny');
    expect(await at('/v1/mcp', { authorization: 'Bearer ndmcp_x' }, 'POST')).toBe('deny');
    expect(await at('/v1/hooks/github', {}, 'POST')).toBe('allow');
    // No matched route: a restricted credential is refused, nothing else is.
    expect(await at(undefined, { authorization: `Bearer ${JWT}` })).toBe('deny');
    expect(await at(undefined, { authorization: 'Bearer ndt_x' })).toBe('deny');
    expect(await at(undefined)).toBe('allow');
    // Machine tokens of SCIM and the CI runner protocol are never restricted.
    expect(await at('/scim/v2/Users', { authorization: 'Bearer scimtoken' })).toBe('allow');
    expect(await at('/v1/ci/runner/claim', { authorization: 'Bearer ndrun_x' }, 'POST')).toBe('allow');
  });

  it('reads an invalid stored value as disabled', async () => {
    db = await migratedDb();
    const { setSettingJson } = await import('../../src/lib/settings.js');
    await setSettingJson(db, 'panel_access', { enabled: true, cidrs: ['not-an-ip'] });
    expect(await panelAccessVerdict(db, { ...outside, method: 'POST', routeUrl: '/v1/auth/login' }, { disabled: false })).toBe('allow');
  });
});
