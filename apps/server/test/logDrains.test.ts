import { describe, expect, it, vi } from 'vitest';
import { logDrainRoutes } from '../src/modules/logDrains.js';
import { encrypt } from '../src/lib/crypto.js';
import { asUser, buildTestApp, createFakeDb, drainRow } from './helpers.js';

describe('log drains API', () => {
  const fakeDrain = {
    id: 1,
    name: 'Datadog Prod',
    type: 'datadog',
    url: 'https://http-intake.logs.datadoghq.com',
    apiKeyEncrypted: encrypt('test-secret-key'),
    serviceId: null,
    enabled: true,
    format: 'json',
    headersJson: JSON.stringify({ 'X-Env': 'prod' }),
    createdAt: new Date('2026-08-18T10:00:00Z'),
    updatedAt: new Date('2026-08-18T10:00:00Z'),
  };

  const fakeDrainPlain = {
    id: 2,
    name: 'Syslog Drain',
    type: 'syslog',
    url: 'syslog://syslog.internal:514',
    apiKeyEncrypted: null,
    serviceId: 4,
    enabled: false,
    format: 'rfc5424',
    headersJson: null,
    createdAt: new Date('2026-08-18T10:00:00Z'),
    updatedAt: new Date('2026-08-18T10:00:00Z'),
  };

  it('lists all log drains and supports serviceId filtering', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          log_drains: [fakeDrain, fakeDrainPlain],
          services: [],
        },
      }),
    });
    await app.register(logDrainRoutes);

    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      id: 1,
      name: 'Datadog Prod',
      type: 'datadog',
      hasApiKey: true,
      headers: { 'X-Env': 'prod' },
    });
    expect(list[1]).toMatchObject({
      id: 2,
      name: 'Syslog Drain',
      hasApiKey: false,
      enabled: false,
    });

    // Filter by serviceId
    const resFiltered = await app.inject({ method: 'GET', url: '/?serviceId=4', headers: asUser() });
    expect(resFiltered.statusCode).toBe(200);
  });

  it('gets a single log drain by id or returns 404', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          log_drains: [fakeDrainPlain],
          services: [],
        },
      }),
    });
    await app.register(logDrainRoutes);

    const res = await app.inject({ method: 'GET', url: '/2', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Syslog Drain');
    expect(res.json().hasApiKey).toBe(false);

    const fullApp = await buildTestApp({
      db: createFakeDb({
        select: {
          log_drains: [fakeDrain],
          services: [],
        },
      }),
    });
    await fullApp.register(logDrainRoutes);
    const resFull = await fullApp.inject({ method: 'GET', url: '/1', headers: asUser() });
    expect(resFull.statusCode).toBe(200);
    expect(resFull.json().headers).toEqual({ 'X-Env': 'prod' });
    expect(resFull.json().hasApiKey).toBe(true);

    const emptyApp = await buildTestApp({ db: createFakeDb() });
    await emptyApp.register(logDrainRoutes);
    const res404 = await emptyApp.inject({ method: 'GET', url: '/999', headers: asUser() });
    expect(res404.statusCode).toBe(404);
  });

  it('creates a log drain with validation and encryption', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          log_drains: [
            drainRow({
              name: 'Loki Drain',
              type: 'loki',
              apiKeyEncrypted: 'v1:encrypted',
              serviceId: 10,
              format: 'raw',
              headersJson: JSON.stringify({ 'X-Loki-Tenant': 'team-a' }),
            }),
          ],
        },
      }),
    });
    await app.register(logDrainRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: {
        name: 'Loki Drain',
        type: 'loki',
        url: 'https://loki.example.com',
        apiKey: ['loki', 'auth', 'token'].join('-'),
        serviceId: 10,
        format: 'raw',
        headers: { 'X-Loki-Tenant': 'team-a' },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'Loki Drain',
      type: 'loki',
      hasApiKey: true,
      serviceId: 10,
      format: 'raw',
      headers: { 'X-Loki-Tenant': 'team-a' },
    });

    // Create without apiKey and without serviceId
    const plainApp = await buildTestApp({
      db: createFakeDb({
        insert: {
          log_drains: [
            drainRow({
              name: 'Plain Drain',
              type: 'http',
              apiKeyEncrypted: null,
              serviceId: null,
              format: 'json',
              headersJson: null,
            }),
          ],
        },
      }),
    });
    await plainApp.register(logDrainRoutes);

    const resPlain = await plainApp.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: {
        name: 'Plain Drain',
        type: 'http',
        url: 'https://httpbin.org/post',
      },
    });
    expect(resPlain.statusCode).toBe(201);
    expect(resPlain.json().hasApiKey).toBe(false);

    // Invalid payload
    const resInvalid = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { name: '' },
    });
    expect(resInvalid.statusCode).toBe(422);
  });

  it('updates an existing log drain with all optional fields', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          log_drains: [fakeDrain],
        },
        update: {
          log_drains: [{ ...fakeDrain, name: 'Renamed Drain', enabled: false }],
        },
      }),
    });
    await app.register(logDrainRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: {
        name: 'Renamed Drain',
        type: 'vector',
        url: 'https://vector.example.com',
        serviceId: 3,
        enabled: false,
        format: 'json',
        headers: { 'X-New': 'val' },
        apiKey: 'new-key',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Renamed Drain');

    // Patch on plain drain with serviceId: null and apiKey: ''
    const plainApp = await buildTestApp({
      db: createFakeDb({
        select: {
          log_drains: [fakeDrainPlain],
        },
        update: {
          log_drains: [{ ...fakeDrainPlain, name: 'Plain Drain Updated', serviceId: null, headersJson: null, apiKeyEncrypted: null }],
        },
      }),
    });
    await plainApp.register(logDrainRoutes);

    const resPlainPatch = await plainApp.inject({
      method: 'PATCH',
      url: '/2',
      headers: asUser(),
      payload: {
        serviceId: null,
        apiKey: '',
      },
    });
    expect(resPlainPatch.statusCode).toBe(200);
    expect(resPlainPatch.json().hasApiKey).toBe(false);
    expect(resPlainPatch.json().headers).toBeUndefined();

    // Patch with only name (all optional fields omitted)
    const resOnlyName = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { name: 'Only Name' },
    });
    expect(resOnlyName.statusCode).toBe(200);

    // Update 404
    const emptyApp = await buildTestApp({ db: createFakeDb() });
    await emptyApp.register(logDrainRoutes);
    const res404 = await emptyApp.inject({
      method: 'PATCH',
      url: '/999',
      headers: asUser(),
      payload: { name: 'New' },
    });
    expect(res404.statusCode).toBe(404);

    // Invalid update
    const resInvalid = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { type: 'invalid-type' },
    });
    expect(resInvalid.statusCode).toBe(422);
  });

  it('deletes a log drain or returns 404', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          log_drains: [fakeDrain],
        },
      }),
    });
    await app.register(logDrainRoutes);

    const res = await app.inject({ method: 'DELETE', url: '/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const emptyApp = await buildTestApp({ db: createFakeDb() });
    await emptyApp.register(logDrainRoutes);
    const res404 = await emptyApp.inject({ method: 'DELETE', url: '/999', headers: asUser() });
    expect(res404.statusCode).toBe(404);
  });

  it('tests connection to log drain destination with and without api key', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        select: {
          log_drains: [fakeDrain, fakeDrainPlain],
        },
      }),
    });
    await app.register(logDrainRoutes);

    // Mock fetch for probe (success)
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as never);

    try {
      const res = await app.inject({ method: 'POST', url: '/1/test', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      const plainApp = await buildTestApp({
        db: createFakeDb({
          select: {
            log_drains: [fakeDrainPlain],
          },
        }),
      });
      await plainApp.register(logDrainRoutes);
      const resPlain = await plainApp.inject({ method: 'POST', url: '/2/test', headers: asUser() });
      expect(resPlain.statusCode).toBe(200);

      // Probe failure
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as never);
      const resFail = await app.inject({ method: 'POST', url: '/1/test', headers: asUser() });
      expect(resFail.statusCode).toBe(200);
      expect(resFail.json().ok).toBe(false);

      const emptyApp = await buildTestApp({ db: createFakeDb() });
      await emptyApp.register(logDrainRoutes);
      const res404 = await emptyApp.inject({ method: 'POST', url: '/999/test', headers: asUser() });
      expect(res404.statusCode).toBe(404);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('requires admin permissions', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(logDrainRoutes);

    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ isOperator: false }) });
    expect(res.statusCode).toBe(403);
  });
});
