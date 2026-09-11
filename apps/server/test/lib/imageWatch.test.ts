import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchImageDigest } from '../../src/lib/imageWatch.js';

/**
 * Registry digest probing for the auto-update sweep. fetch is stubbed —
 * the mock answers from a queue so each test scripts the exact round-trips
 * (direct success, Hub token dance, ghcr token dance, unsupported auth,
 * unreachable, missing digest).
 */

type FakeRes = { status: number; headers?: Record<string, string>; body?: unknown };

function res(status: number, headers: Record<string, string> = {}, body?: unknown): FakeRes {
  return { status, headers, body };
}

const HUB_401_HEADERS = {
  'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
};

function makeFetch(responses: FakeRes[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), headers });
    const next = queue.shift() ?? res(500, {}, 'no scripted response');
    const bodyStr = next.body === undefined ? '' : JSON.stringify(next.body);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (k: string) => next.headers?.[k.toLowerCase()] ?? null },
      json: async () => (bodyStr === '' ? undefined : JSON.parse(bodyStr)),
      text: async () => bodyStr,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchImageDigest', () => {
  it('reads the manifest digest from a direct anonymous response', async () => {
    const { calls } = makeFetch([
      res(200, { 'docker-content-digest': 'sha256:direct' }),
    ]);
    const digest = await fetchImageDigest('index.docker.io', 'library/nginx', '1.27');
    expect(digest).toBe('sha256:direct');
    expect(calls[0]!.url).toBe('https://index.docker.io/v2/library/nginx/manifests/1.27');
    expect(calls[0]!.headers.Accept).toContain('application/vnd.oci.image.index.v1+json');
    expect(calls).toHaveLength(1);
  });

  it('performs the Docker Hub anonymous token dance on 401', async () => {
    const { calls } = makeFetch([
      res(401, HUB_401_HEADERS),
      res(200, {}, { token: 'hub-token' }),
      res(200, { 'docker-content-digest': 'sha256:hub' }),
    ]);
    const digest = await fetchImageDigest('docker.io', 'acme/web', 'latest');
    expect(digest).toBe('sha256:hub');
    expect(calls[1]!.url).toBe(
      'https://auth.docker.io/token?scope=repository%3Aacme%2Fweb%3Apull&service=registry.docker.io',
    );
    expect(calls[2]!.headers.authorization).toBe('Bearer hub-token');
  });

  it('performs the ghcr token dance with its own realm', async () => {
    const { calls } = makeFetch([
      res(401, { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }),
      res(200, {}, { token: 'ghcr-token' }),
      res(200, { 'docker-content-digest': 'sha256:ghcr' }),
    ]);
    const digest = await fetchImageDigest('ghcr.io', 'acme/web', 'main');
    expect(digest).toBe('sha256:ghcr');
    expect(calls[1]!.url).toBe('https://ghcr.io/token?scope=repository%3Aacme%2Fweb%3Apull&service=ghcr.io');
  });

  it('refuses to chase realms of registries outside the known table', async () => {
    makeFetch([res(401, { 'www-authenticate': 'Bearer realm="https://evil.example/token"' })]);
    await expect(fetchImageDigest('evil.example', 'a/b', 'latest')).rejects.toThrow(
      /requires authentication and its auth flow is not supported/,
    );
  });

  it('reports the registry status when the retry also fails', async () => {
    makeFetch([
      res(401, HUB_401_HEADERS),
      res(200, {}, { token: 'hub-token' }),
      res(403, {}),
    ]);
    await expect(fetchImageDigest('index.docker.io', 'library/nginx', 'latest')).rejects.toThrow(
      'registry answered HTTP 403 without a digest',
    );
  });

  it('rejects a 200 that carries no digest header', async () => {
    makeFetch([res(200, {})]);
    await expect(fetchImageDigest('index.docker.io', 'library/nginx', 'latest')).rejects.toThrow(
      'without a digest',
    );
  });

  it('maps network failures to a readable reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    await expect(fetchImageDigest('index.docker.io', 'library/nginx', 'latest')).rejects.toThrow(
      'registry is unreachable',
    );
  });

  it('names timeouts distinctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      }),
    );
    await expect(fetchImageDigest('index.docker.io', 'library/nginx', 'latest')).rejects.toThrow(
      'registry timed out',
    );
  });

  it('reports a token endpoint failure instead of retrying blindly', async () => {
    makeFetch([res(401, HUB_401_HEADERS), res(500, {})]);
    await expect(fetchImageDigest('index.docker.io', 'library/nginx', 'latest')).rejects.toThrow(
      'the registry token endpoint answered HTTP 500',
    );
  });

  it('probes private repos with Basic auth when credentials are given', async () => {
    const { calls } = makeFetch([res(200, { 'docker-content-digest': 'sha256:private' })]);
    const digest = await fetchImageDigest('registry.acme.io', 'team/app', 'latest', {
      username: 'robot',
      password: 'secret',
    });
    expect(digest).toBe('sha256:private');
    expect(calls[0]!.url).toBe('https://registry.acme.io/v2/team/app/manifests/latest');
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('robot:secret').toString('base64')}`);
  });

  it('runs the token dance WITH credentials for private Docker Hub repos', async () => {
    const { calls } = makeFetch([
      res(401, HUB_401_HEADERS),
      res(200, {}, { token: 'cred-token' }),
      res(200, { 'docker-content-digest': 'sha256:private-hub' }),
    ]);
    const digest = await fetchImageDigest('index.docker.io', 'acme/web', 'latest', {
      username: 'robot',
      password: 'secret',
    });
    expect(digest).toBe('sha256:private-hub');
    // The token request itself carries the Basic credential.
    expect(calls[1]!.headers.authorization).toBe(`Basic ${Buffer.from('robot:secret').toString('base64')}`);
    expect(calls[2]!.headers.authorization).toBe('Bearer cred-token');
  });

  it('names rejected credentials when the token endpoint answers 401', async () => {
    makeFetch([
      res(401, HUB_401_HEADERS),
      res(401, HUB_401_HEADERS),
    ]);
    await expect(
      fetchImageDigest('index.docker.io', 'acme/private', 'latest', { username: 'robot', password: 'wrong' }),
    ).rejects.toThrow('the stored registry credential was rejected');
  });

  it('still refuses unknown auth realms for credentialed probes', async () => {
    makeFetch([res(401, { 'www-authenticate': 'Bearer realm="https://evil.example/token"' })]);
    await expect(
      fetchImageDigest('evil.example', 'a/b', 'latest', { username: 'robot', password: 'secret' }),
    ).rejects.toThrow('unsupported auth flow');
  });

  it('reports an unreachable token endpoint', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1) return { ok: false, status: 401, headers: { get: () => HUB_401_HEADERS['www-authenticate'] } } as unknown as Response;
        throw new Error('connect EHOSTUNREACH');
      }),
    );
    await expect(fetchImageDigest('index.docker.io', 'library/nginx', 'latest')).rejects.toThrow(
      'the registry token endpoint is unreachable',
    );
  });

  it('rejects a token response that carries no token', async () => {
    makeFetch([res(401, HUB_401_HEADERS), res(200, {}, { unexpected: true })]);
    await expect(fetchImageDigest('index.docker.io', 'library/nginx', 'latest')).rejects.toThrow(
      'the registry token endpoint returned no token',
    );
  });
});
