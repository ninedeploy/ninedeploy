import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * P2 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): maintenance mode and custom
 * error pages for services on a node. The node's proxy cannot reach the panel,
 * so this server, in its own container on the node proxy's network, answers
 * what the panel's `/_nd/maintenance` and `/_nd/errors` routes answer on the
 * panel host (modules/maintenance.ts). The panel renders every page; the agent
 * writes one file per service (`<id>.json`, lib/nodePages.ts) into a directory
 * mounted here read-only. No state of its own, no access to the agent.
 *
 * Every service on the node shares this server, so a page is served only when
 * the request's Host is one of that service's domains, as on the panel host:
 * one service's custom HTML never runs on another service's origin.
 */
export const PAGE_SERVER_PORT = 8080;
export const PAGE_SERVER_DIR = '/pages';
export const PAGE_SERVER_HEALTH = '/_nd/pages-health';

/** One service's pages, as the agent writes them. */
export interface NodeServicePages {
  hosts: string[];
  maintenance: { html: string; text: string; retryAfter: number } | null;
  errors: Partial<Record<'502' | '503' | '504', string>>;
}

// Anchored on the raw path: `..` segments are not resolved, so
// `/_nd/maintenance/7/../errors/5/502` is service 7's maintenance page.
const MAINTENANCE_PATH = /^\/_nd\/maintenance\/([1-9]\d{0,9})(?:\/|$)/;
const ERROR_PATH = /^\/_nd\/errors\/([1-9]\d{0,9})\/(502|503|504)$/;

const hostMatches = (hostname: string, host: string): boolean =>
  hostname === host || (hostname.startsWith('*.') && host.endsWith(hostname.slice(1)) && host.split('.').length === hostname.split('.').length);

export interface PageReply { status: number; headers: Record<string, string>; body: string }

const notFound = (): PageReply => ({ status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'Not found\n' });

/** The answer for one request; `load` reads a service's pages (null: none). Pure apart from `load`. */
export function pageReply(req: { url?: string; host?: string; accept?: string }, load: (serviceId: number) => NodeServicePages | null): PageReply {
  const path = String(req.url ?? '').split('?')[0]!;
  if (path === PAGE_SERVER_HEALTH) return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'ok\n' };
  const host = String(req.host ?? '').replace(/:\d+$/, '').toLowerCase();
  const maint = MAINTENANCE_PATH.exec(path);
  const error = maint ? null : ERROR_PATH.exec(path);
  const id = Number((maint ?? error)?.[1]);
  if (!host || !Number.isSafeInteger(id)) return notFound();
  const pages = load(id);
  if (!pages || !pages.hosts.some((h) => hostMatches(h, host))) return notFound();
  if (maint) {
    // Switched off a moment ago: the node's routes are on their way back to the app.
    const m = pages.maintenance ?? { html: '', text: 'Back in a moment. This page reloads shortly.\n', retryAfter: 5 };
    const html = /text\/html/.test(String(req.accept ?? '')) && m.html !== '';
    return {
      status: 503,
      headers: { 'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'retry-after': String(m.retryAfter), 'cache-control': 'no-store' },
      body: html ? m.html : m.text,
    };
  }
  const status = error![2] as '502' | '503' | '504';
  const body = pages.errors[status];
  if (body === undefined) return notFound();
  return { status: Number(status), headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body };
}

/** Reads `<dir>/<id>.json`, re-reading only when the file changed. A missing or broken file is "no pages". */
export function pageLoader(dir = PAGE_SERVER_DIR): (serviceId: number) => NodeServicePages | null {
  const cache = new Map<number, { stamp: string; pages: NodeServicePages | null }>();
  return (serviceId) => {
    const file = join(dir, `${serviceId}.json`);
    let stamp: string;
    try {
      const st = statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      cache.delete(serviceId);
      return null;
    }
    const hit = cache.get(serviceId);
    if (hit?.stamp === stamp) return hit.pages;
    let pages: NodeServicePages | null = null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<NodeServicePages>;
      if (Array.isArray(raw.hosts) && raw.hosts.every((h) => typeof h === 'string') && raw.errors && typeof raw.errors === 'object') {
        pages = { hosts: raw.hosts, maintenance: raw.maintenance ?? null, errors: raw.errors };
      }
    } catch {
      pages = null;
    }
    if (cache.size > 4096) cache.clear();
    cache.set(serviceId, { stamp, pages });
    return pages;
  };
}

export function startPageServer(dir = PAGE_SERVER_DIR, port = PAGE_SERVER_PORT): http.Server {
  const load = pageLoader(dir);
  const server = http.createServer((req, res) => {
    // Bodies are never read: drain them so the connection can be reused.
    req.resume();
    const reply = pageReply({ url: req.url, host: req.headers.host, accept: req.headers.accept }, load);
    res.writeHead(reply.status, reply.headers);
    res.end(req.method === 'HEAD' ? undefined : reply.body);
  });
  return server.listen(port, '0.0.0.0');
}

/* v8 ignore next */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startPageServer();
