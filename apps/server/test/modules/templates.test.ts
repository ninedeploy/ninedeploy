/**
 * Template hub — coverage (G-13 community contributions).
 *
 * Covers the list / detail / community-list / import / remove
 * surface. The complex `prepare` / `deploy` paths (multi-step
 * reconcile, compose-stack construction, env rotation) need a
 * much larger fixture set; the lib-level `summary` and
 * `sameTemplateService` helpers are exercised here via the GET
 * routes that surface them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { templateRoutes } from '../../src/modules/templates.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));

const registryMock = vi.hoisted(() => ({
  getTemplates: vi.fn(async () => [
    {
      id: 'n8n',
      name: 'n8n',
      tagline: 'Workflow automation',
      category: 'automation',
      emoji: '⚙️',
      featured: true,
      runtimeVerified: true,
      verifiedAt: '2026-01-01',
      image: 'n8nio/n8n:latest',
      port: 5678,
      env: [],
    },
  ]),
}));

vi.mock('../../src/templates/registry.js', () => registryMock);

const communityMock = vi.hoisted(() => ({
  listCommunityTemplates: vi.fn(async () => ({
    entries: [
      {
        id: 'custom-1',
        template: {
          id: 'custom-1',
          name: 'Custom',
          tagline: 'community',
          category: 'misc',
          emoji: '✨',
          featured: false,
          runtimeVerified: false,
          image: 'custom/img:latest',
          port: 8080,
          env: [],
        },
      },
    ],
  })),
  importCommunityTemplate: vi.fn(async () => ({ id: 'custom-1', ok: true })),
  removeCommunityTemplate: vi.fn(async () => ({ ok: true })),
}));
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/audit.js', () => auditMock);

vi.mock('../../src/lib/communityTemplates.js', () => communityMock);

beforeEach(() => {
  for (const m of [registryMock, communityMock]) {
    for (const fn of Object.values(m)) {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    }
  }
  registryMock.getTemplates.mockResolvedValue([
    {
      id: 'n8n', name: 'n8n', tagline: 'Workflow automation',
      category: 'automation', emoji: '⚙️', featured: true,
      runtimeVerified: true, verifiedAt: '2026-01-01',
      image: 'n8nio/n8n:latest', port: 5678, env: [],
    },
  ]);
  communityMock.listCommunityTemplates.mockResolvedValue({
    entries: [
      {
        id: 'custom-1',
        template: {
          id: 'custom-1', name: 'Custom', tagline: 'community',
          category: 'misc', emoji: '✨', featured: false,
          runtimeVerified: false,
          image: 'custom/img:latest', port: 8080, env: [],
        },
      },
    ],
  });
  communityMock.importCommunityTemplate.mockResolvedValue({ id: 'custom-1', ok: true });
  communityMock.removeCommunityTemplate.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('template routes', () => {
  it('GET / merges curated and community entries (community drops id collisions)', async () => {
    // Curated `n8n` collides with a community `n8n` of the same id
    // — the community one is dropped, the curated one wins.
    communityMock.listCommunityTemplates.mockResolvedValue({
      entries: [
        {
          id: 'n8n',
          template: {
            id: 'n8n', name: 'spoof', tagline: 'spoof', category: 'misc',
            emoji: '⚠️', featured: false, runtimeVerified: false,
            image: 'spoof:latest', port: 9999, env: [],
          },
        },
        {
          id: 'custom-1',
          template: {
            id: 'custom-1', name: 'Custom', tagline: 'community',
            category: 'misc', emoji: '✨', featured: false,
            runtimeVerified: false, image: 'custom/img:latest', port: 8080, env: [],
          },
        },
      ],
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Two entries: curated `n8n` and community `custom-1`. The
    // community spoof of `n8n` is dropped to prevent shadowing the
    // shipped template.
    expect(body).toHaveLength(2);
    expect(body.map((t: { id: string }) => t.id).sort()).toEqual(['custom-1', 'n8n']);
  });

  it('GET /:id returns the template summary (with runtimeVerified coerced to boolean)', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/n8n', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('n8n');
    expect(body.name).toBe('n8n');
    expect(body.runtimeVerified).toBe(true);
  });

  it('GET /:id 404s when the template id is unknown', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/missing', headers: asUser() });
    if (res.statusCode !== 404) {
      throw new Error(`expected 404, got ${res.statusCode}: ${res.body}`);
    }
  });

  // r330: the list merged community entries but the detail and deploy
  // lookups searched the curated registry alone — the Hub showed a community
  // template, then 404'd the moment it was opened or deployed.
  it('r330: GET /:id resolves a community template the list shows', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/custom-1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'custom-1', name: 'Custom', runtimeVerified: false });
  });

  it('r330: GET /:id keeps the list precedence — a colliding community id never shadows the curated entry', async () => {
    communityMock.listCommunityTemplates.mockResolvedValue({
      entries: [{
        id: 'n8n',
        template: {
          id: 'n8n', name: 'spoof', tagline: 'spoof', category: 'misc',
          emoji: '⚠️', featured: false, runtimeVerified: false,
          image: 'spoof:latest', port: 9999, env: [],
        },
      }],
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/n8n', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'n8n', image: 'n8nio/n8n:latest' });
  });

  it('r330: POST /:id/deploy finds a community template (reaches the privilege gate, not a 404)', async () => {
    communityMock.listCommunityTemplates.mockResolvedValue({
      entries: [{
        id: 'custom-sock',
        template: {
          id: 'custom-sock', name: 'Sock', tagline: 'community', category: 'misc',
          emoji: '✨', featured: false, runtimeVerified: false,
          image: 'custom/sock:latest', port: 9000, env: [], dockerSocket: true,
        },
      }],
    });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    for (const url of ['/custom-sock/deploy', '/custom-sock/prepare']) {
      const res = await app.inject({
        method: 'POST', url, headers: asUser({ id: 2, role: 'member', isOperator: false }), payload: {},
      });
      // The lookup succeeded: the request got as far as the docker-socket
      // host-privilege check, which refuses a non-operator.
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).toMatch(/Docker socket/);
    }
  });

  it('GET /community surfaces the on-disk community-template list', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({ method: 'GET', url: '/community', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: expect.any(Array) });
    expect(communityMock.listCommunityTemplates).toHaveBeenCalledOnce();
  });

  it('POST /community/import imports a template by raw JSON content', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/community/import',
      headers: asUser(),
      payload: { content: '{"id":"custom-1","name":"Custom","image":"x","port":8080}', replace: true },
    });
    if (res.statusCode !== 200) {
      throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
    }
    expect(communityMock.importCommunityTemplate).toHaveBeenCalledWith(
      '{"id":"custom-1","name":"Custom","image":"x","port":8080}',
      { replace: true },
    );
    expect(auditMock.audit).toHaveBeenCalled();
  });

  it('POST /community/import 400s on an empty content payload', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/community/import',
      headers: asUser(),
      payload: {},
    });
    if (res.statusCode !== 400) {
      throw new Error(`expected 400, got ${res.statusCode}: ${res.body}`);
    }
    expect(communityMock.importCommunityTemplate).not.toHaveBeenCalled();
  });

  it('POST /community/import surfaces an import failure as 400', async () => {
    communityMock.importCommunityTemplate.mockRejectedValueOnce(new Error('id collision'));
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/community/import',
      headers: asUser(),
      payload: { content: '{"id":"custom-1"}' },
    });
    if (res.statusCode !== 400) {
      throw new Error(`expected 400, got ${res.statusCode}: ${res.body}`);
    }
    expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/id collision/) } });
  });

  it('DELETE /community/:id removes a community template by id', async () => {
    communityMock.removeCommunityTemplate.mockResolvedValueOnce({ ok: true, id: 'custom-1', removed: true });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/community/custom-1',
      headers: asUser(),
    });
    if (res.statusCode !== 200) {
      throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
    }
    expect(communityMock.removeCommunityTemplate).toHaveBeenCalledWith('custom-1');
    expect(auditMock.audit).toHaveBeenCalled();
  });

  it('DELETE /community/:id 404s when the template is not on disk', async () => {
    communityMock.removeCommunityTemplate.mockResolvedValueOnce({ ok: true, id: 'missing', removed: false });
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(templateRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/community/missing',
      headers: asUser(),
    });
    if (res.statusCode !== 404) {
      throw new Error(`expected 404, got ${res.statusCode}: ${res.body}`);
    }
  });
});
