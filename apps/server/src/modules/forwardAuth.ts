import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { domains, serviceTargets, services, users, type Domain } from '@ninedeploy/db';
import { forwardAuthGrantInput, forwardAuthInput, type ForwardAuthView } from '@ninedeploy/schemas';
import { writeDynamicConfig } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, parseId } from '../lib/errors.js';
import {
  FA_PREFIX,
  forwardAuthState,
  SESSION_TTL_S,
  STATE_COOKIE_TTL_S,
  cachedDecision,
  callbackPath,
  cookie,
  getForwardAuth,
  hostMatches,
  issueCode,
  newState,
  readCookie,
  readSession,
  rememberDecision,
  sessionCookieName,
  setForwardAuth,
  signSession,
  stateCookieName,
  takeCode,
} from '../lib/forwardAuth.js';
import { panelOrigin } from '../lib/panelOrigin.js';
import { wakeUnreachableReason } from '../lib/panelUpstream.js';
import { assertServiceRole, isOperator, loadServiceForUser, roleAtLeast, serviceRole } from '../lib/resourceAccess.js';

/**
 * G2.3 forward auth (see lib/forwardAuth.ts for the flow).
 *  - Management, `GET/PUT /v1/domains/:id/forward-auth` (member on the service).
 *  - `POST /v1/forward-auth/grant`: the panel page trades the signed-in
 *    session for a one-time code on the protected domain.
 *  - `/_nd/fa/verify/:domainId`, outside /v1: what Traefik's forwardAuth asks.
 */

async function loadDomain(db: Parameters<FastifyPluginAsync>[0]['db'], id: number): Promise<Domain | undefined> {
  return db.query.domains.findFirst({ where: eq(domains.id, id) });
}

/** Management, mounted under `/domains`. */
export const domainForwardAuthRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const load = async (req: FastifyRequest) => {
    const d = await loadDomain(app.db, parseId((req.params as { id: string }).id));
    if (!d) throw notFound('Domain not found');
    // Visibility follows the service (a domain of a service you cannot see is a 404).
    const svc = await loadServiceForUser(app.db, d.serviceId, req.user!);
    return { d, svc };
  };

  app.get('/:id/forward-auth', async (req): Promise<ForwardAuthView> => {
    const { d } = await load(req);
    return { domainId: d.id, forwardAuth: await getForwardAuth(app.db, d.id) };
  });

  app.put('/:id/forward-auth', async (req): Promise<ForwardAuthView> => {
    const { d, svc } = await load(req);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { forwardAuth } = forwardAuthInput.parse(req.body ?? {});
    if (forwardAuth) {
      if (svc.serverId != null) throw badRequest('Panel sign-in is for domains of services on the panel host for now', 'forward_auth_unsupported');
      // A service that also runs on nodes would be routed by their proxies, which cannot ask the panel.
      const onNodes = await app.db.query.serviceTargets.findFirst({ where: eq(serviceTargets.serviceId, svc.id) });
      if (onNodes) throw badRequest('Panel sign-in is not available for a service that also runs on nodes', 'forward_auth_unsupported');
      const unreachable = await wakeUnreachableReason();
      if (unreachable) throw badRequest(`Cannot put the domain behind panel sign-in: ${unreachable}`, 'forward_auth_unreachable');
    }
    await setForwardAuth(app.db, d.id, forwardAuth);
    await writeDynamicConfig(app.db).catch((err: unknown) => req.log.warn({ err }, 'proxy re-render failed'));
    void audit(app.db, req.user!.id, forwardAuth ? 'domain.forward_auth.on' : 'domain.forward_auth.off', `${d.hostname} (${svc.name})`, {
      serviceId: svc.id,
      domainId: d.id,
      ...(forwardAuth && { minRole: forwardAuth.minRole }),
    });
    return { domainId: d.id, forwardAuth: await getForwardAuth(app.db, d.id) };
  });
};

/** `POST /v1/forward-auth/grant`, mounted under `/forward-auth`. */
export const forwardAuthGrantRoutes: FastifyPluginAsync = async (app) => {
  app.post('/grant', { onRequest: [app.authenticate, app.requireInteractive] }, async (req) => {
    const input = forwardAuthGrantInput.parse(req.body ?? {});
    const d = await loadDomain(app.db, input.domainId);
    const fa = d && d.status === 'active' ? await getForwardAuth(app.db, d.id) : null;
    if (!d || !fa) throw notFound('No such protected domain');
    let target: URL;
    try {
      target = new URL(input.returnTo);
    } catch {
      throw badRequest('returnTo is not a URL');
    }
    // Only back to the protected domain itself: never an open redirect.
    if (!['http:', 'https:'].includes(target.protocol) || !hostMatches(String(d.hostname), target.hostname) || target.username || target.password) {
      throw badRequest('returnTo must be a URL on the protected domain', 'forward_auth_bad_return');
    }
    const svc = await app.db.query.services.findFirst({ where: eq(services.id, d.serviceId) });
    if (!svc) throw notFound('No such protected domain');
    const role = await serviceRole(app.db, svc, req.user!);
    if (role === null || !roleAtLeast(role, fa.minRole)) throw forbidden(`Entering ${target.hostname} needs the "${fa.minRole}" role or higher on its service`);
    const code = issueCode({ userId: req.user!.id, domainId: d.id, returnTo: target.toString(), state: input.state });
    const url = new URL(`${target.protocol}//${target.host}${callbackPath(d.path)}`);
    url.searchParams.set('code', code);
    void audit(app.db, req.user!.id, 'domain.forward_auth.grant', `${target.hostname} (${svc.name})`, { serviceId: svc.id, domainId: d.id });
    return { url: url.toString() };
  });
};

