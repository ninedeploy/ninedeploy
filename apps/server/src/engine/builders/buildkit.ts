import { createHash } from 'node:crypto';
import { run } from '../../lib/exec.js';
import { buildCacheKey } from '../../lib/buildCacheKey.js';
import { isBuildCacheRef } from '../../kernel/drivers/inlineBuildCache.js';
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
  /**
   * True only when the cache handed back a pullable reference and the build
   * actually ran with `--cache-from` (F864). A lookup hit without a ref — an
   * unpushed image, a pre-F864 entry — is a `hit` event, but not a cache hit.
   */
  cacheHit: boolean;
}

/**
 * BuildKit driver — Sprint 4, Gap G-01 (PR-B).
 *
 * Wraps `docker buildx build` with the cache contract PR #15 introduced.
 * Two new arguments over the legacy path:
 *
 *   • `--cache-from type=registry,ref=<repo>@sha256:<hex>` when the active
 *     `IBuildCache.lookup()` returns a hit that carries a pullable
 *     `BlobRef.ref` (F864). A bare content digest names no repository and
 *     is never passed to buildx.
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
  let cacheFromRef: string | null = null;
  if (opts.cache) {
    try {
      const ref = await opts.cache.lookup(cacheKey);
      if (ref) {
        // F864: only a validated `<repo>@sha256:` reference can feed
        // `--cache-from`; re-checked here because the cache is a trust boundary.
        cacheFromRef = isBuildCacheRef(ref.ref) ? ref.ref : null;
        opts.log(
          cacheFromRef
            ? `Cache hit: ${cacheKey} (${cacheFromRef}, ${ref.sizeBytes} bytes)`
            : `Cache hit: ${cacheKey} (${ref.digest}) records no pullable image reference - building without --cache-from.`,
        );
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
  // content digest: buildx resolves it against the registry (r034: `ref=empty`
  // and bare `sha256:` never resolve). F864: the reference comes only from
  // `BlobRef.ref`, which the drivers persist from the marker below; a hit
  // without one is omitted, and `--cache-to` still feeds the next build.
  if (cacheFromRef) {
    args.push('--cache-from', `type=registry,ref=${cacheFromRef}`);
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
      // F864 (marker format change): `digest` is always the bare `sha256:`
      // content digest; `ref` is the RepoDigest `<repo>@sha256:<hex>` and is
      // written only when the image has one — an unpushed image's `.Id` is a
      // local config digest no registry can serve.
      const at = imageDigest.lastIndexOf('@');
      const markerFields: { digest: string; ref?: string; ts: number } = {
        digest: at >= 0 ? imageDigest.slice(at + 1) : imageDigest,
        ts: Date.now(),
      };
      if (isBuildCacheRef(imageDigest)) markerFields.ref = imageDigest;
      const marker = Buffer.from(JSON.stringify(markerFields));
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

  return { image: opts.target, imageDigest, cacheKey, cacheHit: cacheFromRef !== null };
}

async function runInspectDigest(ref: string, log: (line: string) => void): Promise<string | null> {
  try {
    const { capture } = await import('../../lib/exec.js');
    // F256: a `--load`ed image was never pushed, so it has no RepoDigests and
    // `{{index .RepoDigests 0}}` is a template error (docker exits 1) — every
    // build then logged a failure and reported sha256(<tag string>). Fall back
    // to the image's own content id instead.
    const out = await capture('docker', [
      'inspect',
      '--format',
      '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}',
      ref,
    ]);
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
