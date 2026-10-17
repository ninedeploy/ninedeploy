import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, crc32, inflateRawSync } from 'node:zlib';
import { config } from '../config.js';
import { capture } from './exec.js';

/**
 * 0.16.1 deploy from an uploaded archive (Dokploy's "Drop", Railway's `up`):
 * a docker service with no repository, image or inline stack builds from the
 * last `.zip` / `.tar.gz` uploaded for it (`POST /v1/services/:id/source`,
 * `ninedeploy deploy <dir>`). The pipeline extracts the archive into the
 * service's workspace where a checkout would land, and everything after that
 * (analysis, `.ninedeploy`, build pack resolution, the build) is unchanged.
 *
 * An archive is untrusted input that is written to the panel host's disk, so
 * it is checked completely BEFORE it is stored, and again when extracted:
 *  - every member is a regular file or a directory (no symlinks, hardlinks,
 *    devices or fifos — a symlink is how `../`-free names still escape);
 *  - names are relative, without `..`, and resolve inside the target;
 *  - the member count and the extracted size are capped (zip bombs);
 *  - an encrypted, multi-disk or zip64 zip is refused rather than guessed at.
 * Zip is read here with node:zlib (no dependency); tar.gz is listed and then
 * extracted by the system `tar`, the same way the system import does.
 */

/** Largest archive accepted (compressed). */
export const SOURCE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** Largest extracted size. */
export const SOURCE_EXTRACT_MAX_BYTES = 1024 * 1024 * 1024;
/** Largest single zip member: it is inflated in memory (a .tar.gz streams through tar). */
export const SOURCE_ZIP_MEMBER_MAX_BYTES = 256 * 1024 * 1024;
/** Most members (files + directories). */
export const SOURCE_MAX_ENTRIES = 50_000;
/** Uploads kept per service (older ones are pruned; a redeploy of a pruned one fails clearly). */
export const SOURCE_KEEP = 5;

export type SourceFormat = 'zip' | 'tar.gz';

export class SourceArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceArchiveError';
  }
}

/** A docker service whose code comes from uploads: no repository, image or inline stack. */
export function isUploadSourced(service: {
  type: string;
  repoUrl?: string | null;
  image?: string | null;
  composeContent?: string | null;
}): boolean {
  return service.type === 'docker' && !service.repoUrl && !service.image && !service.composeContent;
}

/** zip (`PK\x03\x04`, or an empty archive's `PK\x05\x06`) or gzip (`\x1f\x8b`) by magic bytes; null otherwise. */
export function sniffSourceFormat(buf: Buffer): SourceFormat | null {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return 'zip';
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'tar.gz';
  return null;
}

/** OS / tooling noise that never belongs in a build context. */
function isJunk(name: string): boolean {
  return name.startsWith('__MACOSX/') || name === '__MACOSX' || path.posix.basename(name) === '.DS_Store';
}

/** A relative, `..`-free member name (directories may end in `/`). */
function safeMemberName(name: string): boolean {
  if (!name || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((part) => part === '..');
}

// ── zip ────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  dir: boolean;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  localOffset: number;
  executable: boolean;
}

/** The central directory, validated. Throws SourceArchiveError on anything not plainly safe. */
function readZip(buf: Buffer): ZipEntry[] {
  // End of central directory: 22 bytes + a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SourceArchiveError('Not a valid zip archive (no end-of-central-directory record).');
  const disk = buf.readUInt16LE(eocd + 4);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0) throw new SourceArchiveError('Multi-part zip archives are not supported.');
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new SourceArchiveError('Zip64 archives are not supported; upload a .tar.gz instead.');
  }
  if (count > SOURCE_MAX_ENTRIES) throw new SourceArchiveError(`The archive has more than ${SOURCE_MAX_ENTRIES} entries.`);
  if (cdOffset + cdSize > buf.length) throw new SourceArchiveError('Not a valid zip archive (truncated central directory).');

  const entries: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SourceArchiveError('Not a valid zip archive (bad central directory entry).');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    // Some Windows tools write `\` separators; the format says `/`.
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new SourceArchiveError('Encrypted zip archives are not supported.');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new SourceArchiveError('Zip64 archives are not supported; upload a .tar.gz instead.');
    }
    if (!safeMemberName(name)) throw new SourceArchiveError(`Unsafe path in the archive: ${JSON.stringify(name)}`);
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    const dir = name.endsWith('/') || fileType === 0o040000;
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      throw new SourceArchiveError(`Only regular files and directories are allowed in the archive (${JSON.stringify(name)} is a link or a special file).`);
    }
    if (!dir && method !== 0 && method !== 8) {
      throw new SourceArchiveError(`Unsupported compression method ${method} for ${JSON.stringify(name)}; use deflate or a .tar.gz.`);
    }
    if (size > SOURCE_ZIP_MEMBER_MAX_BYTES) {
      throw new SourceArchiveError(`${JSON.stringify(name)} is larger than ${SOURCE_ZIP_MEMBER_MAX_BYTES / 1024 / 1024} MiB; upload a .tar.gz for files that big.`);
    }
    total += size;
    if (total > SOURCE_EXTRACT_MAX_BYTES) throw new SourceArchiveError(`The archive expands to more than ${SOURCE_EXTRACT_MAX_BYTES / 1024 / 1024} MiB.`);
    if (isJunk(name)) continue;
    entries.push({ name, dir, method, compressedSize, size, crc, localOffset, executable: (unixMode & 0o111) !== 0 });
  }
  return entries;
}

