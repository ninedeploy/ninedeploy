import { createHash } from 'node:crypto';

/**
 * Build-cache key derivation — Sprint 4, Gap G-01 (PR-B).
 *
 * A cache key is a content-addressed string derived from every input
 * that could change the resulting layer cache: the service id, the
 * resolved Dockerfile path, the repo's build base directory, the
 * commit SHA, and (when known) the digest of the last successful
 * build. Two builds with the same inputs produce the same key, so
 * the LRU / registry / S3 backends can deduplicate by string compare
 * without inspecting the blob.
 *
 * The shape is stable so the panel can render the key without a
 * second round-trip. PR-C (registry backend) and PR-D (S3 backend)
 * consume the same string verbatim.
 */

export interface BuildCacheKeyInputs {
  serviceId: number;
  dockerfilePath: string;
  baseDir: string;
  commitSha?: string;
  lastBuildDigest?: string;
}

export function buildCacheKey(inputs: BuildCacheKeyInputs): string {
  const parts = [
    `service:${inputs.serviceId}`,
    `dockerfile:${normalizePath(inputs.dockerfilePath)}`,
    `base:${normalizePath(inputs.baseDir)}`,
    `commit:${inputs.commitSha ?? 'no-commit'}`,
    `last:${inputs.lastBuildDigest ?? 'no-prev'}`,
  ];
  const fingerprint = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
  return `ndbuild:${fingerprint}`;
}

/**
 * Best-effort path normalization so two equivalent paths (trailing
 * slash, `./` segments, Windows back-slash) hash to the same key.
 * The build context's POSIX-vs-Windows concerns live elsewhere — this
 * helper only guarantees the cache key is stable across runs.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '');
}
