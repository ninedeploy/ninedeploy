import { createHash } from 'node:crypto';
import { run } from '../../lib/exec.js';
import { buildCacheKey } from '../../lib/buildCacheKey.js';
import type { IBuildCache } from '../../kernel/types.js';

export interface BuildKitBuildOptions {
  /** Repository working directory (where `docker buildx` is invoked). */
  workDir: string;
  /** Resolved Dockerfile path (relative to workDir, never absolute). */
  dockerfilePath: string;
  /** Build context base directory (relative to workDir, never absolute). */
  baseDir: string;
  /** Target image reference (tag). */
  target: string;
  /** Optional commit SHA. */
  commitSha?: string;
  /** Optional digest of the last successful build (for chained caches). */
  lastBuildDigest?: string;
  /** Stable service id (the cache key is namespaced per service). */
  serviceId: number;
  /** Active build cache backend. `undefined` = legacy `docker build` path. */
  cache?: IBuildCache;
  /** Progress line sink — same shape `engine/builders/docker.ts` uses. */
  log: (line: string) => void;
  /**
   * Optional sink for `build.cache.*` bus events. Supplied by the worker so
   * the events carry the key this build actually consulted and the result it
   * actually got. Absent = no bus (tests, legacy callers).
   */
  onCacheEvent?: (event: BuildCacheEvent) => void;
}

/** One `build.cache.hit` / `.miss` / `.error` observation. */
export interface BuildCacheEvent {
  kind: 'hit' | 'miss' | 'error';
  serviceId: number;
  cache: string;
  key: string;
  digest?: string;
  sizeBytes?: number;
  reason?: string;
}

export interface BuildKitBuildResult {
  /** Image ref that was just built (`target`). */
  image: string;
  /** sha256 digest BuildKit reported for the resulting image. */
  imageDigest: string;
  /** Cache key the build consulted (empty string when no cache was active). */
  cacheKey: string;
  /** True when the build's cache-from argument was a real hit. */
  cacheHit: boolean;
}

/**
 * BuildKit driver — Sprint 4, Gap G-01 (PR-B).
 *
 * Wraps `docker buildx build` with the cache contract PR #15 introduced.
 * Two new arguments over the legacy path:
 *
 *   • `--cache-from=type=<backend>,ref=<digest>` when the active
 *     `IBuildCache.lookup()` returns a hit. The backend name drives the
 *     `--cache-from=type=...` selector; the digest drives the
 *     `,ref=...` selector.
 *   • `--cache-to=type=inline` always. BuildKit's inline cache-to
 *     produces a tarball the plugin can re-upload on success, so the
 *     next build's `--cache-from` does not have to fall back to
 *     "no-cache".
 *
 * The function returns the image digest so the pipeline can record
 * it for the next build's chained cache.
 */
