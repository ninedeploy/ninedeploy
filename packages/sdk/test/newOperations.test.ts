import { expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

it('routes deployment management, identity and instance operations with their intended payloads', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const api = createClient({ baseUrl: 'https://panel.test', getToken: () => 'fixture-token', fetch });
  const cases: Array<[() => Promise<unknown>, string, string, unknown?]> = [
    [() => api.services.sizing(7), 'GET', '/v1/services/7/sizing'],
    [() => api.services.maintenance.get(7), 'GET', '/v1/services/7/maintenance'],
    [() => api.services.maintenance.set(7, null), 'PUT', '/v1/services/7/maintenance', { maintenance: null }],
    [() => api.services.errorPages.get(7), 'GET', '/v1/services/7/error-pages'],
    [() => api.services.errorPages.set(7, { 503: 'maintenance' }), 'PUT', '/v1/services/7/error-pages', { pages: { 503: 'maintenance' } }],
    [() => api.services.errors.list(7), 'GET', '/v1/services/7/errors'],
    [() => api.services.errors.list(7, 'resolved'), 'GET', '/v1/services/7/errors?status=resolved'],
    [() => api.services.errors.get(7, 9), 'GET', '/v1/services/7/errors/9'],
    [() => api.services.errors.setStatus(7, 9, 'resolved'), 'PATCH', '/v1/services/7/errors/9', { status: 'resolved' }],
    [() => api.services.errors.ingest.get(7), 'GET', '/v1/services/7/error-ingest'],
    [() => api.services.errors.ingest.create(7), 'POST', '/v1/services/7/error-ingest'],
    [() => api.services.errors.ingest.remove(7), 'DELETE', '/v1/services/7/error-ingest'],
    [() => api.services.move.get(7), 'GET', '/v1/services/7/move'],
    [() => api.services.move.start(7, 3), 'POST', '/v1/services/7/move', { serverId: 3 }],
    [() => api.services.inlineDockerfile.get(7), 'GET', '/v1/services/7/inline-dockerfile'],
    [() => api.services.inlineDockerfile.set(7, 'FROM alpine'), 'PUT', '/v1/services/7/inline-dockerfile', { content: 'FROM alpine' }],
    [() => api.services.registryHook.get(7), 'GET', '/v1/services/7/registry-hook'],
    [() => api.services.registryHook.enable(7), 'POST', '/v1/services/7/registry-hook'],
    [() => api.services.registryHook.disable(7), 'DELETE', '/v1/services/7/registry-hook'],
    [() => api.services.restartLimit.get(7), 'GET', '/v1/services/7/restart-limit'],
    [() => api.services.restartLimit.set(7, null), 'PUT', '/v1/services/7/restart-limit', { limit: null }],
    [() => api.services.pending.get(7), 'GET', '/v1/services/7/pending'],
    [() => api.services.pending.stage(7, { name: 'next' } as never), 'PUT', '/v1/services/7/pending', { name: 'next' }],
    [() => api.services.pending.setStaging(7, true), 'PUT', '/v1/services/7/pending/staging', { staging: true }],
    [() => api.services.pending.discard(7), 'DELETE', '/v1/services/7/pending'],
    [() => api.services.pending.apply(7), 'POST', '/v1/services/7/pending/apply', {}],
    [() => api.services.pending.apply(7, { deploy: true } as never), 'POST', '/v1/services/7/pending/apply', { deploy: true }],
    [() => api.domains.forwardAuth.get(4), 'GET', '/v1/domains/4/forward-auth'],
    [() => api.domains.forwardAuth.set(4, null), 'PUT', '/v1/domains/4/forward-auth', { forwardAuth: null }],
    [() => api.domains.forwardAuth.grant({ domainId: 4 } as never), 'POST', '/v1/forward-auth/grant', { domainId: 4 }],
    [() => api.domains.composeRoute.get(4), 'GET', '/v1/domains/4/compose-route'],
    [() => api.domains.composeRoute.set(4, null), 'PUT', '/v1/domains/4/compose-route', { route: null }],
    [() => api.auth.saml.publicProviders(), 'GET', '/v1/auth/saml/providers/public'],
    [() => api.auth.saml.link(2), 'POST', '/v1/auth/saml/2/link', {}],
    [() => api.auth.twoFactor.requirement(), 'GET', '/v1/auth/2fa/requirement'],
    [() => api.workspaces.twoFactor.get(3), 'GET', '/v1/workspaces/3/two-factor'],
    [() => api.workspaces.twoFactor.set(3, { required: true } as never), 'PUT', '/v1/workspaces/3/two-factor', { required: true }],
    [() => api.backups.replicas.get(6), 'GET', '/v1/databases/6/backup-replicas'],
    [() => api.backups.replicas.set(6, [{ destinationId: 1, retainCount: 3 }]), 'PUT', '/v1/databases/6/backup-replicas', { replicas: [{ destinationId: 1, retainCount: 3 }] }],
    [() => api.traefik.sharedCertificates.get(), 'GET', '/v1/traefik/certificates/shared'],
    [() => api.traefik.sharedCertificates.set(true), 'PUT', '/v1/traefik/certificates/shared', { enabled: true }],
    [() => api.gitops.get(), 'GET', '/v1/gitops'],
    [() => api.gitops.configure({ branch: 'main' } as never), 'PUT', '/v1/gitops', { branch: 'main' }],
    [() => api.gitops.remove(), 'DELETE', '/v1/gitops'],
    [() => api.gitops.check(), 'POST', '/v1/gitops/check'],
    [() => api.gitops.apply(), 'POST', '/v1/gitops/apply'],
    [() => api.gitops.export(), 'GET', '/v1/gitops/export?format=json'],
  ];
  for (const [invoke, method, path, body] of cases) {
    await expect(invoke()).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect([url, init.method]).toEqual([`https://panel.test${path}`, method]);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token');
    expect(init.body === undefined ? undefined : JSON.parse(init.body as string)).toEqual(body);
  }
  expect(fetch).toHaveBeenCalledTimes(cases.length);
});
