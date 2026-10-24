import { createHmac } from 'node:crypto';
import { request as loopbackRequest } from 'node:http';
import { pipeline } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { databases, users, type Database } from '@ninedeploy/db';
import { config } from '../config.js';
import { secretEquals } from '../lib/crypto.js';
import { HttpError, notFound, unauthorized } from '../lib/errors.js';
import { getSettingString } from '../lib/settings.js';
import { isRedisFamily } from '../lib/databaseCommands.js';
import { openNodeStudioRelay } from '../lib/nodeStudio.js';
import { studioRelayRequest, type StudioRelayHeaders } from '../lib/studioRelayProtocol.js';
import { authCredentialIsLive, encodeAuthCredential, decodeAuthCredential, type AuthCredential } from '../lib/authCredential.js';

/**
 * Same-origin reverse proxy for the database Web Studio (Adminer / Redis
 * Commander).
 *
 * Why a proxy: the studio containers speak plain HTTP and would otherwise be
 * reached on a separate host port — which broke under an HTTPS panel
 * (mixed content), was blocked by the panel CSP for iframes (a cross-origin
 * port is another origin) and carried no NineDeploy authentication at all.
 * Proxying through the panel origin solves all three at once: the iframe is
 * same-origin, it rides the panel's TLS, and every request is gated by a
 * cookie the start route mints for instance operators only.
 *
 * Destination invariant: the loopback exchange below ALWAYS targets the
 * compile-time-constant host STUDIO_UPSTREAM_HOST (127.0.0.1) over plain
 * HTTP. The only variable is the port, and it is the database row's own
 * studio port — re-validated against the same 1024–65535 bounds the start
 * route enforced when it published the container. No request data can
 * change the host, the protocol or the destination; a request that fails
 * this validation simply 404s before any connection is made.
 *
 * Auth model: `POST /:id/studio` (requireAdmin) mints an HMAC-signed,
 * path-scoped, 8-hour cookie (`nd-studio-<id>`). The proxy accepts ONLY
 * that cookie — a browser tab cannot send the panel's bearer header, and
 * SameSite=Strict stops cross-site requests from carrying it. r560: the
 * cookie names the operator who minted it and its HMAC folds in their
 * `tokenVersion`; every proxied request re-loads that user, so logout (which
 * bumps tokenVersion), deactivation, deletion and operator demotion end the
 * studio session on its next request instead of up to 8 hours later.
 *
 * Isolation (r560): the studio is third-party code served on the panel
 * origin. The panel opens it in its own `noopener` tab (fresh
 * sessionStorage, no opener handle) and every proxied response carries
 * `frame-ancestors 'none'` / `X-Frame-Options: DENY`, so the studio can
 * never be framed by the panel — where `parent.sessionStorage` would hand
 * any studio XSS the panel's bearer tokens — or by anyone else.
 *
 * Subpath note: Adminer uses relative URLs and works under the proxy
 * prefix; Redis Commander is served root-relative upstream — if its assets
 * 404 under the prefix, front it with its own Traefik subdomain instead
 * and keep this proxy for Adminer only.
 */

const COOKIE_TTL_S = 8 * 60 * 60;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** The single allowed upstream host — the loopback adapter. */
const STUDIO_UPSTREAM_HOST = '127.0.0.1';

export function studioCookieName(dbId: number): string {
  return `nd-studio-${dbId}`;
}

/** The same-origin URL the panel iframes/embeds for this database. */
export function studioProxyPathFor(dbId: number): string {
  return `/v1/databases/${dbId}/studio-proxy/`;
}

/**
 * r441: settings key holding the per-instance studio-cookie epoch. The epoch
 * is folded into the cookie HMAC; bumping it (done by the password-reset
 * route) invalidates every outstanding studio cookie at once. Without it an
 * 8-hour studio cookie — a live shell into a database GUI — outlived the
 * reset that revoked everything else.
 */
export const STUDIO_EPOCH_KEY = 'studio.cookie_epoch';

