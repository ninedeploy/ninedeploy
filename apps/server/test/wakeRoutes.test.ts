import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, domains, runMigrations, services, users } from '@ninedeploy/db';
import { resetSleepState, type SleepDeps } from '../src/lib/sleep.js';
import { serviceForRequest, wakeRoutes } from '../src/modules/wake.js';

/**
 * 0.16.11: the wake endpoint Traefik sends a sleeping service's requests to,
 * against a real migrated SQLite and a fake docker.
 */

let db: DB;
let app: ReturnType<typeof Fastify>;

async function boot(over: Partial<SleepDeps> = {}, waitMs = 5_000) {
  const deps: SleepDeps = {
    db,
    docker: vi.fn(async () => undefined),
    probe: vi.fn(async () => true),
    writeConfig: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    log: vi.fn(),
    ...over,
  };
  app = Fastify();
  app.decorate('db', db);
  await app.register(wakeRoutes({ deps, waitMs, settleMs: 0 }));
  await app.ready();
  return deps;
}

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, status: 'running', runtimeId: 'web-9', asleepAt: new Date(0) },
    { id: 6, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, status: 'running', runtimeId: 'api-3' },
    { id: 7, name: 'wild', slug: 'wild', type: 'docker', branch: 'main', ownerUserId: 1, status: 'stopped', runtimeId: 'wild-1' },
  ] as never);
  await db.insert(domains).values([
    { serviceId: 5, hostname: 'app.example.com', path: '/', status: 'active' },
    { serviceId: 6, hostname: 'app.example.com', path: '/api', status: 'active' },
    { serviceId: 7, hostname: '*.wild.example.com', path: '/', status: 'active' },
    { serviceId: 6, hostname: 'pending.example.com', path: '/', status: 'pending' },
  ] as never);
  resetSleepState();
});
afterEach(async () => {
  await app?.close();
});

describe('serviceForRequest', () => {
  it('takes the exact host, then the longest path, then a wildcard', async () => {
    expect((await serviceForRequest(db, 'app.example.com', '/'))?.id).toBe(5);
    expect((await serviceForRequest(db, 'app.example.com', '/api/users'))?.id).toBe(6);
    expect((await serviceForRequest(db, 'app.example.com', '/api'))?.id).toBe(6);
    expect((await serviceForRequest(db, 'app.example.com', '/apiary'))?.id).toBe(5);
    expect((await serviceForRequest(db, 'x.wild.example.com', '/'))?.id).toBe(7);
    expect(await serviceForRequest(db, 'a.b.wild.example.com', '/')).toBeNull();
    expect(await serviceForRequest(db, 'pending.example.com', '/')).toBeNull();
    expect(await serviceForRequest(db, 'other.example.com', '/')).toBeNull();
  });
});

describe('the wake endpoint', () => {
  it('wakes the sleeping service and sends a GET back to the same URL', async () => {
    const deps = await boot();
    const res = await app.inject({ url: '/_nd/wake/shop?x=1', headers: { host: 'App.Example.com:443' } });
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe('/shop?x=1');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(deps.docker).toHaveBeenCalledWith(['start', 'web-9']);
    expect(deps.audit).toHaveBeenCalledWith('service.wake', 'web', expect.objectContaining({ trigger: 'request' }));
    expect((await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 5) }))?.asleepAt).toBeNull();
  });

  it('never redirects off the site', async () => {
    await boot();
    for (const url of ['/_nd/wake//evil.example/x', '/_nd/wake/%5Cevil.example', '/_nd/wake']) {
      await db.update(services).set({ asleepAt: new Date(0) });
      const res = await app.inject({ url, headers: { host: 'app.example.com' } });
      expect(res.statusCode).toBe(307);
      expect(String(res.headers.location)).toMatch(/^\/(?![/\\])/);
    }
  });

  it('a POST wakes it and is told to come again; its body is never parsed', async () => {
    const deps = await boot();
    const res = await app.inject({ method: 'POST', url: '/_nd/wake/form', headers: { host: 'app.example.com', 'content-type': 'application/json' }, payload: '{not json' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toBe('Woke up. Send the request again.\n');
    expect(deps.docker).toHaveBeenCalled();
  });

  it('a slow wake answers a self-reloading page to a browser and Retry-After to the rest', async () => {
    await boot({ probe: vi.fn(() => new Promise<boolean>(() => undefined)) }, 20);
    const page = await app.inject({ url: '/_nd/wake/', headers: { host: 'app.example.com', accept: 'text/html,*/*' } });
    expect(page.statusCode).toBe(503);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('<meta http-equiv="refresh" content="5">');
    expect(page.body).toContain('app.example.com was asleep and is starting.');
    expect(page.body).not.toContain('<script');
    const api = await app.inject({ url: '/_nd/wake/api-ish', headers: { host: 'app.example.com', accept: 'application/json' } });
    expect(api.statusCode).toBe(503);
    expect(api.headers['retry-after']).toBe('5');
    expect(api.body).toMatch(/^Waking up\./);
  });

  it('a wake that fails says so and is tried again later', async () => {
    await boot({ docker: vi.fn(async () => Promise.reject(new Error('No such container'))) });
    const res = await app.inject({ url: '/_nd/wake/', headers: { host: 'app.example.com', accept: 'text/html' } });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('15');
    expect(res.body).toContain('could not be started');
  });

  it('an awake service gets a short reload while its routes come back; a stopped one says so', async () => {
    const deps = await boot();
    const awake = await app.inject({ url: '/_nd/wake/api', headers: { host: 'app.example.com' } });
    expect(awake.statusCode).toBe(503);
    expect(awake.headers['retry-after']).toBe('2');
    const stopped = await app.inject({ url: '/_nd/wake/', headers: { host: 'x.wild.example.com', accept: 'text/html' } });
    expect(stopped.statusCode).toBe(503);
    expect(stopped.body).toContain('This service is not running');
    expect(deps.docker).not.toHaveBeenCalled();
  });

  it('answers 404 for a host no domain routes, or no host at all', async () => {
    await boot();
    expect((await app.inject({ url: '/_nd/wake/', headers: { host: 'nobody.example.com' } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/_nd/wake/', headers: { host: '' } })).statusCode).toBe(404);
  });

  it('escapes the host on the page', async () => {
    await db.insert(domains).values({ serviceId: 5, hostname: 'a<b>.example.com', path: '/', status: 'active' } as never);
    await boot({ probe: vi.fn(() => new Promise<boolean>(() => undefined)) }, 10);
    const res = await app.inject({ url: '/_nd/wake/', headers: { host: 'a<b>.example.com', accept: 'text/html' } });
    expect(res.body).toContain('a&#60;b&#62;.example.com');
    expect(res.body).not.toContain('a<b>');
  });
});
