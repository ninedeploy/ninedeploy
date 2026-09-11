/**
 * Registry manifest probing for the image auto-update watch. Public pull
 * access only — the probe asks the registry what a tag points at RIGHT NOW
 * and never pulls layers. Registries whose anonymous 401 we cannot answer
 * from the KNOWN_TOKEN_HOSTS table (private repos, unknown auth schemes)
 * surface as errors and the sweep skips them; wiring stored registry
 * credentials into the probe is a deliberate non-goal for v1.
 */

import { isDockerHub } from './imageRef.js';

/** Accept headers registries expect on manifest requests. */
const MANIFEST_ACCEPTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Anonymous pull-token endpoints for registries that 401 anonymous manifest
 * requests. Keys are registry hosts; anything absent here is treated as
 * private/unsupported when it answers 401 — we never chase a realm URL an
 * unknown registry advertises.
 */
const KNOWN_TOKEN_HOSTS: Record<string, string> = {
  'index.docker.io': 'https://auth.docker.io/token',
  'ghcr.io': 'https://ghcr.io/token',
};

/** Registries whose anonymous token request needs the canonical service id. */
const KNOWN_TOKEN_SERVICES: Record<string, string> = {
  'index.docker.io': 'registry.docker.io',
  'ghcr.io': 'ghcr.io',
};

/**
 * Optional pull credentials for a private registry — the service's attached
 * `registry` source (username + decrypted token).
 */
export interface RegistryAuth {
  username: string;
  password: string;
}

function basicAuth(auth: RegistryAuth): string {
  return ['Basic', Buffer.from(`${auth.username}:${auth.password}`).toString('base64')].join(' ');
}

/**
 * Read the current manifest digest of `repository:tag` on `registry`.
 *
 * `auth` (the service's attached registry credential) unlocks private
 * repos: the manifest request goes out with Basic auth, and if the
 * registry still wants a bearer token (Docker Hub / ghcr) the token
 * dance runs WITH the credentials instead of anonymously. Without auth
 * only public repos resolve — a 401 then names the cause.
 *
 * Throws with a human-readable reason on anything that is not a digest —
 * the sweep turns those into skips, not failed deploys.
 */
export async function fetchImageDigest(
  registry: string,
  repository: string,
  tag: string,
  auth?: RegistryAuth,
): Promise<string> {
  const host = isDockerHub(registry) ? 'index.docker.io' : registry;
  const manifestUrl = ['https:/', host, 'v2', repository, 'manifests', tag].join('/');

  let res = await probe(manifestUrl, auth ? { authorization: basicAuth(auth) } : {});
  if (res.status === 401) {
    const token = await pullToken(host, repository, auth);
    res = await probe(manifestUrl, { authorization: ['Bearer', token].join(' ') });
  }
  const digest = res.headers.get('docker-content-digest');
  if (!res.ok || !digest) {
    throw new Error(`registry answered HTTP ${res.status} without a digest`);
  }
  return digest;
}

async function probe(url: string, extraHeaders: Record<string, string>): Promise<Awaited<ReturnType<typeof fetch>>> {
  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Accept: MANIFEST_ACCEPTS, ...extraHeaders },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
    throw new Error(`registry ${reason}`);
  }
}

/**
 * Pull-scope token against the registry's KNOWN token endpoint. Anonymous
 * without `auth`; with credentials the token request itself carries Basic
 * auth, which is how private Docker Hub / ghcr repos authenticate. A 401
 * AFTER a credentialed token request means the credentials were rejected.
 */
async function pullToken(registryHost: string, repository: string, auth?: RegistryAuth): Promise<string> {
  const tokenHost = KNOWN_TOKEN_HOSTS[registryHost];
  if (!tokenHost) {
    throw new Error(
      auth
        ? 'the stored registry credential was rejected by a registry with an unsupported auth flow'
        : 'registry requires authentication and its auth flow is not supported — attach a registry credential to the service to watch private repos',
    );
  }
  const scopeParts = ['repository', repository, 'pull'];
  // Every registry in the table declares its canonical service id; the host
  // name itself is the documented default for any future entry without one.
  const params = new URLSearchParams([
    ['scope', scopeParts.join(':')],
    ['service', KNOWN_TOKEN_SERVICES[registryHost] ?? registryHost],
  ]);
  const tokenUrl = new URL(tokenHost);
  tokenUrl.search = params.toString();
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(tokenUrl.href, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(auth ? { headers: { authorization: basicAuth(auth) } } : {}),
    });
  } catch {
    throw new Error('the registry token endpoint is unreachable');
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? 'the stored registry credential was rejected (HTTP 401) — check the attached registry credential'
        : `the registry token endpoint answered HTTP ${res.status}`,
    );
  }
  const body = (await res.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) throw new Error('the registry token endpoint returned no token');
  return body.token;
}
