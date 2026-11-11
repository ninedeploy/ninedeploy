import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ERROR_PAGE_MAX_BYTES } from '@ninedeploy/schemas';
import { capture } from './exec.js';
import { HttpError } from './errors.js';
import { nodeProxyDirectory } from './nodeProxyFiles.js';
import { PAGE_SERVER_DIR, PAGE_SERVER_HEALTH, PAGE_SERVER_PORT } from '../pageServer.js';

/**
 * P2, agent side: the node's page server (pageServer.ts) and the pages it
 * serves. The panel renders every page and sends one service at a time
 * (`proxy.pages.write`), then the set of services that still have pages
 * (`proxy.pages.prune`), then asks for the server (`proxy.pages.ensure`).
 *
 * The files live next to the node proxy's config, in `.agent-proxy/pages`, one
 * `<serviceId>.json` each: the name is built from an integer, never from the
 * caller. They hold no secret (they are public pages), and the server runs as
 * nobody, so they are world-readable.
 *
 * The server is the agent's own image (nothing pulled, nothing caller-chosen),
 * read-only, unprivileged, on the proxy's network, with no published port,
 * like the wake catcher. A same-name container this agent did not label is
 * never touched.
 */
export const NODE_PAGES_CONTAINER = 'ninedeploy-pages';
/** Every pages op answers one line starting with this. */
export const NODE_PAGES_REPLY = 'ND-PAGES ';
const LABEL = 'pages';
const AGENT_CONTAINER = 'ninedeploy-agent';
const PROXY_NETWORK = 'ninedeploy';
const SCRIPT = '/app/apps/server/dist/pageServer.js';
const IMAGE_VOLUME = '/data';
/** One service's file: three custom pages at the schema's cap, the maintenance page and its hosts. */
export const NODE_PAGES_MAX_BYTES = 3 * ERROR_PAGE_MAX_BYTES + 128 * 1024;

const hostname = z.string().min(1).max(253).regex(/^(\*\.)?[a-z0-9_]([a-z0-9_-]{0,62}\.)*[a-z0-9_-]{1,63}$/);
const serviceId = z.number().int().positive().max(9_999_999_999);
export const nodePagesWriteParams = z.object({
  serviceId,
  hosts: z.array(hostname).min(1).max(200),
  maintenance: z.object({ html: z.string().max(64 * 1024), text: z.string().max(4096), retryAfter: z.number().int().min(1).max(86_400) }).strict().nullable(),
  errors: z.object({ '502': z.string().max(ERROR_PAGE_MAX_BYTES), '503': z.string().max(ERROR_PAGE_MAX_BYTES), '504': z.string().max(ERROR_PAGE_MAX_BYTES) }).partial().strict(),
}).strict();
export type NodePagesWrite = z.infer<typeof nodePagesWriteParams>;
export const nodePagesPruneParams = z.object({ keep: z.array(serviceId).max(10_000) }).strict();

export function nodePagesDirectory(): string {
  const dir = join(nodeProxyDirectory(), 'pages');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  // mkdirSync's mode is masked by the umask, and an existing directory keeps its own.
  chmodSync(dir, 0o755);
  return dir;
}

/** Write one service's pages; unchanged content is left alone. */
export function writeNodePages(params: unknown): { serviceId: number; changed: boolean } {
  const p = nodePagesWriteParams.parse(params);
  const content = JSON.stringify({ hosts: p.hosts, maintenance: p.maintenance, errors: p.errors });
  if (Buffer.byteLength(content, 'utf8') > NODE_PAGES_MAX_BYTES) throw new HttpError(413, 'node_pages_too_large', 'The pages of one service are too large');
  const file = join(nodePagesDirectory(), `${p.serviceId}.json`);
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return { serviceId: p.serviceId, changed: false };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
  return { serviceId: p.serviceId, changed: true };
}