/** Default epoch before any bump — valid cookies minted and checked with it. */
const DEFAULT_EPOCH = '0';

/** r560: the operator a studio cookie is bound to. */
export interface StudioCookieUser {
  id: number;
  tokenVersion: number;
}

function studioSignature(dbId: number, expiresAt: number, epoch: string, user: StudioCookieUser, credential?: AuthCredential): string {
  return createHmac('sha256', config.jwt.secret)
    .update(`studio-v2:${dbId}:${expiresAt}:${epoch}:${user.id}:${user.tokenVersion}:${credential ? encodeAuthCredential(credential) : '-'}`)
    .digest('hex');
}

/** Value shape: `<expiresAt>.<userId>.[<credential-reference>.]<hmac>`.
 *  The v2 signing domain invalidates prior unbound production cookies.
 *  (r560 — the pre-0.10.36
 *  `<expiresAt>.<hmac>` shape carried no user and is refused). */
export function studioCookieValue(
  dbId: number,
  user: StudioCookieUser,
  ttlS: number = COOKIE_TTL_S,
  epoch: string = DEFAULT_EPOCH,
  credential?: AuthCredential,
): { value: string; maxAgeS: number } {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = credential?.kind === 'legacy-access' ? Math.min(now + ttlS, credential.expiresAt) : now + ttlS;
  const binding = credential ? `${encodeAuthCredential(credential)}.` : '';
  return { value: `${expiresAt}.${user.id}.${binding}${studioSignature(dbId, expiresAt, epoch, user, credential)}`, maxAgeS: Math.max(0, expiresAt - now) };
}

export function studioCookieSetHeader(
  dbId: number,
  user: StudioCookieUser,
  isHttps: boolean,
  ttlS: number = COOKIE_TTL_S,
  epoch: string = DEFAULT_EPOCH,
  credential?: AuthCredential,
): string {
  const { value, maxAgeS } = studioCookieValue(dbId, user, ttlS, epoch, credential);
  return `${studioCookieName(dbId)}=${value}; Path=/v1/databases/${dbId}/studio-proxy/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${
    isHttps ? '; Secure' : ''
  }`;
}

/** Parse (not verify) this database's studio cookie: unexpired and
 *  well-formed, or null. */
export function parseStudioCookie(
  dbId: number,
  cookieHeader: string | undefined,
  now = Date.now(),
): { expiresAt: number; userId: number; sig: string; credential?: AuthCredential } | null {
  if (!cookieHeader) return null;
  const name = studioCookieName(dbId);
  const pair = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!pair) return null;
  const parts = pair.slice(name.length + 1).split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const expiresAt = Number(parts[0]);
  const userId = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 < now) return null;
  if (!Number.isSafeInteger(userId) || userId < 1) return null;
  const credential = parts.length === 4 ? decodeAuthCredential(parts[2]!) : undefined;
  if (credential === null) return null;
  return { expiresAt, userId, sig: parts.at(-1) ?? '', ...(credential ? { credential } : {}) };
}

/** Verify the cookie against the user it names (whose CURRENT tokenVersion
 *  the caller supplies). */
export function studioCookieValid(
  dbId: number,
  cookieHeader: string | undefined,
  user: StudioCookieUser,
  now = Date.now(),
  epoch: string = DEFAULT_EPOCH,
): boolean {
  const parsed = parseStudioCookie(dbId, cookieHeader, now);
  if (!parsed || parsed.userId !== user.id) return false;
  return secretEquals(studioSignature(dbId, parsed.expiresAt, epoch, user, parsed.credential), parsed.sig);
}

/**
 * r560: the full session check — the cookie must verify against the named
 * user's live row, and that user must still exist, be active and be an
 * instance operator (the start route is operator-only; a demoted operator's
 * studio session ends with the demotion).
 */
