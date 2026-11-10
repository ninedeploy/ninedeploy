import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { guardedFetch } from './egressGuard.js';
import { capture } from './exec.js';

/**
 * 0.16.3 Git LFS for repository deploys (opt-in per service). The checkout
 * holds LFS *pointer* files; this replaces each with its content before the
 * build, without the git-lfs binary:
 *
 * - The LFS API is the repository's own (`<repo>.git/info/lfs`). A repo's
 *   `.lfsconfig` is ignored: it could point the panel at any URL.
 * - Every request (the batch call, each download, each redirect hop) goes
 *   through `guardedFetch`, which refuses private addresses and pins DNS. The
 *   repository credential is sent to the repository's host only; downloads
 *   carry just the headers the LFS server handed out for them.
 * - Each object is checked against its SHA-256 and size, with limits on the
 *   number of objects and the bytes per object and in all.
 */

export const LFS_MAX_OBJECTS = 10_000;
export const LFS_MAX_OBJECT_BYTES = 2 * 1024 ** 3;
export const LFS_MAX_TOTAL_BYTES = 5 * 1024 ** 3;
const BATCH_SIZE = 100;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const LFS_MEDIA = 'application/vnd.git-lfs+json';
/** A pointer file is small; anything larger is content, not a pointer. */
const MAX_POINTER_BYTES = 1024;
const POINTER_RE = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n/;

export const GIT_LFS_PANEL_ONLY =
  'Git LFS files are fetched for builds on the panel host only; a build on a node or a build server would get pointer files. Build on the panel (Service → Settings → Build on: panel, or leave the placement unset) or turn Git LFS off.';

export interface LfsPointer {
  path: string;
  oid: string;
  size: number;
}

