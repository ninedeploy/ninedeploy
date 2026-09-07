/**
 * Docker image inventory + retention.
 *
 * `ninedeploy images {ls,prune}` — give the operator a list
 * of every image on the host with repo / tag / size / created
 * / dangling / in-use status, and a prune command that can
 * keep the most recent N (per repository) and / or strip
 * anything older than X hours. The companion
 * `housekeeping.autoPrune` already does a one-shot
 * `docker image prune -af`; this module is the
 * operator-driven, fine-grained counterpart.
 *
 * The same `docker image ls --format '{{json .}}'` parser
 * feeds both list and prune — prune's dryRun echoes the
 * "would delete" set so the operator can sanity-check
 * before a real delete.
 */
import { capture, run } from './exec.js';

export interface ImageInfo {
  /** Repo name (e.g. `nginx`, `ghcr.io/org/app`). */
  repository: string;
  /** Tag (e.g. `1.27-alpine`, `latest`, `<none>`). */
  tag: string;
  /** Full image id (sha256 digest). */
  id: string;
  /** Compressed size as reported by docker (human-readable). */
  size: string;
  /** Raw byte count (best-effort parse of `size`). */
  sizeBytes: number;
  /** When the image was created, as reported by docker. */
  createdAt: string;
  /** Age in hours (computed from createdAt vs now). */
  ageHours: number;
  /** True when the image is dangling (repo/tag both `<none>`). */
  dangling: boolean;
  /** True when at least one container is currently using the image. */
  inUse: boolean;
}

export interface PruneOptions {
  /** Keep at least this many images per repository (newest first). */
  keepLast?: number;
  /** Only prune images older than this many hours. */
  olderThanHours?: number;
  /** Dangling-only mode (repo/tag both `<none>`). */
  danglingOnly?: boolean;
  /** Report what would be deleted without actually deleting. */
  dryRun?: boolean;
}

export interface PruneResult {
  /** Reclaimed bytes as reported by `docker image prune`. */
  freedBytes: number;
  /** Image ids that were deleted (or would be, on dryRun). */
  removed: string[];
  /** Same as `removed` but with the human-readable repo:tag. */
  removedLabels: string[];
  /** True when this was a dryRun (no actual delete). */
  dryRun: boolean;
  /** Docker's stdout (e.g. "Total reclaimed space: 1.2GB"). */
  output: string;
}

/**
 * List every image on the host. The default `docker image ls`
 * output is human-readable; we use the JSON format and parse
 * each line, which is the only way to get the exact byte
 * counts and the per-image id in a single round-trip.
 */
