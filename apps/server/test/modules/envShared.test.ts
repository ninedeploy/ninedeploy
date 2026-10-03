import { describe, expect, it, vi } from 'vitest';
import { envSearchRoutes, projectEnvRoutes } from '../../src/modules/env.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  serviceId: null,
  scope: 'project',
  scopeKey: 5,
  key: 'SHARED',
  valueEncrypted: 'enc:v',
  isSecret: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('project env routes', () => {
  it('requires authentication', async () => {
    const app = await buildTestApp();
    await app.register(projectEnvRoutes);
    expect((await app.inject({ method: 'GET', url: '/5/env' })).statusCode).toBe(401);
  });

  it('lists project-scope env vars', async () => {
    const findMany = vi.fn(() => [baseRow()]);
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { projects: { id: 5 } }, findMany: { envVars: findMany } }) });
    await app.register(projectEnvRoutes);
    const res = await app.inject({ method: 'GET', url: '/5/env', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 1, key: 'SHARED', value: 'v', isSecret: false }]);
  });

  it('creates a shared env var (scope=project, scopeKey=projectId)', async () => {
    const db = createFakeDb({ findFirst: { projects: { id: 5 } }, insert: { env_vars: [baseRow({ key: 'NEW' })] } });
    const app = await buildTestApp({ db });
    await app.register(projectEnvRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/5/env',
      headers: asUser(),
      payload: { key: 'NEW', value: 'x', isSecret: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toBe('NEW');
  });

  it('forbids a viewer from modifying shared project env', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          projects: { id: 5, workspaceId: 1 },
          workspaceMembers: { id: 2, workspaceId: 1, userId: 1, role: 'viewer' },
        },
      }),
    });
    await app.register(projectEnvRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/5/env',
      headers: asUser({ isOperator: false }),
      payload: { key: 'NODE_OPTIONS', value: '--require=payload' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a duplicate shared key (constraint rejection)', async () => {
    const db = createFakeDb({
      findFirst: { projects: { id: 5 } },
      insert: { env_vars: () => { throw new Error('UNIQUE constraint failed'); } },
    });
    const app = await buildTestApp({ db });
    await app.register(projectEnvRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/5/env',
      headers: asUser(),
      payload: { key: 'DUP', value: 'v' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s when creating for a missing project', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(projectEnvRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/99/env',
      headers: asUser(),
      payload: { key: 'K', value: 'v' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates only rows in the same project scope', async () => {
    const db = createFakeDb({ findFirst: { projects: { id: 5 } }, update: { env_vars: [] } });
    const app = await buildTestApp({ db });
    await app.register(projectEnvRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/5/env/7',
      headers: asUser(),
      payload: { key: 'SHARED', value: 'next' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates an existing row', async () => {
    // The PATCH path re-loads the row to preserve its stored isSecret when
    // the payload omits the field.
    const db = createFakeDb({ findFirst: { projects: { id: 5 }, envVars: baseRow() }, update: { env_vars: [baseRow({ valueEncrypted: 'enc:next' })] } });
    const app = await buildTestApp({ db });
    await app.register(projectEnvRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/5/env/1',
      headers: asUser(),
      payload: { key: 'SHARED', value: 'next' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBe('next');
  });

  it('deletes a shared row', async () => {
    const db = createFakeDb({ findFirst: { projects: { id: 5 } } });
    const app = await buildTestApp({ db });
    await app.register(projectEnvRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/5/env/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });
});

describe('env search route', () => {
  it('returns results joined with service names', async () => {
    const db = createFakeDb({
      select: {
        env_vars: [
          { id: 1, key: 'DATABASE_URL', isSecret: true, serviceId: 3, scope: 'service', scopeKey: 3, serviceName: 'api' },
          { id: 2, key: 'DATABASE_URL', isSecret: false, serviceId: null, scope: 'project', scopeKey: 5, serviceName: null },
        ],
      },
    });
    const app = await buildTestApp({ db });
    await app.register(envSearchRoutes);
    const res = await app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent('DATA%BASE')}`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(2);
    expect(res.json().results[0]).toMatchObject({ key: 'DATABASE_URL', serviceName: 'api' });
  });

  it('rejects empty queries', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(envSearchRoutes);
    const res = await app.inject({ method: 'GET', url: '/search', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });
  });
});
