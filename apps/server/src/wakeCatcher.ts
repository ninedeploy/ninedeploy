import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * R2 node scale to zero (docs/NODE_SLEEP_WAKE.md): the node's wake catcher. While a node
 * service sleeps, the node proxy routes its domains here, after the domain's own middlewares,
 * with the path prefixed by `/_nd/wake/<token>`. The token is opaque and maps to a service on
 * the panel only. Each request gets the "waking up" page and leaves one `ND-WAKE` line on
 * stdout, which the agent reads back through Docker (`wake.demand`). No state, no mounts.
 */
export const WAKE_CATCHER_PORT = 8080;
export const WAKE_DEMAND_PREFIX = 'ND-WAKE ';
const TOKEN_PATH = /^\/_nd\/wake\/([a-f0-9]{32})(?:[/?]|$)/;
/** One demand line per token per second is enough; the page keeps reloading. */
const LOG_EVERY_MS = 1000;
const MAX_TRACKED = 1024;

export const wakePage = (): string => '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="3">' +
  '<title>Waking up</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;' +
  'color:#334155;background:#f8fafc}@media(prefers-color-scheme:dark){body{color:#cbd5e1;background:#0f172a}}</style></head>' +
  '<body><main><h1>Waking up</h1><p>This app was asleep. It is starting now; this page reloads by itself.</p></main></body></html>';

export interface CatcherReply { status: number; headers: Record<string, string>; body: string; token: string | null }

/** The answer for one request, and the token it asks to wake (null for anything else). */
export function catcherReply(method: string | undefined, url: string | undefined): CatcherReply {
  const token = TOKEN_PATH.exec(url ?? '')?.[1] ?? null;
  if (!token) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: 'Not found\n', token: null };
  const page = wakePage();
  return { status: 503, token, body: method === 'HEAD' ? '' : page,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5', 'content-length': String(Buffer.byteLength(page)) } };
}

/** Throttled demand lines: at most one per token per second, a bounded token table. */
export function demandLogger(write: (line: string) => void, now = () => Date.now()) {
  const last = new Map<string, number>();
  return (token: string) => {
    const at = now(), previous = last.get(token);
    if (previous !== undefined && at - previous < LOG_EVERY_MS) return;
    if (last.size >= MAX_TRACKED && previous === undefined) last.delete(last.keys().next().value!);
    last.set(token, at);
    write(`${WAKE_DEMAND_PREFIX}${JSON.stringify({ token })}`);
  };
}

export function startWakeCatcher(port = WAKE_CATCHER_PORT): http.Server {
  const demand = demandLogger(line => process.stdout.write(`${line}\n`));
  const server = http.createServer((req, res) => {
    const reply = catcherReply(req.method, req.url);
    if (reply.token) demand(reply.token);
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  });
  server.headersTimeout = 10_000; server.requestTimeout = 10_000;
  return server.listen(port, '0.0.0.0');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startWakeCatcher();
