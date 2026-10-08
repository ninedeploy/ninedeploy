import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

/** 0.13: the GitHub App namespace, `services.github` and the Gitea `baseUrl`. */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function client(respond: (url: string) => unknown = () => ({})) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ url: path, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const body = respond(path);
    const text = body === undefined ? '' : JSON.stringify(body);
    return { ok: true, status: 200, text: async () => text } as unknown as Response;
  });
  return { api: createClient({ baseUrl: 'http://api.test', fetch: fetchMock }), calls };
}

const lastOf = (calls: Call[]): Call => {
  const call = calls[calls.length - 1];
  if (!call) throw new Error('no call recorded');
  return call;
};

describe('githubApps namespace', () => {
  it('maps every method to its route, method and body', async () => {
    const { api, calls } = client();
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.githubApps.list(), 'GET', '/v1/github-apps', undefined],
      [() => api.githubApps.get(3), 'GET', '/v1/github-apps/3', undefined],
      [
        () => api.githubApps.create({ name: 'ghes', appId: 7, privateKey: 'pem', webBaseUrl: 'https://ghe.example', apiBaseUrl: 'https://ghe.example/api/v3' }),
        'POST',
        '/v1/github-apps',
        { name: 'ghes', appId: 7, privateKey: 'pem', webBaseUrl: 'https://ghe.example', apiBaseUrl: 'https://ghe.example/api/v3' },
      ],
      [() => api.githubApps.manifest({ target: 'org', org: 'acme' }), 'POST', '/v1/github-apps/manifest', { target: 'org', org: 'acme' }],
      [() => api.githubApps.completeManifest({ code: 'c0de', state: 's.t' }), 'POST', '/v1/github-apps/manifest/complete', { code: 'c0de', state: 's.t' }],
      [() => api.githubApps.patch(3, { name: 'renamed' }), 'PATCH', '/v1/github-apps/3', { name: 'renamed' }],
      [() => api.githubApps.rotateKey(3, 'new-pem'), 'PUT', '/v1/github-apps/3/private-key', { privateKey: 'new-pem' }],
      [() => api.githubApps.webhookSync(3), 'POST', '/v1/github-apps/3/webhook/sync', undefined],
      [() => api.githubApps.rotateWebhookSecret(3), 'POST', '/v1/github-apps/3/webhook-secret/rotate', undefined],
      [() => api.githubApps.remove(3), 'DELETE', '/v1/github-apps/3', undefined],
      [() => api.githubApps.syncInstallations(3), 'POST', '/v1/github-apps/3/installations/sync', undefined],
      [() => api.githubApps.installations(3), 'GET', '/v1/github-apps/3/installations', undefined],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(lastOf(calls)).toEqual({ method, url, body });
    }
  });

  it('returns the sync counters and installations unchanged, and remove resolves to void', async () => {
    const sync = { created: 1, updated: 0, removed: 0, sourcesCreated: 1, truncated: false, installations: [{ id: 1, sourceId: 9 }] };
    const { api } = client((url) => (url.endsWith('/installations/sync') ? sync : undefined));
    await expect(api.githubApps.syncInstallations(1)).resolves.toEqual(sync);
    await expect(api.githubApps.remove(1)).resolves.toBeUndefined();
  });
});

describe('services.github', () => {
  it('maps get, link, feedback, migrate, finalize and unlink', async () => {
    const { api, calls } = client();
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => api.services.github.get(5), 'GET', '/v1/services/5/github', undefined],
      [() => api.services.github.link(5, { sourceId: 9, repoId: 42 }), 'PUT', '/v1/services/5/github', { sourceId: 9, repoId: 42 }],
      [() => api.services.github.feedback(5, { reportStatus: true }), 'PATCH', '/v1/services/5/github/feedback', { reportStatus: true }],
      [() => api.services.github.migrate(5, 9), 'POST', '/v1/services/5/github/migrate', { sourceId: 9 }],
      [() => api.services.github.finalize(5), 'POST', '/v1/services/5/github/finalize', undefined],
      [() => api.services.github.unlink(5), 'DELETE', '/v1/services/5/github', undefined],
    ];
    for (const [run, method, url, body] of cases) {
      await run();
      expect(lastOf(calls)).toEqual({ method, url, body });
    }
  });
});

describe('sources baseUrl and repoId (0.13)', () => {
  it('sends baseUrl on create and null on update, and passes repoId through repos', async () => {
    const rows = [{ name: 'r', fullName: 'o/r', url: 'https://github.com/o/r.git', defaultBranch: 'main', isPrivate: true, repoId: 42 }];
    const { api, calls } = client((url) => (url.endsWith('/repos') ? rows : { id: 1, baseUrl: 'https://git.example' }));
    await api.sources.create({ name: 'gitea', type: 'gitea', token: 't', baseUrl: 'https://git.example' });
    expect(lastOf(calls).body).toEqual({ name: 'gitea', type: 'gitea', token: 't', baseUrl: 'https://git.example' });
    await api.sources.update(1, { baseUrl: null });
    expect(lastOf(calls)).toEqual({ method: 'PATCH', url: '/v1/sources/1', body: { baseUrl: null } });
    const repos = await api.sources.repos(2);
    expect(repos[0]?.repoId).toBe(42);
  });
});
