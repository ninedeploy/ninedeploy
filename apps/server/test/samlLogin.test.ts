/**
 * G3.6 SAML sign-in end to end on a migrated SQLite: a real AuthnRequest,
 * a response signed the way IdPs sign it (enveloped signature over the
 * exclusive-c14n assertion, via node-saml's own signer), and the refusals
 * that matter — replay, another key, another domain, no account, signature
 * wrapping and a RelayState from another flow.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSamlPost } from '@node-saml/node-saml/lib/saml-post-signing.js';
import { ssoProviders, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/panelOrigin.js', () => ({ panelOrigin: vi.fn(async () => 'https://panel.example.com') }));

const { samlLoginRoutes } = await import('../src/modules/samlLogin.js');
const { resetSamlCaches } = await import('../src/lib/samlLogin.js');
const { verifyJwt } = await import('../src/lib/jwt.js');
const { issueSessionTokens } = await import('../src/lib/sessions.js');
const { asUser, buildTestApp } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

const fixture = (f: string) => readFileSync(path.join(__dirname, 'fixtures', 'saml', f), 'utf8');
const IDP_CERT = fixture('idp.crt');
const IDP_KEY = fixture('idp.key');
const OTHER_KEY = fixture('other.key');
const SP = 'https://panel.example.com/v1/auth/saml/1/metadata';
const ACS = 'https://panel.example.com/v1/auth/saml/1/acs';
const IDP = 'https://idp.example.test';
const NONCE = 'tabnonce0123456789abcdef';

let db: DB;
beforeEach(async () => {
  resetSamlCaches();
  db = await migratedDb();
  await db.insert(users).values([
    { id: 1, email: 'alice@corp.example', passwordHash: 'x' },
    { id: 2, email: 'bob@corp.example', passwordHash: 'x', totpEnabled: true },
  ] as never);
  await db.insert(ssoProviders).values({
    id: 1,
    type: 'saml',
    name: 'corp',
    configJson: JSON.stringify({ entryPoint: `${IDP}/sso`, idpCert: IDP_CERT, idpIssuer: IDP, emailDomains: ['corp.example'] }),
  } as never);
});
afterEach(() => closeMigratedDb(db));

async function app() {
  const a = await buildTestApp({ db });
  await a.register(samlLoginRoutes, { prefix: '/auth/saml' });
  return a;
}

/** The AuthnRequest id and RelayState an IdP redirect URL carries. */
function readRedirect(location: string) {
  const to = new URL(location);
  expect(`${to.origin}${to.pathname}`).toBe(`${IDP}/sso`);
  const request = inflateRawSync(Buffer.from(to.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
  const id = /ID="([^"]+)"/.exec(request)![1]!;
  expect(request).toContain(`AssertionConsumerServiceURL="${ACS}"`);
  return { id, relayState: to.searchParams.get('RelayState')! };
}

/** Start a sign-in and read the AuthnRequest id and RelayState the IdP would get. */
async function start(a: Awaited<ReturnType<typeof app>>) {
  const res = await a.inject({ method: 'GET', url: `/auth/saml/1/login?nonce=${NONCE}&returnTo=%2Fservices` });
  expect(res.statusCode).toBe(302);
  return readRedirect(String(res.headers.location));
}

/** Link the IdP identity to a user from that user's own session (Settings → Account). */
async function link(a: Awaited<ReturnType<typeof app>>, userId: number, email: string) {
  const user = (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, userId) }))!;
  const { accessToken } = await issueSessionTokens(db, user);
  const res = await a.inject({ method: 'POST', url: '/auth/saml/1/link', headers: { ...asUser({ id: userId, isOperator: false }), authorization: `Bearer ${accessToken}` } });
  expect(res.statusCode).toBe(200);
  const s = readRedirect(res.json().authUrl);
  const done = await post(a, response({ inResponseTo: s.id, email }), s.relayState);
  expect(done.statusCode).toBe(303);
  expect(done.headers.location).toBe('/settings?samlLinked=1');
}

