import { domains, type Service, services } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { WAKE_PREFIX } from '../engine/proxy.js';
import { WAKE_WAIT_MS, wakeService, type SleepDeps } from '../lib/sleep.js';
import { sleepDeps } from '../lib/sleepRuntime.js';

/**
 * 0.16.11 scale to zero: the wake endpoint. While a service sleeps, Traefik
 * sends every request for its domains here, prefixed with `/_nd/wake` and
 * with the visitor's own Host header (engine/proxy.ts). The request wakes
 * the service and, once its healthcheck passes and its routes are back, a
 * GET or HEAD is redirected to the same URL, which the app now answers.
 * Other methods get `503` with `Retry-After`: their body cannot be replayed.
 * A wake that takes longer than 25 s answers a small "waking up" page that
 * reloads itself (no script).
 *
 * Public on purpose: a request through the domain is what wakes a service.
 * It is found by the Host header and the path, so the endpoint can only wake
 * what a request to that domain would; a domain's basic auth and allow list
 * run in Traefik before the request gets here.
 */

/** The domain row a request belongs to: its host (exact, else a `*.` wildcard), then the longest matching path. */
export async function serviceForRequest(db: SleepDeps['db'], host: string, path: string): Promise<Service | null> {
  const rows = (await db.select().from(domains).where(eq(domains.status, 'active'))).filter((d) => {
    const h = String(d.hostname ?? '').trim().toLowerCase();
    return h === host || (h.startsWith('*.') && host.endsWith(h.slice(1)) && host.split('.').length === h.split('.').length);
  });
  const exact = rows.filter((d) => String(d.hostname).trim().toLowerCase() === host);
  const matches = (exact.length > 0 ? exact : rows).filter((d) => {
    const p = String(d.path ?? '/').replace(/\/+$/, '');
    return p === '' || path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`);
  });
  matches.sort((a, b) => String(b.path ?? '').length - String(a.path ?? '').length);
  const d = matches[0];
  if (!d) return null;
  return (await db.query.services.findFirst({ where: eq(services.id, d.serviceId) })) ?? null;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, text: string, refreshSeconds: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f7f7f8;color:#1f2328}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}main{max-width:28rem;padding:1.5rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;
}

export function wakeRoutes(opts: { deps?: SleepDeps; waitMs?: number; settleMs?: number } = {}): FastifyPluginAsync {
  return async (app) => {
    const deps = opts.deps ?? sleepDeps(app.db, (line) => app.log.info({ component: 'wake' }, line));
    const waitMs = opts.waitMs ?? WAKE_WAIT_MS;
    const settleMs = opts.settleMs ?? 1500;
    // Any body: it is never read, and an unparsable one must not turn into a 400.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, _body, done) => done(null, undefined));

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
      // One leading slash only: `//evil.example` (or `/\evil.example`) in a
      // Location header would send the visitor to another site.
      const path = `/${req.url.slice(WAKE_PREFIX.length).replace(/^[/\\]+/, '')}`;
      const replayable = req.method === 'GET' || req.method === 'HEAD';
      const html = replayable && /text\/html/.test(String(req.headers.accept ?? ''));
      const unavailable = (title: string, text: string, retry: number) => {
        reply.code(503).header('retry-after', String(retry));
        return html ? reply.type('text/html; charset=utf-8').send(page(title, text, retry)) : reply.type('text/plain; charset=utf-8').send(`${title}. ${text}\n`);
      };
      const svc = host ? await serviceForRequest(deps.db, host, path.split('?')[0]!) : null;
      if (!svc) return reply.code(404).type('text/plain; charset=utf-8').send('Not found\n');
      if (svc.asleepAt == null) {
        if (svc.status !== 'running') return unavailable('This service is not running', 'It was stopped by its owner.', 30);
        // Awake already; the routes are on their way to Traefik.
        return unavailable('Starting up', `${host} is starting. This page reloads in a moment.`, 2);
      }
      const outcome = await Promise.race([
        wakeService(deps, svc, 'request'),
        new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), waitMs).unref?.()),
      ]);
      if (outcome === 'waiting') return unavailable('Waking up', `${host} was asleep and is starting. This page reloads until it is ready.`, 5);
      if (!outcome) return unavailable('Could not wake up', `${host} could not be started. This page tries again shortly.`, 15);
      // Let Traefik apply the routes back before the visitor comes again.
      await deps.sleep(settleMs);
      if (!replayable) return unavailable('Woke up', 'Send the request again.', 1);
      return reply.code(307).header('location', path).send();
    };

    const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
    app.route({ method: [...methods], url: WAKE_PREFIX, handler });
    app.route({ method: [...methods], url: `${WAKE_PREFIX}/*`, handler });
  };
}
