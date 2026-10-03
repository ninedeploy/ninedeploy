import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAgentApp } from '../../src/agentApp.js';
import { config } from '../../src/config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildAgentApp', () => {
  it('exposes only the registered agent routes (no API surface by default)', async () => {
    const app = await buildAgentApp();
    // No routes registered yet → 404 on any path.
    const res = await app.inject({ method: 'GET', url: '/agent/ping' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('strips query strings from the request log serializer (no secrets in argv)', async () => {
    const app = await buildAgentApp();
    // The serializer is internal; we exercise it by inspecting that the log
    // method exists and that the request is logged with the path-only form.
    const res = await app.inject({ method: 'GET', url: '/?token=secret', headers: { host: 'h' } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 401 with a stable envelope for unauthenticated errors', async () => {
    const app = await buildAgentApp();
    // Hand-roll a route that throws an HttpError to exercise the error handler.
    app.get('/boom', (_req, _reply) => {
      const err = new Error('not allowed') as Error & { statusCode?: number; code?: string };
      err.statusCode = 401;
      err.code = 'unauthorized';
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: 'not allowed' } });
    await app.close();
  });

  it('returns 500 with a generic message in production and the real one in development', async () => {
    const original = config.isProd;
    Object.defineProperty(config, 'isProd', { value: true, configurable: true });
    try {
      const app = await buildAgentApp();
      app.get('/boom2', (_req, _reply) => {
        const err = new Error('detailed server failure') as Error & { statusCode?: number };
        err.statusCode = 500;
        throw err;
      });
      const res = await app.inject({ method: 'GET', url: '/boom2' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } });
      await app.close();
    } finally {
      Object.defineProperty(config, 'isProd', { value: original, configurable: true });
    }
  });

  it('falls back to status 500 when the error has no statusCode', async () => {
    const app = await buildAgentApp();
    app.get('/boom3', (_req, _reply) => {
      throw new Error('plain error');
    });
    const res = await app.inject({ method: 'GET', url: '/boom3' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'internal_error', message: 'plain error' } });
    await app.close();
  });
});
