import { createHmac } from 'node:crypto';
import { request as loopbackRequest } from 'node:http';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { databases } from '@ninedeploy/db';
import { config } from '../config.js';
import { secretEquals } from '../lib/crypto.js';
import { notFound, unauthorized } from '../lib/errors.js';

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
 * that cookie — an iframe cannot send the panel's bearer header, and
 * SameSite=Strict stops cross-site requests from carrying it.
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

export function studioCookieValue(dbId: number, ttlS: number = COOKIE_TTL_S): { value: string; maxAgeS: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlS;
  const signature = createHmac('sha256', config.jwt.secret).update(`${dbId}:${expiresAt}`).digest('hex');
  return { value: `${expiresAt}.${signature}`, maxAgeS: ttlS };
}

export function studioCookieSetHeader(dbId: number, isHttps: boolean, ttlS: number = COOKIE_TTL_S): string {
  const { value, maxAgeS } = studioCookieValue(dbId, ttlS);
  return `${studioCookieName(dbId)}=${value}; Path=/v1/databases/${dbId}/studio-proxy/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${
    isHttps ? '; Secure' : ''
  }`;
}

export function studioCookieValid(dbId: number, cookieHeader: string | undefined, now = Date.now()): boolean {
  if (!cookieHeader) return false;
  const name = studioCookieName(dbId);
  const pair = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!pair) return false;
  const [expS, sig] = pair.slice(name.length + 1).split('.');
  const expiresAt = Number(expS);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 < now) return false;
  return secretEquals(
    createHmac('sha256', config.jwt.secret).update(`${dbId}:${expiresAt}`).digest('hex'),
    sig ?? '',
  );
}

/** Rewrite a Set-Cookie line so the studio session cookie stays scoped to
 *  this database's proxy path — two studios on one origin must never share
 *  a session cookie. */
function rewriteCookiePath(cookie: string, cookiePath: string): string {
  return /;\s*path=/i.test(cookie) ? cookie.replace(/;\s*path=[^;]*/i, `; Path=${cookiePath}`) : `${cookie}; Path=${cookiePath}`;
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
  if (!studioCookieValid(id, req.headers.cookie)) {
    throw unauthorized('Studio session expired — start it again from the database page');
  }
  const d = await app.db.query.databases.findFirst({ where: eq(databases.id, id) });
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
      // Copy raw headers pair-wise so multiple Set-Cookie lines survive, with
      // every cookie path scoped to this database's proxy prefix.
      const responseHeaders: Record<string, string | string[]> = {};
      for (let i = 0; i < ures.rawHeaders.length; i += 2) {
        const key = ures.rawHeaders[i]!;
        const value = ures.rawHeaders[i + 1] ?? '';
        const lower = key.toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue;
        if (lower === 'set-cookie') {
          const existing = responseHeaders[key];
          responseHeaders[key] = existing === undefined ? rewriteCookiePath(value, cookiePath) : ([] as string[]).concat(existing, rewriteCookiePath(value, cookiePath));
          continue;
        }
        const existing = responseHeaders[key];
        responseHeaders[key] = existing === undefined ? value : ([] as string[]).concat(existing, value);
      }
      reply.raw.writeHead(ures.statusCode ?? 502, responseHeaders);
      ures.pipe(reply.raw);
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
    if (!studioCookieValid(id, req.headers.cookie)) {
      throw unauthorized('Studio session expired — start it again from the database page');
    }
  };
  const options = { bodyLimit: 256 * 1024 * 1024, onRequest: [requireStudioSession] };
  app.all('/:id/studio-proxy', options, (req, reply) => proxyHandler(app, req, reply));
  app.all('/:id/studio-proxy/*', options, (req, reply) => proxyHandler(app, req, reply));
};