function zipEntryData(buf: Buffer, e: ZipEntry): Buffer {
  const at = e.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw new SourceArchiveError(`Not a valid zip archive (bad local header for ${JSON.stringify(e.name)}).`);
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const raw = buf.subarray(start, start + e.compressedSize);
  if (raw.length !== e.compressedSize) throw new SourceArchiveError(`Not a valid zip archive (truncated data for ${JSON.stringify(e.name)}).`);
  let data: Buffer;
  try {
    // maxOutputLength: a member that inflates past its declared size is a bomb.
    data = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
  } catch {
    throw new SourceArchiveError(`Could not decompress ${JSON.stringify(e.name)}.`);
  }
  if (data.length !== e.size || crc32(data) !== e.crc) throw new SourceArchiveError(`Corrupt entry ${JSON.stringify(e.name)} (size or checksum mismatch).`);
  return data;
}

function extractZip(buf: Buffer, root: string): number {
  const entries = readZip(buf);
  const base = path.resolve(root);
  let files = 0;
  for (const e of entries) {
    const target = path.resolve(base, e.name);
    if (target !== base && !target.startsWith(base + path.sep)) throw new SourceArchiveError(`Unsafe path in the archive: ${JSON.stringify(e.name)}`);
    if (e.dir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, zipEntryData(buf, e));
    // Keep the execute bit (gradlew, mvnw, entrypoint scripts); nothing else.
    chmodSync(target, e.executable ? 0o755 : 0o644);
    files++;
  }
  return files;
}

// ── tar.gz ─────────────────────────────────────────────────────────────────

/** Bytes the gzip stream inflates to, stopping (and throwing) past the cap. */
async function gunzippedSize(buf: Buffer): Promise<number> {
  let total = 0;
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > SOURCE_EXTRACT_MAX_BYTES + 10 * 1024 * 1024) {
        gunzip.destroy(new SourceArchiveError(`The archive expands to more than ${SOURCE_EXTRACT_MAX_BYTES / 1024 / 1024} MiB.`));
      }
    });
    gunzip.on('end', resolve);
    gunzip.on('error', (err) => reject(err instanceof SourceArchiveError ? err : new SourceArchiveError('Not a valid gzip archive.')));
    Readable.from([buf]).pipe(gunzip);
  });
  return total;
}

/** List and check a tar.gz already written to `dir/archive`; returns the member count. */
async function checkTarGz(dir: string, archive: string): Promise<number> {
  const opts = { cwd: dir, timeoutMs: 120_000 };
  let names: string;
  let verbose: string;
  try {
    // Relative -f + cwd: a Windows drive-letter colon reads as a remote host to tar.
    names = await capture('tar', ['-tzf', archive], opts);
    verbose = await capture('tar', ['-tvzf', archive], opts);
  } catch {
    throw new SourceArchiveError('Not a valid .tar.gz archive.');
  }
  const members = names.split('\n').map((l) => l.trim()).filter(Boolean);
  if (members.length > SOURCE_MAX_ENTRIES) throw new SourceArchiveError(`The archive has more than ${SOURCE_MAX_ENTRIES} entries.`);
  for (const m of members) {
    const name = m.replace(/^\.\//, '');
    if (name && !safeMemberName(name)) throw new SourceArchiveError(`Unsafe path in the archive: ${JSON.stringify(m)}`);
  }
  // The type is column 0 of the verbose listing: `-` file, `d` directory;
  // `l` symlink, `h` hardlink and c/b/p/s devices are refused.
  for (const line of verbose.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new SourceArchiveError(`Only regular files and directories are allowed in the archive (found ${JSON.stringify(line)}).`);
    }
  }
  return members.length;
}

// ── storage ────────────────────────────────────────────────────────────────

export interface StoredSource {
  /** First 40 hex chars of the archive's SHA-256: the deployment's `commitSha`. */
  sha: string;
  format: SourceFormat;
  bytes: number;
  uploadedAt: string;
}

function uploadsDir(serviceId: number): string {
  return path.join(config.paths.dataDir, 'uploads', String(serviceId));
}

const ARCHIVE_RE = /^([0-9a-f]{40})\.(zip|tar\.gz)$/;