export async function studioSessionValid(
  db: FastifyInstance['db'],
  dbId: number,
  cookieHeader: string | undefined,
  epoch: string,
  now = Date.now(),
): Promise<boolean> {
  const parsed = parseStudioCookie(dbId, cookieHeader, now);
  if (!parsed) return false;
  const user = await db.query.users.findFirst({ where: eq(users.id, parsed.userId) });
  if (!user || user.deactivatedAt || user.isInstanceOperator !== true) return false;
  if (!studioCookieValid(dbId, cookieHeader, user, now, epoch)) return false;
  return parsed.credential ? authCredentialIsLive(db, user.id, parsed.credential, now) : true;
}

/** Rewrite a Set-Cookie line so the studio session cookie stays scoped to
 *  this database's proxy path — two studios on one origin must never share
 *  a session cookie. */
function rewriteCookiePath(cookie: string, cookiePath: string): string {
  // r560: a Domain attribute would widen the cookie to sibling hosts — drop it
  // so the studio's cookies stay host-only as well as path-scoped.
  // F172: browsers trim attribute names (`Domain =x` is a Domain) and honour
  // the LAST Path attribute, so strip EVERY Domain/Path attribute — names
  // matched whitespace-tolerantly — and append the one scoped Path last.
  const stripped = cookie.replace(/;\s*(?:domain|path)\s*(?:=[^;]*)?(?=;|$)/gi, '');
  return `${stripped}; Path=${cookiePath}`;
}

/**
 * r560: upstream response headers the proxy never relays. The studio shares
 * the panel origin, so these would act on the PANEL, not just the studio:
 *  - framing policy: replaced below by our own `frame-ancestors 'none'` /
 *    `X-Frame-Options: DENY`;
 *  - `clear-site-data` would wipe the panel's storage (a forced logout);
 *  - `service-worker-allowed` would let a studio script register a service
 *    worker scoped to `/` — i.e. controlling every panel page;
 *  - `strict-transport-security` is the panel's decision, not a studio's.
 */
const STRIPPED_UPSTREAM = new Set([
  'x-frame-options',
  'clear-site-data',
  'service-worker-allowed',
  'strict-transport-security',
]);

/** r560: appended to every studio response. A separate CSP header is an
 *  ADDITIONAL policy (browsers enforce all of them), so the studio's own CSP
 *  — Adminer ships a nonce-based one — stays intact while framing is denied
 *  regardless of any frame-ancestors the upstream sent. */
const STUDIO_FRAME_CSP = "frame-ancestors 'none'";

/** The epoch live cookies were minted under; `db`-aware (r441). */
export async function studioCookieEpoch(db: unknown): Promise<string> {
  try {
    return (await getSettingString(db as never, STUDIO_EPOCH_KEY, DEFAULT_EPOCH)) ?? DEFAULT_EPOCH;
  } catch {
    // A test fixture without the settings table — cookies minted under the
    // default epoch still work.
    return DEFAULT_EPOCH;
  }
}

const STUDIO_SESSION_EXPIRED = 'Studio session expired — open the studio again from the database page';

type StudioRequest = FastifyRequest & { studioSessionOk?: boolean };

function studioResponseHeaders(pairs: ReadonlyArray<readonly [string, string]>, cookiePath: string): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  const nominated = new Set(pairs.filter(([name]) => name.toLowerCase() === 'connection').flatMap(([, value]) => value.split(',').map(token => token.trim().toLowerCase())));
  for (const [name, raw] of pairs) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || nominated.has(key) || STRIPPED_UPSTREAM.has(key)) continue;
    const value = key === 'set-cookie' ? rewriteCookiePath(raw, cookiePath) : raw;
    const old = output[key]; output[key] = old === undefined ? value : ([] as string[]).concat(old, value);
  }
  const csp = output['content-security-policy'];
  output['content-security-policy'] = csp === undefined ? STUDIO_FRAME_CSP : ([] as string[]).concat(csp, STUDIO_FRAME_CSP);
  output['x-frame-options'] = 'DENY';
  return output;
}

