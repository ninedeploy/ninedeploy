import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/errors.js';

const infra = vi.hoisted(() => ({
  worker: vi.fn(async () => undefined),
  traefik: vi.fn(async () => undefined),
  collector: vi.fn(async () => undefined),
  backups: vi.fn(async () => undefined),
}));

// Background infra plugins would start real timers and run real docker commands;
// mock them as no-ops so the app under test stays hermetic.
vi.mock('../src/plugins/worker.js', () => ({ default: infra.worker }));
vi.mock('../src/plugins/traefik.js', () => ({ default: infra.traefik }));
vi.mock('../src/plugins/collector.js', () => ({ default: infra.collector }));
vi.mock('../src/plugins/backupScheduler.js', () => ({ default: infra.backups }));

const tmp = path.join(os.tmpdir(), `ninedeploy-app-${process.pid}-${Date.now()}`);
mkdirSync(tmp, { recursive: true });

type AppModule = typeof import('../src/app.js');

async function buildApp(envOverrides: Record<string, string> = {}): Promise<Awaited<ReturnType<AppModule['buildApp']>>> {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('NINEDEPLOY_DATA_DIR', tmp);
  vi.stubEnv('NINEDEPLOY_DB_PATH', path.join(tmp, 'ninedeploy.db'));
  for (const [k, v] of Object.entries(envOverrides)) vi.stubEnv(k, v);
  const mod = await import('../src/app.js');
  return mod.buildApp();
}

async function createUsersTable(app: Awaited<ReturnType<AppModule['buildApp']>>) {
  await app.db.run(sql`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
}

afterAll(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows SQLite file lock */
  }
});

describe('buildApp', () => {
  it('GET /health returns ok and pings the database', { timeout: 20000 }, async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.version).toBeTruthy();
    expect(typeof body.time).toBe('string');
    await app.close();
  });

  it('r153: mounts SCIM at the RFC path and its management API under /v1/scim', async () => {
    const app = await buildApp();
    await app.ready();
    const has = (method: 'GET' | 'POST', url: string) => app.hasRoute({ method, url });
    expect(has('GET', '/scim/v2/ServiceProviderConfig')).toBe(true);
    expect(has('POST', '/scim/v2/Users')).toBe(true);
    expect(has('GET', '/v1/scim/tokens')).toBe(true);
    expect(has('GET', '/v1/scim/v2/ServiceProviderConfig')).toBe(false);
    expect(has('GET', '/v1/v1/scim/tokens')).toBe(false);
    await app.close();
  });

  it('GET /v1/auth/status reports an uninitialized instance', async () => {
    const app = await buildApp();
    await createUsersTable(app);
    const res = await app.inject({ method: 'GET', url: '/v1/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initialized: false, allowRegistration: false });
    await app.close();
  });

  it('M-3: sends baseline security headers on every response', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The panel drives deploys, deletions and node approvals — it must never
    // be framable.
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    await app.close();
  });

  it('M-3: sends a frame-blocking CSP on HTML documents only', async () => {
    const app = await buildApp();
    // The hook keys off content-type, so exercise the document path directly.
    // Routes must be added before the first inject boots the instance.
    app.get('/__csp-probe', async (_req, reply) => reply.type('text/html').send('<p>hi</p>'));
    await app.ready();

    const json = await app.inject({ method: 'GET', url: '/health' });
    // A CSP on a JSON body buys nothing; keep it off the API surface.
    expect(json.headers['content-security-policy']).toBeUndefined();

    const doc = await app.inject({ method: 'GET', url: '/__csp-probe' });
    const csp = doc.headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    await app.close();
  });

  it('M-3: only sends HSTS for HTTPS requests in production', async () => {
    const plain = await buildApp({ NODE_ENV: 'production', NINEDEPLOY_JWT_SECRET: 'a-strong-production-secret-value' });
    const overHttp = await plain.inject({ method: 'GET', url: '/health' });
    expect(overHttp.headers['strict-transport-security']).toBeUndefined();
    const overHttps = await plain.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(overHttps.headers['strict-transport-security']).toContain('max-age=31536000');
    await plain.close();
  });

  it('does not trust local development origins in production', async () => {
    const app = await buildApp({
      NODE_ENV: 'production',
      NINEDEPLOY_JWT_SECRET: 'a-strong-production-secret-value',
      NINEDEPLOY_PUBLIC_URL: 'https://panel.example.test',
    });
    const local = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(local.headers['access-control-allow-origin']).toBeUndefined();

    const panel = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://panel.example.test' },
    });
    expect(panel.headers['access-control-allow-origin']).toBe('https://panel.example.test');
    await app.close();
  });

  it('never logs query strings (WebSocket ?token= must not reach the logs)', async () => {
    const app = await buildApp();
    const infoSpy = vi.spyOn(app.log, 'info');
    // Wait for startup logs, then fire a request WITH a query string.
    await app.ready();
    infoSpy.mockClear();
    await app.inject({ method: 'GET', url: '/v1/health?token=super-secret-token' });
    for (const call of infoSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('super-secret-token');
      expect(serialized).not.toContain('?token');
    }
    await app.close();
  });

  it('turns ZodError into a 400 validation_error envelope', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ nope: true }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    expect(res.json().error.message).toBe('Request validation failed');
    expect(res.json().error.details).toBeDefined();
    await app.close();
  });

  it('returns the Fastify 404 envelope for unknown routes', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    // Fastify's default not-found handler answers directly (it bypasses the
    // custom error handler), so the body is the standard {message,error,statusCode}.
    expect(res.json()).toEqual({
      message: 'Route GET:/v1/does-not-exist not found',
      error: 'Not Found',
      statusCode: 404,
    });
    await app.close();
  });

  it('masks messages on 500 errors in production', async () => {
    const app = await buildApp({ NODE_ENV: 'production', NINEDEPLOY_JWT_SECRET: 'a-strong-production-secret-value' });
    const errorSpy = vi.spyOn(app.log, 'error');
    app.get('/boom', async () => {
      throw new Error('internal secret detail');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
    expect(errorSpy).toHaveBeenCalledWith({ err: expect.any(Error) }, 'request error');
    await app.close();
  });

  it('exposes the real message on 500 errors outside production', async () => {
    const app = await buildApp();
    app.get('/boom', async () => {
      throw new Error('visible detail');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal_error', message: 'visible detail' } });
    await app.close();
  });

  it('uses the HttpError statusCode and code for 4xx errors', async () => {
    const app = await buildApp();
    app.get('/teapot', async () => {
      throw new HttpError(418, 'teapot', 'short and stout');
    });
    const res = await app.inject({ method: 'GET', url: '/teapot' });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({ error: { code: 'teapot', message: 'short and stout' } });
    await app.close();
  });

  it('falls back to 500 when statusCode is outside the 400-599 range', async () => {
    const app = await buildApp();
    app.get('/weird', async () => {
      throw Object.assign(new Error('odd status'), { statusCode: 299 });
    });
    const res = await app.inject({ method: 'GET', url: '/weird' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('keeps 503 service-unavailable statuses', async () => {
    const app = await buildApp();
    app.get('/unavailable', async () => {
      throw new HttpError(503, 'unavailable', 'try later');
    });
    const res = await app.inject({ method: 'GET', url: '/unavailable' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('unavailable');
    await app.close();
  });
});
