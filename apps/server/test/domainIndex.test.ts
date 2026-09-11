import { describe, expect, it, vi } from 'vitest';
import { domainIndexRoutes } from '../src/modules/domainIndex.js';
import { asUser, buildTestApp, createFakeDb, domainRow, svcRow } from './helpers.js';

const proxyMocks = vi.hoisted(() => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  readCertificates: vi.fn(() => []),
}));
vi.mock('../src/engine/proxy.js', () => proxyMocks);

describe('domain index routes', () => {
  it('lists domains joined with their services', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          domains: [
            domainRow({ id: 1, serviceId: 1, hostname: 'a.example.com' }),
            domainRow({ id: 2, serviceId: 99, hostname: 'orphan.example.com' }),
          ],
        },
        select: { services: [svcRow({ id: 1, runtimeId: 'c1', port: 3000, name: 'web' })] },
      }),
    });
    await app.register(domainIndexRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0]).toMatchObject({
      id: 1,
      hostname: 'a.example.com',
      serviceId: 1,
      serviceName: 'web',
      container: 'c1',
      port: 3000,
    });
    // The orphan domain (service 99 does not exist) is not listed: the index
    // joins through the caller's visible-service set rather than left-joining.
    expect(rows).toHaveLength(1);
    // No acme.json → no cert info.
    expect(rows[0]).toMatchObject({ certExpiresAt: null });
  });

  it('limits a member to domains on services they own', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          domains: [
            domainRow({ id: 1, serviceId: 1, hostname: 'mine.example.com' }),
            domainRow({ id: 2, serviceId: 2, hostname: 'theirs.example.com' }),
          ],
        },
        select: {
          // Full-row select → the whole inventory; id-only projection → the
          // owner-scoped re-query, which the fake db cannot filter itself.
          services: (cols) =>
            cols === undefined
              ? [svcRow({ id: 1, ownerUserId: 7 }), svcRow({ id: 2, ownerUserId: 9 })]
              : [{ id: 1 }],
        },
      }),
    });
    await app.register(domainIndexRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ id: 7, isOperator: false }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((domain: { hostname: string }) => domain.hostname)).toEqual(['mine.example.com']);
  });

  it('attaches certificate expiry to matching hostnames', async () => {
    proxyMocks.readCertificates.mockReturnValueOnce([
      { domain: 'a.example.com', expiresAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: { domains: [domainRow({ id: 1, serviceId: 1, hostname: 'a.example.com' })] },
        select: { services: [svcRow({ id: 1 })] },
      }),
    });
    await app.register(domainIndexRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ certExpiresAt: '2026-09-01T00:00:00.000Z' });
  });

  it('enables ssl on a domain and regenerates the proxy config', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          domains: domainRow({ id: 1, serviceId: 1 }),
          services: svcRow({ id: 1 }),
        },
        update: { domains: [domainRow({ id: 1, ssl: true })] },
      }),
    });
    await app.register(domainIndexRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { ssl: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 1, ssl: true });
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('defaults ssl to false when omitted', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          domains: domainRow({ id: 1, serviceId: 1 }),
          services: svcRow({ id: 1 }),
        },
        update: { domains: [domainRow({ id: 1, ssl: false })] },
      }),
    });
    await app.register(domainIndexRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 1, ssl: false });
  });

  it('defaults ssl to false when no body is sent', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          domains: domainRow({ id: 1, serviceId: 1 }),
          services: svcRow({ id: 1 }),
        },
        update: { domains: [domainRow({ id: 1, ssl: false })] },
      }),
    });
    await app.register(domainIndexRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 1, ssl: false });
  });

  it('never marks a domain active — DNS proof lives only in the verify route (r092)', async () => {
    // PATCH used to set `status: 'active'` unconditionally, letting any seat
    // holder route + request certificates for a hostname they never proved.
    const db = createFakeDb({
      findFirst: {
        domains: domainRow({ id: 1, serviceId: 1, status: 'pending' }),
        services: svcRow({ id: 1 }),
      },
      update: { domains: [domainRow({ id: 1, ssl: true, status: 'pending' })] },
    });
    const writes: Record<string, unknown>[] = [];
    const origUpdate = db.update.bind(db);
    db.update = ((table: unknown) => {
      const builder = origUpdate(table as never);
      const origSet = builder.set.bind(builder);
      builder.set = ((values: Record<string, unknown>) => {
        writes.push(values);
        return origSet(values as never);
      }) as typeof builder.set;
      return builder;
    }) as typeof db.update;
    const app = await buildTestApp({ db });
    await app.register(domainIndexRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1', headers: asUser(), payload: { ssl: true } });
    expect(res.statusCode).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ ssl: true });
    expect(writes[0]).not.toHaveProperty('status');
  });

  it('refuses the ssl toggle for a workspace viewer (403)', async () => {
    const OWNER = 2;
    const VIEWER = 7;
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          domains: domainRow({ id: 1, serviceId: 3 }),
          services: svcRow({ id: 3, ownerUserId: OWNER }),
          workspaceMembers: { id: 1, workspaceId: 1, userId: VIEWER, role: 'viewer' },
        },
        findMany: {
          serviceWorkspaces: [{ id: 1, serviceId: 3, workspaceId: 1 }],
          workspaceMembers: [{ id: 1, workspaceId: 1, userId: VIEWER, role: 'viewer' }],
        },
        update: { domains: [domainRow({ id: 1, ssl: true })] },
      }),
    });
    await app.register(domainIndexRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser({ id: VIEWER, isOperator: false }),
      payload: { ssl: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when the domain is missing', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          domains: undefined,
          services: svcRow({ id: 1 }),
        },
        update: { domains: [] },
      }),
    });
    await app.register(domainIndexRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/99', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid domain id before querying', async () => {
    const app = await buildTestApp();
    await app.register(domainIndexRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/not-an-id', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_id');
  });
});