async function proxyNodeStudio(app: FastifyInstance, d: Database, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cookiePath = '/v1/databases/' + d.id + '/studio-proxy';
  const fullUrl = req.raw.url ?? '/', marker = '/studio-proxy', index = fullUrl.indexOf(marker);
  let path = index < 0 ? '/' : fullUrl.slice(index + marker.length);
  if (!path.startsWith('/')) path = '/' + path;
  // Redis Commander is explicitly configured with URL_PREFIX; Adminer uses
  // relative URLs and receives its own root/query instead.
  if (isRedisFamily(d.engine)) path = cookiePath + path;
  const body = Buffer.isBuffer(req.body) ? req.body : req.rawBody !== undefined ? Buffer.from(req.rawBody) : Buffer.alloc(0);
  const headers: StudioRelayHeaders = Object.entries(req.headers).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(v => [name, String(v)] as [string, string]));
  const input = studioRelayRequest.parse({ method: req.method, path, headers, bodyBytes: body.length });
  const abort = new AbortController();
  const disconnected = () => { if (!reply.raw.writableFinished) abort.abort(); };
  req.raw.once('aborted', disconnected); req.raw.once('error', disconnected); reply.raw.once('close', disconnected);
  // IncomingMessage can emit its ECONNRESET after the response pipeline's
  // callback. Keep the once-only error listener for that late cancellation;
  // removing it with the response listeners would make the reset uncaught.
  const clean = () => { req.raw.off('aborted', disconnected); reply.raw.off('close', disconnected); };
  let channel: Awaited<ReturnType<typeof openNodeStudioRelay>> | undefined;
  try {
    channel = await openNodeStudioRelay(app.db, d, input, abort.signal);
    const selected = channel;
    void channel.ready.then(() => { selected.writable.end(body); }, () => undefined);
    const head = await channel.head;
    abort.signal.throwIfAborted();
    reply.hijack();
    reply.raw.writeHead(head.status, studioResponseHeaders(head.headers, cookiePath));
    pipeline(channel.readable, reply.raw, error => {
      clean();
      if (error) { selected.abort(); app.log.debug({ dbId: d.id }, 'node Studio proxy stream ended early'); }
    });
  } catch (error) {
    channel?.abort(); clean();
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'node_studio_unconfirmed', 'The node Studio connection could not be confirmed; retry from the database page');
  }
}

