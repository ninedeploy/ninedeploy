import { HttpError } from '../lib/errors.js';
import { capture, run } from '../lib/exec.js';
import { ensureDockerImage } from '../lib/dockerPull.js';
import { HELPER_IMAGE } from '../lib/inventory.js';

/**
 * File operations inside a managed Docker volume, executed via a throwaway
 * alpine container that bind-mounts the volume read-write. Volumes have no
 * long-running container of their own, so a sidecar is the only uniform way
 * in — including for orphaned volumes whose owner was deleted.
 *
 * Paths are user-supplied and normalised hard: no absolute paths, no "..",
 * no NUL/newline tricks — the clean relative path is passed to docker as a
 * single argv element under `--`, never through a shell.
 */

/** Volume names we are willing to touch (managed nd-* only). */
export function isManagedVolume(name: string): boolean {
  return /^nd-(svc|db)-[a-z0-9-]+$/.test(name);
}

/** Choke-point guard: every volume operation below must go through this. */
function assertManagedVolume(volume: string): void {
  if (!isManagedVolume(volume)) {
    // An unvalidated name here (e.g. `/`) would make `-v /:/v` catastrophic.
    throw new Error(`Refusing to operate on non-managed volume: ${volume}`);
  }
}

/** Normalise a user-supplied path into a safe relative path ('' = root). */
export function safeRelPath(input: string): string | null {
  if (input.includes('\0') || input.includes('\n')) return null;
  const parts: string[] = [];
  for (const seg of input.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // escaping the volume root
      parts.pop();
      continue;
    }
    if (seg.length > 255) return null; // path segments are bounded
    parts.push(seg);
  }
  return parts.join('/');
}

export interface VolumeEntry {
  name: string;
  type: 'file' | 'dir';
  sizeBytes: number;
  modifiedAt: string | null;
}

const VOL_ROOT = '/v';
const VOLUME_HELPER_IMAGE = HELPER_IMAGE;
const quiet = () => undefined;

async function prepareVolumeHelper(sink: (line: string) => void = quiet): Promise<void> {
  await ensureDockerImage(VOLUME_HELPER_IMAGE, sink);
}

function volPath(rel: string): string {
  return rel ? `${VOL_ROOT}/${rel}` : VOL_ROOT;
}

/** List a directory inside the volume.
 *
 * Uses busybox `stat` (`-printf` is GNU find only — alpine's busybox find
 * rejects it and returns nothing, which made every listing read as empty).
 * Format per line: type|bytes|mtime-epoch|./name
 */
export async function listVolumeDir(
  volume: string,
  rel: string,
): Promise<VolumeEntry[]> {
  assertManagedVolume(volume);
  await prepareVolumeHelper();
  const out = await capture('docker', [
    'run', '--rm', '-v', `${volume}:${VOL_ROOT}`, VOLUME_HELPER_IMAGE,
    'sh', '-c',
    `cd ${shellQuote(volPath(rel))} 2>/dev/null && find . -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%Y|%n' {} + | sort`,
  ]);
  const entries: VolumeEntry[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [type, size, mtime, ...nameParts] = line.split('|');
    // split('/').pop() is undefined only for an empty array — join output is never empty here.
    const name = nameParts.join('|').split('/').pop()!.trim();
    if (!name) continue;
    if (type === 'directory') entries.push({ name, type: 'dir', sizeBytes: Number(size) || 0, modifiedAt: toIso(mtime) });
    else if (type === 'regular file') entries.push({ name, type: 'file', sizeBytes: Number(size) || 0, modifiedAt: toIso(mtime) });
    // other kinds (sockets, devices…) are skipped
  }
  return entries;
}

function toIso(mtime: string | undefined): string | null {
  const secs = Number(mtime);
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null;
}

/** Largest file the volume editor reads (and can therefore write back). */
export const VOLUME_FILE_READ_CAP = 1024 * 1024;