function response(o: { inResponseTo: string; email?: string; audience?: string; key?: string; wrap?: string }): string {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000).toISOString();
  const issue = now.toISOString();
  const assertion = (id: string, email: string) =>
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${issue}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo}" Recipient="${ACS}" NotOnOrAfter="${later}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${issue}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issue}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `</saml:Assertion>`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Date.now()}" Version="2.0" IssueInstant="${issue}" Destination="${ACS}" InResponseTo="${o.inResponseTo}">` +
    `<saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion('_a1', o.email ?? 'alice@corp.example') +
    `</samlp:Response>`;
  let signed = signSamlPost(xml, '/*[local-name(.)="Response"]/*[local-name(.)="Assertion"]', {
    privateKey: o.key ?? IDP_KEY,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
  });
  // Signature wrapping: an unsigned assertion naming someone else, placed first.
  if (o.wrap) signed = signed.replace('<saml:Assertion', `${assertion('_evil', o.wrap)}<saml:Assertion`);
  return Buffer.from(signed).toString('base64');
}

const post = (a: Awaited<ReturnType<typeof app>>, SAMLResponse: string, RelayState: string) =>
  a.inject({
    method: 'POST',
    url: '/auth/saml/1/acs',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ SAMLResponse, RelayState }).toString(),
  });

describe('SAML sign-in', () => {
  it('signs the linked user in from a signed response to its own request, once', async () => {
    const a = await app();
    // Not linked yet: an existing account must link the identity first.
    let s = await start(a);
    expect((await post(a, response({ inResponseTo: s.id }), s.relayState)).json().error.code).toBe('account_link_required');
    await link(a, 1, 'alice@corp.example');
    const { id, relayState } = await start(a);
    const body = response({ inResponseTo: id });
    const res = await post(a, body, relayState);
    expect(res.statusCode).toBe(303);
    const location = String(res.headers.location);
    expect(location.startsWith('/auth/callback#')).toBe(true);
    const fragment = new URLSearchParams(location.slice(location.indexOf('#') + 1));
    expect(fragment.get('nonce')).toBe(NONCE);
    expect(fragment.get('return_to')).toBe('/services');
    expect(await verifyJwt(fragment.get('access_token')!)).toMatchObject({ sub: '1', amr: 'sso', idp: 'sso:1' });
    // The same response again: its request id is spent.
    expect((await post(a, body, relayState)).statusCode).toBe(401);
    await a.close();
  });

  it('refuses another key, another audience, a wrapped assertion and an unsolicited response', async () => {
    const a = await app();
    let s = await start(a);
    expect((await post(a, response({ inResponseTo: s.id, key: OTHER_KEY }), s.relayState)).statusCode).toBe(401);
    s = await start(a);
    expect((await post(a, response({ inResponseTo: s.id, audience: 'https://other-sp.example' }), s.relayState)).statusCode).toBe(401);
    s = await start(a);
    const wrapped = await post(a, response({ inResponseTo: s.id, wrap: 'bob@corp.example' }), s.relayState);
    expect(wrapped.statusCode).toBe(401);
    // A request id the panel never issued.
    s = await start(a);
    expect((await post(a, response({ inResponseTo: '_never-issued' }), s.relayState)).statusCode).toBe(401);
    await a.close();
  });

  it('refuses an email outside the domains, an unknown account, a 2FA account and a foreign RelayState', async () => {
    const a = await app();
    await link(a, 2, 'bob@corp.example');
    let s = await start(a);
    expect((await post(a, response({ inResponseTo: s.id, email: 'eve@evil.example' }), s.relayState)).statusCode).toBe(403);
    s = await start(a);
    expect((await post(a, response({ inResponseTo: s.id, email: 'nobody@corp.example' }), s.relayState)).json().error.code).toBe('saml_no_account');
    s = await start(a);
    expect((await post(a, response({ inResponseTo: s.id, email: 'bob@corp.example' }), s.relayState)).json().error.code).toBe('saml_totp');
    s = await start(a);
    expect((await post(a, response({ inResponseTo: s.id }), 'forged.state')).statusCode).toBe(400);
    // A start without the tab's nonce is refused.
    expect((await a.inject({ method: 'GET', url: '/auth/saml/1/login' })).statusCode).toBe(400);
    await a.close();
  });

  it('links only from a live session, only to the account with the same email', async () => {
    const a = await app();
    const user = (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, 1) }))!;
    const { accessToken } = await issueSessionTokens(db, user);
    const res = await a.inject({ method: 'POST', url: '/auth/saml/1/link', headers: { ...asUser({ id: 1, isOperator: false }), authorization: `Bearer ${accessToken}` } });
    const s = readRedirect(res.json().authUrl);
    // The IdP answers for someone else: no link.
    expect((await post(a, response({ inResponseTo: s.id, email: 'bob@corp.example' }), s.relayState)).statusCode).toBe(403);
    // Without a real session token the link does not start.
    expect((await a.inject({ method: 'POST', url: '/auth/saml/1/link', headers: asUser({ id: 1, isOperator: false }) })).statusCode).toBe(401);
    await a.close();
  });

  it('publishes its metadata and lists the provider for the sign-in page', async () => {
    const a = await app();
    const md = await a.inject({ method: 'GET', url: '/auth/saml/1/metadata' });
    expect(md.body).toContain(`entityID="${SP}"`);
    expect(md.body).toContain(`Location="${ACS}"`);
    expect((await a.inject({ method: 'GET', url: '/auth/saml/providers/public' })).json()).toEqual([{ id: 1, name: 'corp', authUrl: '/v1/auth/saml/1/login' }]);
    await a.close();
  });
});