/** Remove the pages of every service not in `keep`. Only `<integer>.json` files (and stray temp files) are ever touched. */
export function pruneNodePages(params: unknown): { removed: number[] } {
  const keep = new Set(nodePagesPruneParams.parse(params).keep);
  const dir = nodePagesDirectory();
  const removed: number[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^([1-9]\d{0,9})\.json(\.tmp)?$/.exec(name);
    if (!m) continue;
    const id = Number(m[1]);
    if (keep.has(id) && !m[2]) continue;
    rmSync(join(dir, name), { force: true });
    if (!m[2]) removed.push(id);
  }
  return { removed };
}

type Inspected = { id: string; image: string; running: boolean; managed: string };
async function inspect(name: string): Promise<Inspected | null> {
  const out = await capture('docker', ['inspect', name, '--format', '{{.Id}}|{{.Image}}|{{.State.Running}}|{{index .Config.Labels "ninedeploy.managed"}}'], { timeoutMs: 15_000 }).catch(() => null);
  if (out === null) return null;
  const [id, image, running, managed] = out.trim().split('|');
  if (!/^[a-f0-9]{64}$/.test(id ?? '') || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new HttpError(502, 'node_pages_unconfirmed', 'The container identity could not be read');
  return { id: id!, image: image!, running: running === 'true', managed: managed ?? '' };
}

export const nodePagesRunArgs = (image: string, dir: string): string[] => ['run', '-d', '--name', NODE_PAGES_CONTAINER,
  '--label', `ninedeploy.managed=${LABEL}`,
  '--network', PROXY_NETWORK, '--restart', 'unless-stopped', '--no-healthcheck',
  '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
  '--memory', '64m', '--pids-limit', '64', '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
  // The image declares VOLUME /data; without this Docker would attach a writable anonymous volume.
  '--mount', `type=tmpfs,destination=${IMAGE_VOLUME},tmpfs-size=65536,tmpfs-mode=0555`,
  '--mount', `type=bind,source=${dir},destination=${PAGE_SERVER_DIR},readonly`,
  '--entrypoint', 'node', image, SCRIPT];

/** Ask the server itself, from inside its container: the proxy reaches it the same way, over the network. */
async function healthy(): Promise<boolean> {
  const probe = `fetch('http://127.0.0.1:${PAGE_SERVER_PORT}${PAGE_SERVER_HEALTH}').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))`;
  for (let i = 0; i < 20; i++) {
    const ok = await capture('docker', ['exec', NODE_PAGES_CONTAINER, 'node', '-e', probe], { timeoutMs: 10_000 }).then(() => true, () => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Create or keep the page server; a stale image or a stopped server is recreated. Answers only once it serves. */
export async function ensureNodePagesServer(): Promise<{ id: string; created: boolean }> {
  const self = await inspect(AGENT_CONTAINER);
  if (!self) throw new HttpError(409, 'node_pages_unsupported', 'The page server needs the agent to run as the ninedeploy-agent container');
  const dir = nodePagesDirectory();
  const found = await inspect(NODE_PAGES_CONTAINER);
  if (found && found.managed !== LABEL) {
    throw new HttpError(409, 'node_pages_conflict', `A container named ${NODE_PAGES_CONTAINER} exists that this agent did not create; remove or rename it`);
  }
  if (found?.running && found.image === self.image && await healthy()) return { id: found.id, created: false };
  if (found) await capture('docker', ['rm', '-fv', found.id], { timeoutMs: 30_000 });
  // A fresh node: nothing may have created the proxy's network yet.
  await capture('docker', ['network', 'create', PROXY_NETWORK], { timeoutMs: 30_000 }).catch(() => undefined);
  await capture('docker', nodePagesRunArgs(self.image, dir), { timeoutMs: 60_000 });
  const created = await inspect(NODE_PAGES_CONTAINER);
  if (!created?.running || created.image !== self.image || created.managed !== LABEL || !(await healthy())) {
    throw new HttpError(502, 'node_pages_unconfirmed', 'The page server did not start');
  }
  return { id: created.id, created: true };
}
