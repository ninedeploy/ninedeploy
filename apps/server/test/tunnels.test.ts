import { describe, expect, it, vi } from 'vitest';
import { tunnelRoutes } from '../src/modules/tunnels.js';
import { asUser, buildTestApp, createFakeDb, tunnelRow } from './helpers.js';

const tunnelMocks = vi.hoisted(() => ({
  startTunnel: vi.fn(async (_t: unknown, log: (l: string) => void) => { log('starting'); }),
  stopTunnel: vi.fn(async () => undefined),
}));

vi.mock('../src/engine/tunnel.js', () => tunnelMocks);

describe('tunnel routes', () => {
  it('lists tunnels', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findMany: { tunnels: [tunnelRow({ id: 2, name: 'prod' })] } }),
    });
    await app.register(tunnelRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: 2,
        name: 'prod',
        slug: 'prod-0001',
        status: 'running',
        containerName: 'nd-tunnel-prod-0001',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('rejects an invalid tunnel id', async () => {
    const app = await buildTestApp();
    await app.register(tunnelRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/invalid', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_id');
  });

  it('creates and starts a tunnel', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ insert: { tunnels: [tunnelRow({ id: 3, name: 'edge' })] } }),
    });
    await app.register(tunnelRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'edge', token: 'cf-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 3, name: 'edge', status: 'running' });
    expect(tunnelMocks.startTunnel).toHaveBeenCalled();
  });

  it('returns 400 when the insert fails', async () => {
    const app = await buildTestApp({ db: createFakeDb({ insert: { tunnels: [] } }) });
    await app.register(tunnelRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'edge', token: 'cf-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('marks the tunnel errored when the container fails to start', async () => {
    tunnelMocks.startTunnel.mockRejectedValueOnce(new Error('docker down'));
    const app = await buildTestApp({
      db: createFakeDb({ insert: { tunnels: [tunnelRow({ id: 3 })] } }),
    });
    await app.register(tunnelRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'edge', token: 'cf-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Tunnel failed to start: docker down');
  });

  it('formats non-Error tunnel startup failures', async () => {
    tunnelMocks.startTunnel.mockRejectedValueOnce('boom');
    const app = await buildTestApp({
      db: createFakeDb({ insert: { tunnels: [tunnelRow({ id: 3 })] } }),
    });
    await app.register(tunnelRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: 'edge', token: 'cf-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Tunnel failed to start: boom');
  });

  it('deletes a tunnel', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { tunnels: tunnelRow({ id: 3 }) } }),
    });
    await app.register(tunnelRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/3', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(tunnelMocks.stopTunnel).toHaveBeenCalled();
  });

  it('returns 404 when deleting a missing tunnel', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(tunnelRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/99', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid create payload', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(tunnelRoutes);
    const res = await app.inject({ method: 'POST', url: '/', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});