export async function listImages(): Promise<ImageInfo[]> {
  let raw: string;
  try {
    // `--format '{{json .}}'` is supported on every supported
    // docker engine version; one JSON object per line.
    raw = await capture('docker', [
      'image',
      'ls',
      '--no-trunc',
      '--format',
      '{{json .}}',
    ]);
  } catch (err) {
    throw new Error(
      `docker image ls failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const now = Date.now();
  const ids = new Set<string>();
  const rows: ImageInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(line) as Record<string, string>;
    } catch {
      continue;
    }
    const repository = parsed.Repository ?? '<none>';
    const tag = parsed.Tag ?? '<none>';
    const id = parsed.ID ?? '';
    const size = parsed.Size ?? '0B';
    const createdAt = parsed.CreatedAt ?? new Date(0).toISOString();
    const ageMs = now - new Date(createdAt).getTime();
    const ageHours = Number.isFinite(ageMs) && ageMs > 0 ? ageMs / 3_600_000 : 0;
    rows.push({
      repository,
      tag,
      id,
      size,
      sizeBytes: parseHumanBytes(size),
      createdAt,
      ageHours,
      dangling: repository === '<none>' && tag === '<none>',
      inUse: false, // populated in the second pass below
    });
    if (id) ids.add(id);
  }

  // Second pass: `docker ps` reports which images are in use.
  // A single round-trip covers every container, including ones
  // NineDeploy did not start (operator's own side-car work).
  const inUse = await inUseImageIds(ids);
  for (const r of rows) r.inUse = inUse.has(r.id);

  return rows;
}

/**
 * Prune images with operator-supplied filters. The `keepLast`
 * rule is applied first: we identify every repo:tag with more
 * than N images, mark all but the newest N as candidates, and
 * `docker image rm` the candidates that ALSO match the
 * older-than and dangling filters. Dangling-only is a single
 * `docker image prune -f` call.
 *
 * On `dryRun`, no `rm` is issued — the candidate set is
 * returned in `removed` so the caller can render it.
 */
export async function pruneImages(opts: PruneOptions = {}): Promise<PruneResult> {
  const keepLast = Math.max(0, opts.keepLast ?? 0);
  const olderThanHours = opts.olderThanHours ?? 0;
  const danglingOnly = opts.danglingOnly ?? false;
  const dryRun = opts.dryRun ?? false;

  const images = await listImages();

  // 1. Dangling-only path.
  if (danglingOnly) {
    // When keepLast is set, docker image prune -f cannot honour the keep window —
    // it has no --keep-last equivalent. Filter dangling candidates client-side
    // and delete only the unprotected ones via docker image rm.
    if (keepLast > 0) {
      const dangling = images.filter(img => img.repository === '<none>');
      dangling.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const toDelete = keepLast < dangling.length ? dangling.slice(keepLast) : [];
      const freedBytes = toDelete.reduce((sum, img) => sum + img.size, 0);
      const removed: string[] = [];
      if (!dryRun && toDelete.length > 0) {
        try {
          await run('docker', ['image', 'rm', ...toDelete.map(img => img.id)]);
          removed.push(...toDelete.map(img => img.id));
        } catch (err) {
          throw new Error(`docker image rm failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { freedBytes, removed, removedLabels: [], dryRun, output: '' };
    }

    // keepLast === 0: the simple prune path is correct.
    const args = ['image', 'prune', '-f'];
    if (olderThanHours > 0) args.push('--filter', `until=${olderThanHours}h`);
    let out: string;
    try {
      out = await capture('docker', args);
    } catch (err) {
      throw new Error(`docker image prune failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      freedBytes: parseReclaimedBytes(out),
      removed: [],
      removedLabels: [],
      dryRun,
      output: out.trim(),
    };
  }

  // 2. Build the per-repository keep set: newest N of each repo.
  //    The group key must be the REPOSITORY, not `repo:tag`: a tag
  //    reference maps to exactly one image id (re-tagging moves it), so
  //    repo:tag groups are always singletons — a repo:tag key would make
  //    every tagged image its own group's "newest" member and keepLast
  //    would protect the entire tagged inventory (a silent no-op).
  //    `createdAt` is a string; sort lexicographically when
  //    the format is comparable (ISO 8601), else fall back
  //    to image id which is monotonic on the docker side.
  const groups = new Map<string, ImageInfo[]>();
  for (const img of images) {
    const key = img.repository;
    if (img.dangling) continue; // dangling handled by the dangling path
    const list = groups.get(key) ?? [];
    list.push(img);
    groups.set(key, list);
  }
  const protectedIds = new Set<string>();
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
      return b.id.localeCompare(a.id);
    });
    // Protect the newest N (list[0..keep-1]). Anything past
    // that is fair game for the candidate filter below.
    const keep = Math.min(Math.max(0, keepLast), list.length);
    for (let i = 0; i < keep; i += 1) protectedIds.add(list[i]!.id);
  }

  // 3. Filter candidates: not in the keep window, not in use,
  //    and old enough.
  const candidates: ImageInfo[] = [];
  for (const img of images) {
    if (img.inUse) continue;
    if (protectedIds.has(img.id)) continue;
    if (img.dangling) continue;
    if (olderThanHours > 0 && img.ageHours < olderThanHours) continue;
    candidates.push(img);
  }

  if (dryRun) {
    return {
      freedBytes: candidates.reduce((acc, c) => acc + c.sizeBytes, 0),
      removed: candidates.map((c) => c.id),
      removedLabels: candidates.map((c) => `${c.repository}:${c.tag}`),
      dryRun: true,
      output: `dryRun: would remove ${candidates.length} images (${formatBytes(candidates.reduce((acc, c) => acc + c.sizeBytes, 0))})`,
    };
  }

  // 4. Real delete. `docker image rm` accepts many ids; we
  //    chunk to keep the argv short.
  const removed: string[] = [];
  const removedLabels: string[] = [];
  const CHUNK = 50;
  const sink = (_line: string): void => undefined;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const slice = candidates.slice(i, i + CHUNK);
    const args = ['image', 'rm', ...slice.map((c) => c.id)];
    try {
      await run('docker', args, { timeoutMs: 60_000 }, sink);
      for (const c of slice) {
        removed.push(c.id);
        removedLabels.push(`${c.repository}:${c.tag}`);
      }
    } catch (err) {
      // Continue with the rest; a single `rm` failure
      // (image already gone, dangling ref, etc.) should
      // not block the other chunks.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[images] prune chunk failed: ${msg}`);
    }
  }

  return {
    freedBytes: candidates.filter((c) => removed.includes(c.id)).reduce((acc, c) => acc + c.sizeBytes, 0),
    removed,
    removedLabels,
    dryRun: false,
    output: `Removed ${removed.length} images (${formatBytes(
      candidates.filter((c) => removed.includes(c.id)).reduce((acc, c) => acc + c.sizeBytes, 0),
    )})`,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function inUseImageIds(allIds: Set<string>): Promise<Set<string>> {
  if (allIds.size === 0) return new Set();
  // `--format '{{.Image}}'` reports the image id (sha) of
  // every running container, including ones NineDeploy did
  // not start. The grep filter on the truncated form is
  // intentionally NOT used — we want exact matches.
  let raw: string;
  try {
    raw = await capture('docker', ['ps', '--no-trunc', '--format', '{{.Image}}']);
  } catch {
    return new Set();
  }
  const used = new Set<string>();
  for (const line of raw.split('\n')) {
    const id = line.trim();
    if (id && allIds.has(id)) used.add(id);
  }
  return used;
}

/**
 * Parse a docker human-readable size string ("1.2GB",
 * "850MB", "12kB") into bytes. Returns 0 on any unrecognised
 * format — the panel then sorts by `sizeBytes` 0 == unknown.
 */
export function parseHumanBytes(s: string): number {
  const m = /^([\d.]+)\s*([KMGTP]?B)$/i.exec(s.trim());
  if (!m) return 0;
  const val = parseFloat(m[1]!);
  const unit = m[2]!.toUpperCase();
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5 };
  return Math.round(val * (mult[unit] ?? 0));
}

export function parseReclaimedBytes(output: string): number {
  const m = /Total reclaimed space:\s*([\d.]+)\s*([KMGT]?B)/i.exec(output);
  if (!m) return 0;
  const val = parseFloat(m[1]!);
  const unit = m[2]!.toUpperCase();
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(val * (mult[unit] ?? 0));
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${units[i]}`;
}
