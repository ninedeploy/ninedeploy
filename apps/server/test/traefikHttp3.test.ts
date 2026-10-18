import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, users } from '@ninedeploy/db';

/**
 * 0.16.1 `GET`/`PUT /v1/traefik/http3`: an operator turns 443/udp on or off;
 * the switch is stored first, Traefik is recreated with the new inputs, and a
 * failed recreate puts the switch (and the previous container) back with a
 * 502. Real migrated SQLite; the proxy lifecycle is faked.
 */

const proxyMocks = vi.hoisted(() => ({
  ensureNetwork: vi.fn(async () => undefined),
  ensureTraefik: vi.fn(async (..._a: unknown[]) => true),
}));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  ...proxyMocks,
}));
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);

const { traefikRoutes } = await import('../src/modules/traefik.js');
const { traefikHttp3UdpEnabled } = await import('../src/engine/proxy.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;

beforeEach(async () => {
  vi.clearAllMocks();
  proxyMocks.ensureTraefik.mockResolvedValue(true);
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: 7, email: 'm@example.com', passwordHash: 'x' },
  ]);
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(traefikRoutes, { prefix: '/v1' });
  return a;
}

describe('HTTP/3 switch', () => {
  it('is off on an upgraded panel; on recreates Traefik with http3Udp, off again recreates without', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/v1/traefik/http3', headers: asUser() })).json()).toEqual({ enabled: false });

    const on = await a.inject({ method: 'PUT', url: '/v1/traefik/http3', headers: asUser(), payload: { enabled: true } });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toEqual({ enabled: true });
    expect(await traefikHttp3UdpEnabled(db)).toBe(true);
    expect(proxyMocks.ensureTraefik).toHaveBeenCalledTimes(1);
    expect(proxyMocks.ensureTraefik.mock.calls[0]![3]).toMatchObject({ http3Udp: true });
    expect(auditMock.audit).toHaveBeenCalledWith(db, 1, 'traefik.http3.update', 'traefik', { previous: false, enabled: true });

    // Unchanged: nothing is recreated.
    await a.inject({ method: 'PUT', url: '/v1/traefik/http3', headers: asUser(), payload: { enabled: true } });
    expect(proxyMocks.ensureTraefik).toHaveBeenCalledTimes(1);

    await a.inject({ method: 'PUT', url: '/v1/traefik/http3', headers: asUser(), payload: { enabled: false } });
    expect(proxyMocks.ensureTraefik.mock.calls[1]![3]).toMatchObject({ http3Udp: false });
    expect(await traefikHttp3UdpEnabled(db)).toBe(false);
    await a.close();
  });

  it('a failed recreate puts the switch back, re-applies the previous inputs and answers 502', async () => {
    proxyMocks.ensureTraefik.mockRejectedValueOnce(new Error('Bind for 0.0.0.0:443 failed: port is already allocated'));
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/v1/traefik/http3', headers: asUser(), payload: { enabled: true } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'traefik_recreate_failed', message: expect.stringMatching(/HTTP\/3 stays off: Bind for 0\.0\.0\.0:443/) });
    expect(await traefikHttp3UdpEnabled(db)).toBe(false);
    expect(proxyMocks.ensureTraefik).toHaveBeenCalledTimes(2);
    expect(proxyMocks.ensureTraefik.mock.calls[1]![3]).toMatchObject({ http3Udp: false });
    expect(auditMock.audit).toHaveBeenCalledWith(db, 1, 'traefik.http3.update', 'traefik', expect.objectContaining({ outcome: 'recreate_failed' }));
    await a.close();
  });

  it('a failed restore is logged, not thrown over the 502', async () => {
    proxyMocks.ensureTraefik.mockRejectedValue(new Error('daemon gone'));
    const a = await app();
    const res = await a.inject({ method: 'PUT', url: '/v1/traefik/http3', headers: asUser(), payload: { enabled: true } });
    expect(res.statusCode).toBe(502);
    await a.close();
  });

  it('operators only; the body is strict', async () => {
    const a = await app();
    const member = asUser({ id: 7, isOperator: false });
    expect((await a.inject({ method: 'GET', url: '/v1/traefik/http3', headers: member })).statusCode).toBe(403);
    expect((await a.inject({ method: 'PUT', url: '/v1/traefik/http3', headers: member, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'PUT', url: '/v1/traefik/http3', headers: asUser(), payload: { enabled: 'yes' } })).statusCode).toBe(400);
    expect(proxyMocks.ensureTraefik).not.toHaveBeenCalled();
    await a.close();
  });
});