/** What Traefik's forwardAuth asks, registered at the root of the app. */
export const forwardAuthVerifyRoutes: FastifyPluginAsync = async (app) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, _body, done) => done(null, undefined));

  const deny = (reply: FastifyReply, code: number, text: string) => reply.code(code).type('text/plain; charset=utf-8').header('cache-control', 'no-store').send(`${text}\n`);

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const domainId = Number((req.params as { domainId: string }).domainId);
    const d = Number.isSafeInteger(domainId) && domainId > 0 ? await loadDomain(app.db, domainId) : undefined;
    const protection = d ? await forwardAuthState(app.db, d.id) : 'invalid';
    // Turned off a moment ago (no row; the routes follow): let the request through.
    if (d && protection === 'off') return reply.code(200).send();
    // A row that does not parse denies: an unreadable protection is not an open door.
    if (!d || protection === 'off' || protection === 'invalid' || d.status !== 'active') return deny(reply, 403, 'Forbidden');
    const fa = protection;
    const host = String(req.headers['x-forwarded-host'] ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!host || !hostMatches(String(d.hostname), host)) return deny(reply, 403, 'Forbidden');
    const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const uri = String(req.headers['x-forwarded-uri'] ?? '/');
    const secure = proto === 'https';
    const cookiePath = String(d.path ?? '').replace(/\/+$/, '') || '/';
    const method = String(req.headers['x-forwarded-method'] ?? 'GET').toUpperCase();
    const reqUrl = new URL(uri.startsWith('/') ? uri : `/${uri}`, `${proto}://${host}`);

    // 3. The callback: spend the code, set the session cookie, go on.
    if (reqUrl.pathname === callbackPath(d.path)) {
      const pending = takeCode(reqUrl.searchParams.get('code') ?? '');
      const state = readCookie(req.headers.cookie, stateCookieName(d.id));
      if (!pending || pending.domainId !== d.id || !state || pending.state !== state) return deny(reply, 403, 'This sign-in link is invalid or expired. Open the page again.');
      const back = new URL(pending.returnTo);
      if (!hostMatches(String(d.hostname), back.hostname) || back.hostname !== host) return deny(reply, 403, 'Forbidden');
      const user = await app.db.query.users.findFirst({ where: eq(users.id, pending.userId) });
      if (!user || user.deactivatedAt) return deny(reply, 403, 'Forbidden');
      const session = signSession({ u: user.id, d: d.id, v: user.tokenVersion, e: Math.floor(Date.now() / 1000) + SESSION_TTL_S });
      reply.header('set-cookie', [
        cookie(sessionCookieName(d.id), session, { path: cookiePath, maxAge: SESSION_TTL_S, secure }),
        cookie(stateCookieName(d.id), '', { path: cookiePath, maxAge: 0, secure }),
      ]);
      return reply.code(302).header('cache-control', 'no-store').header('location', back.toString()).send();
    }

    // Every other request: a valid session cookie of a user who still may enter.
    const raw = readCookie(req.headers.cookie, sessionCookieName(d.id));
    const s = readSession(raw);
    if (raw && s && s.d === d.id) {
      let decision = cachedDecision(raw);
      if (!decision) {
        const user = await app.db.query.users.findFirst({ where: eq(users.id, s.u) });
        const svc = await app.db.query.services.findFirst({ where: eq(services.id, d.serviceId) });
        let ok = false;
        if (user && !user.deactivatedAt && user.tokenVersion === s.v && svc) {
          const role = await serviceRole(app.db, svc, { id: user.id, isOperator: await isOperator(app.db, user) });
          ok = role !== null && roleAtLeast(role, fa.minRole);
        }
        decision = { ok, email: user?.email ?? '' };
        rememberDecision(raw, ok, decision.email);
      }
      if (decision.ok) return reply.code(200).header('x-forwarded-user', decision.email).send();
    }

    // 1. No session: a browser goes to the panel to sign in; anything else gets 401.
    const browser = (method === 'GET' || method === 'HEAD') && /text\/html/.test(String(req.headers.accept ?? ''));
    if (!browser) return deny(reply, 401, 'Sign in required');
    const state = newState();
    const signIn = new URL(`${await panelOrigin(app.db)}/forward-auth`);
    signIn.searchParams.set('d', String(d.id));
    signIn.searchParams.set('rd', reqUrl.toString());
    signIn.searchParams.set('state', state);
    reply.header('set-cookie', cookie(stateCookieName(d.id), state, { path: cookiePath, maxAge: STATE_COOKIE_TTL_S, secure }));
    return reply.code(302).header('cache-control', 'no-store').header('location', signIn.toString()).send();
  };

  const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
  app.route({ method: [...methods], url: `${FA_PREFIX}/verify/:domainId`, handler });
};