/** The kept uploads of a service, newest first. */
export function listSourceUploads(serviceId: number): StoredSource[] {
  const dir = uploadsDir(serviceId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => {
      const m = ARCHIVE_RE.exec(file);
      if (!m) return null;
      const st = statSync(path.join(dir, file));
      return { sha: m[1]!, format: m[2] as SourceFormat, bytes: st.size, uploadedAt: st.mtime.toISOString(), mtime: st.mtimeMs };
    })
    .filter((x): x is StoredSource & { mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ mtime: _m, ...rest }) => rest);
}

/**
 * Validate an uploaded archive completely, then keep it. Throws
 * SourceArchiveError (a 400) before anything is stored when it is not
 * acceptable. Prunes the service's uploads to the newest {@link SOURCE_KEEP}.
 */
export async function storeSourceUpload(serviceId: number, buf: Buffer): Promise<StoredSource & { entries: number }> {
  if (buf.length === 0) throw new SourceArchiveError('The upload is empty.');
  if (buf.length > SOURCE_UPLOAD_MAX_BYTES) throw new SourceArchiveError(`The archive is larger than ${SOURCE_UPLOAD_MAX_BYTES / 1024 / 1024} MiB.`);
  const format = sniffSourceFormat(buf);
  if (!format) throw new SourceArchiveError('Upload a .zip or a .tar.gz archive.');
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 40);
  const dir = uploadsDir(serviceId);
  mkdirSync(dir, { recursive: true });
  const file = `${sha}.${format}`;
  let entries: number;
  if (format === 'zip') {
    // Every member is inflated and checksummed now, so a corrupt upload is a
    // 400 here rather than a failed deploy later.
    const list = readZip(buf);
    for (const e of list) if (!e.dir) zipEntryData(buf, e);
    entries = list.length;
    writeFileSync(path.join(dir, file), buf);
  } else {
    await gunzippedSize(buf);
    const pending = `.pending-${sha}.tar.gz`;
    writeFileSync(path.join(dir, pending), buf);
    try {
      entries = await checkTarGz(dir, pending);
    } catch (err) {
      rmSync(path.join(dir, pending), { force: true });
      throw err;
    }
    renameSync(path.join(dir, pending), path.join(dir, file));
  }
  // Re-uploading the same bytes refreshes its place as the newest.
  const now = new Date();
  utimesSync(path.join(dir, file), now, now);
  for (const old of listSourceUploads(serviceId).slice(SOURCE_KEEP)) {
    rmSync(path.join(dir, `${old.sha}.${old.format}`), { force: true });
  }
  return { sha, format, bytes: buf.length, uploadedAt: now.toISOString(), entries };
}

/** Every upload of a service (service deletion). */
export function removeSourceUploads(serviceId: number): void {
  rmSync(uploadsDir(serviceId), { recursive: true, force: true });
}

/**
 * Extract the upload `sha` (or the newest, when null) into `workDir`,
 * replacing whatever was there. A single top-level folder — a zipped
 * directory — becomes the root. Returns what was deployed.
 */
export async function extractSourceUpload(
  serviceId: number,
  sha: string | null,
  workDir: string,
): Promise<{ sha: string; files: number; strippedFolder: string | null }> {
  const uploads = listSourceUploads(serviceId);
  const chosen = sha ? uploads.find((u) => u.sha === sha) : uploads[0];
  if (!chosen) {
    throw new SourceArchiveError(
      sha
        ? `The uploaded source ${sha.slice(0, 7)} is no longer kept (only the last ${SOURCE_KEEP} uploads are). Upload it again.`
        : 'This service has no uploaded source yet. Upload a .zip or .tar.gz (Deploys tab, or `ninedeploy deploy <dir> --service <id>`).',
    );
  }
  const archive = path.join(uploadsDir(serviceId), `${chosen.sha}.${chosen.format}`);
  const parent = path.dirname(workDir);
  mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.upload-${serviceId}-${Date.now()}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    let files: number;
    if (chosen.format === 'zip') {
      files = extractZip(readFileSync(archive), staging);
    } else {
      // Checked again: the stored file is trusted only as far as it was checked.
      const rel = path.relative(staging, archive);
      files = await checkTarGz(staging, rel);
      await capture('tar', ['-xzf', rel, '--no-same-owner', '--no-same-permissions', '-C', '.'], { cwd: staging, timeoutMs: 300_000 });
    }
    rmSync(path.join(staging, '__MACOSX'), { recursive: true, force: true });
    // A zipped folder: `myapp/…` — build from inside it.
    let root = staging;
    let strippedFolder: string | null = null;
    const top = readdirSync(staging).filter((n) => n !== '.DS_Store');
    if (top.length === 1 && statSync(path.join(staging, top[0]!)).isDirectory()) {
      root = path.join(staging, top[0]!);
      strippedFolder = top[0]!;
    }
    rmSync(workDir, { recursive: true, force: true });
    renameSync(root, workDir);
    return { sha: chosen.sha, files, strippedFolder };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