const proxyHandler = async (
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const id = Number((req.params as { id?: string }).id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw notFound('Web Studio is not running');
  }
  // Defence in depth (the onRequest gate above already checked) — reusing the
  // gate's verdict (r455/r560: no second settings + users lookup per proxied
  // request), falling back to a full check only for the direct-invocation
  // shape tests use.
  if ((req as StudioRequest).studioSessionOk !== true) {
    const epoch = await studioCookieEpoch(app.db);
    if (!(await studioSessionValid(app.db, id, req.headers.cookie, epoch))) {
      throw unauthorized(STUDIO_SESSION_EXPIRED);
    }
  }
  const d = await app.db.query.databases.findFirst({ where: eq(databases.id, id) });
  if (d?.serverId != null) return proxyNodeStudio(app, d, req, reply);
  const port = d?.webGuiEnabled === true ? d.webGuiPort : null;
  const upstream =
    port !== null && Number.isSafeInteger(port) && port >= 1024 && port <= 65535
      ? { host: STUDIO_UPSTREAM_HOST, port }
      : null;
  if (!upstream) {
    throw notFound('Web Studio is not running');
  }

  // Raw byte exchange: hijack the reply and stream both directions. Bodies
  // arrive as buffers through the parsers scoped to this plugin below.
  reply.hijack();

  const cookiePath = `/v1/databases/${id}/studio-proxy`;

  // Whatever the mount point (/v1/databases, /databases, …), everything after
  // the /studio-proxy marker maps onto the studio's root.
  const fullUrl = req.raw.url ?? '/';
  const queryIndex = fullUrl.indexOf('?');
  const query = queryIndex === -1 ? '' : fullUrl.slice(queryIndex);
  const pathname = queryIndex === -1 ? fullUrl : fullUrl.slice(0, queryIndex);
  const marker = '/studio-proxy';
  const markerIndex = pathname.indexOf(marker);
  let upstreamPath = markerIndex === -1 ? '/' : pathname.slice(markerIndex + marker.length);
  if (upstreamPath.length === 0 || !upstreamPath.startsWith('/')) upstreamPath = `/${upstreamPath}`;

  const headers: Record<string, string | number | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'content-length' || lower === 'accept-encoding') continue;
    headers[key] = value as string | string[];
  }
  headers.host = `${STUDIO_UPSTREAM_HOST}:${upstream.port}`;

  const body = Buffer.isBuffer(req.body)
    ? req.body
    : req.rawBody !== undefined
      ? Buffer.from(req.rawBody)
      : undefined;
  if (body !== undefined) headers['content-length'] = body.length;

  const upstreamReq = loopbackRequest(
    { host: upstream.host, port: upstream.port, method: req.method, path: `${upstreamPath}${query}`, headers },
    (ures) => {
      const pairs: StudioRelayHeaders = [];
      for (let i = 0; i < ures.rawHeaders.length; i += 2) pairs.push([ures.rawHeaders[i]!, ures.rawHeaders[i + 1] ?? '']);
      const responseHeaders = studioResponseHeaders(pairs, cookiePath);
      reply.raw.writeHead(ures.statusCode ?? 502, responseHeaders);
      // F173: pipeline, not pipe — a studio that dies mid-response must reset
      // the browser's response instead of leaving it open forever.
      pipeline(ures, reply.raw, (err) => {
        if (err) app.log.debug({ err, dbId: id }, 'studio proxy stream ended early');
      });
    },
  );
  upstreamReq.on('error', (err) => {
    app.log.warn({ err, dbId: id }, 'studio proxy upstream error');
    if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'content-type': 'text/plain' });
    reply.raw.end('Web Studio upstream unreachable');
  });
  req.raw.on('error', () => upstreamReq.destroy());

  if (body !== undefined) upstreamReq.write(body);
  upstreamReq.end();
};

export const studioProxyRoutes: FastifyPluginAsync = async (app) => {
  // Content-type parser SCOPED to this plugin: proxied bodies (Adminer login
  // posts, SQL file imports) arrive as raw buffers no matter their media
  // type, without registering anything globally. The wildcard loses to any
  // more specific parser inherited from the parent scope (e.g. the rawBody
  // plugin's application/json), which is fine — for those the handler reads
  // req.rawBody instead.
  const passthrough = (_req: unknown, body: unknown, done: (err: Error | null, body?: unknown) => void) => {
    done(null, body);
  };
  app.addContentTypeParser('*', { parseAs: 'buffer' }, passthrough);

  // The cookie check runs at onRequest — BEFORE body parsing (r098). In the
  // handler it came after Fastify had already buffered up to `bodyLimit`
  // (256 MiB) into memory, so any unauthenticated client could exhaust the
  // single-process panel with a few concurrent uploads. The handler keeps its
  // own check as defence in depth.
  const requireStudioSession = async (req: FastifyRequest): Promise<void> => {
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id < 1) throw notFound('Web Studio is not running');
    // r441: epoch-aware, same as the handler's defence-in-depth check below —
    // otherwise the pre-parse gate accepts cookies a bumped epoch killed.
    // r560: user-bound — the named operator's live row must still back it.
    // r455: the verdict is stashed on the request so the handler's own check
    // does not repeat the lookups per proxied request.
    const epoch = await studioCookieEpoch(app.db);
    if (!(await studioSessionValid(app.db, id, req.headers.cookie, epoch))) {
      throw unauthorized(STUDIO_SESSION_EXPIRED);
    }
    (req as StudioRequest).studioSessionOk = true;
  };
  const options = { bodyLimit: 256 * 1024 * 1024, onRequest: [requireStudioSession] };
  app.all('/:id/studio-proxy', options, (req, reply) => proxyHandler(app, req, reply));
  app.all('/:id/studio-proxy/*', options, (req, reply) => proxyHandler(app, req, reply));
};