export async function buildWithBuildKit(opts: BuildKitBuildOptions): Promise<BuildKitBuildResult> {
  const cacheKey = opts.cache
    ? buildCacheKey({
        serviceId: opts.serviceId,
        dockerfilePath: opts.dockerfilePath,
        baseDir: opts.baseDir,
        commitSha: opts.commitSha,
        lastBuildDigest: opts.lastBuildDigest,
      })
    : '';

  // Step 1 — ask the cache whether anything is reusable. A miss is
  // not an error: the build runs with `--cache-from=type=inline` as a
  // fallback so the next deploy at least has a place to write.
  let cacheHit = false;
  let cacheFromDigest: string | null = null;
  if (opts.cache) {
    try {
      const ref = await opts.cache.lookup(cacheKey);
      if (ref) {
        cacheHit = true;
        cacheFromDigest = ref.digest;
        opts.log(`Cache hit: ${cacheKey} (${ref.digest}, ${ref.sizeBytes} bytes)`);
        opts.onCacheEvent?.({
          kind: 'hit',
          serviceId: opts.serviceId,
          cache: opts.cache.name,
          key: cacheKey,
          digest: ref.digest,
          sizeBytes: ref.sizeBytes,
        });
      } else {
        opts.log(`Cache miss: ${cacheKey}`);
        opts.onCacheEvent?.({
          kind: 'miss',
          serviceId: opts.serviceId,
          cache: opts.cache.name,
          key: cacheKey,
        });
      }
    } catch (err) {
      // The cache is an optimisation, not a dependency. A lookup error
      // becomes a logged warning; the build still runs.
      opts.log(
        `Cache lookup failed: ${err instanceof Error ? err.message : String(err)} (continuing without cache)`,
      );
      opts.onCacheEvent?.({
        kind: 'error',
        serviceId: opts.serviceId,
        cache: opts.cache.name,
        key: cacheKey,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 2 — assemble the buildx argv. BuildKit's cache-to=inline emits
  // a small tarball the plugin re-pushes; cache-from is either the
  // digest we got back from the active backend, or the same inline
  // cache for the very first build in a fresh instance.
  const args: string[] = [
    'buildx',
    'build',
    '--progress=plain',
    '--load',
    '-t',
    opts.target,
    '-f',
    opts.dockerfilePath,
  ];
  // `--cache-from=type=registry,ref=` needs an IMAGE REFERENCE, not a bare
  // content digest: buildx resolves it against the registry. Two values used
  // to reach it that never resolve —
  //   * the literal `ref=empty` this emitted on the first build, and
  //   * the `sha256:<hex>` fallback `docker inspect` yields for a `--load`ed
  //     image that was never pushed (so it has no RepoDigests).
  // Both made buildx log a resolve error on every single build. A cache-from
  // we cannot name is simply omitted: buildx builds without it, and the
  // `--cache-to` below still gives the next build something to read.
  if (cacheFromDigest && isImageRef(cacheFromDigest)) {
    args.push('--cache-from', `type=registry,ref=${cacheFromDigest}`);
  } else if (cacheFromDigest) {
    opts.log(
      `Cache hit recorded ${cacheFromDigest}, but that is a content digest rather than a registry reference - building without --cache-from.`,
    );
  }
  args.push('--cache-to', 'type=inline');
  args.push(opts.baseDir);

  opts.log(`BuildKit: docker ${args.join(' ')}`);
  await run('docker', args, {
    cwd: opts.workDir,
    env: { DOCKER_BUILDKIT: '1' },
    heartbeatMs: 20_000,
    heartbeatLabel: `BuildKit ${opts.target}`,
  }, opts.log);

  // Step 3 — ask BuildKit for the resulting image digest via `docker
  // inspect` so the next build can chain. This is a single, fast
  // round-trip and never fails a successful build.
  const inspectOut = await runInspectDigest(opts.target, opts.log);
  const imageDigest = inspectOut ?? digestOfString(opts.target);

  // Step 4 — record the new digest in the cache so the next build can
  // hit. The inline driver accepts a small marker blob carrying the
  // digest; the registry / S3 backends will overwrite this with their
  // own blob shape in PR-C / PR-D.
  if (opts.cache) {
    try {
      const marker = Buffer.from(JSON.stringify({ digest: imageDigest, ts: Date.now() }));
      await opts.cache.store(cacheKey, marker);
      opts.log(`Cache stored: ${cacheKey} → ${imageDigest}`);
    } catch (err) {
      // A store failure must not break a successful build — the image
      // is already tagged and runnable. Surface as a warning.
      opts.log(
        `Cache store failed: ${err instanceof Error ? err.message : String(err)} (next build will miss)`,
      );
    }
  }

  return { image: opts.target, imageDigest, cacheKey, cacheHit };
}

async function runInspectDigest(ref: string, log: (line: string) => void): Promise<string | null> {
  try {
    const { capture } = await import('../../lib/exec.js');
    const out = await capture('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', ref]);
    const digest = out.trim();
    if (!digest || digest === '<no value>') return null;
    return digest;
  } catch (err) {
    log(
      `docker inspect failed for ${ref}: ${err instanceof Error ? err.message : String(err)} (falling back to tag hash)`,
    );
    return null;
  }
}

/**
 * True when `ref` is something a registry can resolve: `repo:tag`,
 * `repo@sha256:...`, or a host-qualified form of either. A bare
 * `sha256:<hex>` is a content digest with no repository, so it is not.
 */
export function isImageRef(ref: string): boolean {
  if (!ref || /\s/.test(ref)) return false;
  // A digest reference is always `repo@sha256:...`; a string that STARTS with
  // the algorithm is a bare content digest naming no repository.
  if (/^sha256:/i.test(ref)) return false;
  const name = ref.split('@')[0];
  if (!name) return false;
  // A tag or a digest must be attached to a repository name.
  return ref.includes('@sha256:') || /^[^:]+:[^:/]+$/.test(name);
}

function digestOfString(s: string): string {
  return `sha256:${createHash('sha256').update(s).digest('hex')}`;
}