/** Read a file (text or base64 for binaries) out of the volume. */
export async function readVolumeFile(
  volume: string,
  rel: string,
): Promise<{ content: string; encoding: 'utf8' | 'base64' }> {
  assertManagedVolume(volume);
  // `''` is the volume ROOT (a directory), never a readable file: volPath('')
  // is '/v', so the generated `test -f '/v'` fails and the shell exits non-zero.
  // Guarding here — not only at the route — keeps a future non-route caller safe.
  if (!rel) throw new Error('Refusing to read the volume root — a path inside the volume is required');
  await prepareVolumeHelper();
  const out = await capture('docker', [
    'run', '--rm', '-v', `${volume}:${VOL_ROOT}`, VOLUME_HELPER_IMAGE,
    'sh', '-c',
    `test -f ${shellQuote(volPath(rel))} && head -c ${VOLUME_FILE_READ_CAP + 1} ${shellQuote(volPath(rel))} | base64`,
  ]);
  // The cap keeps a runaway log from blowing up the API/UI. r277: a file over
  // it is REFUSED — `tail -c 1M` returned the last MiB as if it were the whole
  // file, and the VolumeBrowser editor then saved that tail over the file.
  const content = out.trim();
  if (Buffer.byteLength(content.replace(/\s+/g, ''), 'base64') > VOLUME_FILE_READ_CAP) {
    throw new HttpError(
      413,
      'file_too_large',
      'File is larger than 1 MB — too large to open in the editor (it was not read, so it cannot be overwritten).',
    );
  }
  return { content, encoding: 'base64' };
}

/** Write (overwrite) a file with base64 content, creating parents as needed. */
export async function writeVolumeFile(
  volume: string,
  rel: string,
  base64: string,
  sink: (line: string) => void,
): Promise<void> {
  assertManagedVolume(volume);
  // `''` is the volume ROOT: volPath('') is '/v', so the generated command is
  // `mkdir -p '' && base64 -d > '/v'` and mkdir fails. Guarding here — not only
  // at the route — keeps a future non-route caller safe.
  if (!rel) throw new Error('Refusing to write the volume root — a path inside the volume is required');
  await prepareVolumeHelper(sink);
  // base64 is validated upstream (schemas); it rides through stdin so the
  // content never touches argv or a shell string.
  await run(
    'docker',
    [
      'run', '--rm', '-i', '-v', `${volume}:${VOL_ROOT}`, VOLUME_HELPER_IMAGE,
      'sh', '-c', `mkdir -p ${shellQuote(dirname(volPath(rel)))} && base64 -d > ${shellQuote(volPath(rel))}`,
    ],
    {},
    sink,
    Buffer.from(base64, 'utf8'),
  );
}

/** Create a directory (mkdir -p semantics). */
export async function makeVolumeDir(volume: string, rel: string): Promise<void> {
  assertManagedVolume(volume);
  await prepareVolumeHelper();
  await capture('docker', [
    'run', '--rm', '-v', `${volume}:${VOL_ROOT}`, VOLUME_HELPER_IMAGE,
    'mkdir', '-p', '--', volPath(rel),
  ]);
}

/** Delete a file or directory (recursively) inside the volume. */
export async function deleteVolumePath(
  volume: string,
  rel: string,
  sink: (line: string) => void,
): Promise<void> {
  assertManagedVolume(volume);
  // `''` is not "no path" — volPath('') === VOL_ROOT ('/v'), so `rm -rf /v`
  // would empty the entire volume. Listing and reading may address the root;
  // destroying it is never a valid file-manager operation.
  if (!rel) throw new Error('Refusing to delete the volume root — a path inside the volume is required');
  await prepareVolumeHelper(sink);
  await run(
    'docker',
    ['run', '--rm', '-v', `${volume}:${VOL_ROOT}`, VOLUME_HELPER_IMAGE, 'rm', '-rf', '--', volPath(rel)],
    {},
    sink,
  );
}

function dirname(p: string): string {
  // Callers always pass a /v-rooted path, so the slice is never empty.
  return p.slice(0, p.lastIndexOf('/'));
}

/** Single-quote a path for embedding in the alpine `sh -c` string. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