/** The LFS pointers in the checkout's tracked files (symlinks and large files are skipped). */
export async function findLfsPointers(dir: string): Promise<LfsPointer[]> {
  const listed = await capture('git', ['-C', dir, 'ls-files', '-z'], { maxOutputBytes: 64 * 1024 * 1024 });
  const pointers: LfsPointer[] = [];
  const buf = Buffer.alloc(MAX_POINTER_BYTES);
  for (const rel of listed.split('\0')) {
    if (!rel) continue;
    const file = path.join(dir, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_POINTER_BYTES || st.size < 40) continue;
    const fd = openSync(file, 'r');
    let n = 0;
    try {
      n = readSync(fd, buf, 0, MAX_POINTER_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    const m = POINTER_RE.exec(buf.subarray(0, n).toString('utf8'));
    if (m) pointers.push({ path: rel, oid: m[1]!, size: Number(m[2]) });
  }
  return pointers;
}

/** `https://host/owner/repo(.git)` → `https://host/owner/repo.git/info/lfs`; null for anything but http(s). */
export function lfsEndpoint(repoUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = `${base.endsWith('.git') ? base : `${base}.git`}/info/lfs`;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

interface BatchObject {
  oid: string;
  size: number;
  actions?: { download?: { href: string; header?: Record<string, string> } };
  error?: { code: number; message: string };
}

/** GET with redirects followed by hand, each hop vetted; headers stay on the first host. */
async function guardedGet(href: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let url = href;
  let sendHeaders = headers;
  const origin = new URL(href).host;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await guardedFetch(url, { headers: sendHeaders, signal });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    if (!location) return res;
    url = new URL(location, url).toString();
    // Object storage signs its own URLs; never forward the LFS server's headers elsewhere.
    if (new URL(url).host !== origin) sendHeaders = {};
  }
  throw new Error('Git LFS download: too many redirects');
}

/**
 * Replace every LFS pointer in `dir` with its content. `auth` is the
 * repository credential (basic auth), sent to the repository host only.
 */
export async function fetchLfsObjects(
  dir: string,
  repoUrl: string,
  auth: { username: string; password: string } | null,
  log: (line: string) => void,
): Promise<{ files: number; bytes: number }> {
  const endpoint = lfsEndpoint(repoUrl);
  if (!endpoint) throw new Error('Git LFS needs an HTTPS repository URL; this repository is cloned over SSH.');
  const pointers = await findLfsPointers(dir);
  if (pointers.length === 0) {
    log('Git LFS: no LFS files in this commit');
    return { files: 0, bytes: 0 };
  }
  const objects = new Map<string, number>();
  for (const p of pointers) objects.set(p.oid, p.size);
  if (objects.size > LFS_MAX_OBJECTS) throw new Error(`Git LFS: ${objects.size} objects, more than the ${LFS_MAX_OBJECTS} a deploy fetches`);
  let total = 0;
  for (const size of objects.values()) {
    if (size > LFS_MAX_OBJECT_BYTES) throw new Error(`Git LFS: an object of ${size} bytes is over the ${LFS_MAX_OBJECT_BYTES}-byte limit`);
    total += size;
  }
  if (total > LFS_MAX_TOTAL_BYTES) throw new Error(`Git LFS: ${total} bytes in all, over the ${LFS_MAX_TOTAL_BYTES}-byte limit`);
  log(`Git LFS: fetching ${objects.size} object(s), ${total} bytes, for ${pointers.length} file(s) from ${new URL(endpoint).host}`);

  const apiHeaders: Record<string, string> = { Accept: LFS_MEDIA, 'Content-Type': LFS_MEDIA };
  if (auth) apiHeaders['Authorization'] = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  const store = path.join(dir, '.git', 'nd-lfs');
  rmSync(store, { recursive: true, force: true });
  const fetched = new Map<string, string>();
  const entries = [...objects.entries()];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const chunk = entries.slice(i, i + BATCH_SIZE).map(([oid, size]) => ({ oid, size }));
    const res = await guardedFetch(`${endpoint}/objects/batch`, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: chunk }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(
        `Git LFS: the repository's LFS API answered ${res.status}${res.status === 401 || res.status === 403 || res.status === 404 ? ' — a private repository needs a Git credential with read access' : ''}`,
      );
    }
    const body = (await res.json()) as { objects?: BatchObject[] };
    for (const obj of body.objects ?? []) {
      if (!objects.has(obj.oid)) continue;
      if (obj.error) throw new Error(`Git LFS: object ${obj.oid.slice(0, 12)} — ${obj.error.message} (${obj.error.code})`);
      const download = obj.actions?.download;
      if (!download?.href) throw new Error(`Git LFS: no download offered for object ${obj.oid.slice(0, 12)}`);
      fetched.set(obj.oid, await downloadObject(store, obj.oid, objects.get(obj.oid)!, download.href, download.header ?? {}));
    }
  }
  const missing = [...objects.keys()].filter((oid) => !fetched.has(oid));
  if (missing.length > 0) throw new Error(`Git LFS: the server did not return ${missing.length} object(s), e.g. ${missing[0]!.slice(0, 12)}`);

  for (const p of pointers) {
    // A copy per path, so two paths sharing an object never share an inode.
    await pipeline(createReadStream(fetched.get(p.oid)!), createWriteStream(path.join(dir, p.path)));
  }
  rmSync(store, { recursive: true, force: true });
  log(`Git LFS: ${pointers.length} file(s) replaced with their content`);
  return { files: pointers.length, bytes: total };
}

/** Download one object to `store`, verifying size and SHA-256 as it streams. */
async function downloadObject(store: string, oid: string, size: number, href: string, headers: Record<string, string>): Promise<string> {
  const res = await guardedGet(href, headers, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Git LFS: downloading object ${oid.slice(0, 12)} answered ${res.status}`);
  }
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const tmp = path.join(store, `${oid}.part`);
  const hash = createHash('sha256');
  let seen = 0;
  const source = Readable.fromWeb(res.body as never);
  source.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > size) source.destroy(new Error(`Git LFS: object ${oid.slice(0, 12)} is larger than its pointer says`));
    hash.update(chunk);
  });
  await pipeline(source, createWriteStream(tmp));
  if (seen !== size || hash.digest('hex') !== oid) {
    rmSync(tmp, { force: true });
    throw new Error(`Git LFS: object ${oid.slice(0, 12)} does not match its pointer (size or SHA-256)`);
  }
  const final = path.join(store, oid);
  renameSync(tmp, final);
  return final;
}
