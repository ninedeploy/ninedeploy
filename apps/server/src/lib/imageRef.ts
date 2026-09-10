/** Pure docker image-reference parsing for the auto-update watch. */

export interface ImageRef {
  registry: string;
  repository: string;
  tag: string;
}

export const DEFAULT_REGISTRY = 'index.docker.io';
const OFFICIAL_SOURCE = 'docker.io';
const HUB_API_HOST = 'registry-1.docker.io';

/** True when the ref points at Docker Hub (any of its accepted spellings). */
export function isDockerHub(registry: string): boolean {
  return registry === DEFAULT_REGISTRY || registry === OFFICIAL_SOURCE || registry === HUB_API_HOST;
}

/**
 * Parse a docker image reference into {registry, repository, tag}.
 * Returns null for anything we refuse to watch: digest-pinned refs
 * (`@sha256:…` never move, so watching them is meaningless), refs without a
 * tag, and structurally malformed input.
 */
export function parseImageRef(image: string): ImageRef | null {
  const trimmed = image.trim();
  if (!trimmed || trimmed.includes('@')) return null;
  // Registry is the first path segment only when it looks host-like.
  let rest = trimmed;
  let registry = DEFAULT_REGISTRY;
  const firstSlash = rest.indexOf('/');
  const first = firstSlash === -1 ? '' : rest.slice(0, firstSlash);
  if (firstSlash !== -1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    rest = rest.slice(firstSlash + 1);
  } else if (firstSlash === -1) {
    // `nginx` alone is docker.io/library/nginx.
    rest = ['library', trimmed].join('/');
  }
  // The tag is the segment after the LAST colon that comes after the last
  // slash — registry ports (`localhost:5000/repo`) must not read as tags.
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  let tag = 'latest';
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!rest || !tag) return null;
  if (!/^[a-z0-9._/-]+$/.test(rest) || !/^[A-Za-z0-9_.-]+$/.test(tag)) return null;
  return { registry, repository: rest, tag };
}
