import { describe, expect, it } from 'vitest';
import { aboutRoutes } from '../src/modules/about.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

/** Auth headers for the about route: it gates on `authorization` being present,
 *  then authenticates via the test stub's `x-test-user` header. */
const authed = { ...asUser(), authorization: 'Bearer test' };

describe('about routes', () => {
  it('returns ABOUT info with counts from the db for authenticated callers', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        counts: { services: [{ n: 3 }], databases: [{ n: 2 }], deployments: [{ n: 5 }], users: [{ n: 1 }], installed_plugins: [{ n: 4 }] },
      }),
    });
    await app.register(aboutRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: authed });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('NineDeploy');
    expect(body.stats).toEqual({ services: 3, databases: 2, deployments: 5, users: 1, plugins: 4 });
  });

  it('hides instance counts from unauthenticated callers', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        counts: { services: [{ n: 3 }], databases: [{ n: 2 }], deployments: [{ n: 5 }], users: [{ n: 1 }], installed_plugins: [{ n: 4 }] },
      }),
    });
    await app.register(aboutRoutes);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('NineDeploy');
    expect(body.version).toBeTruthy();
    expect(body.stats).toBeUndefined();
  });

  it('serves the public subset for an invalid token', async () => {
    const app = await buildTestApp({ db: createFakeDb({ counts: {} }) });
    await app.register(aboutRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: 'Bearer garbage' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toBeUndefined();
  });

  it('falls back to zero when count rows are missing', async () => {
    const app = await buildTestApp({ db: createFakeDb({ counts: {} }) });
    await app.register(aboutRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toEqual({ services: 0, databases: 0, deployments: 0, users: 0, plugins: 0 });
  });

  it('keeps zeroed stats when the db is unavailable', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ selectError: { services: new Error('down'), databases: new Error('down'), deployments: new Error('down'), users: new Error('down'), installed_plugins: new Error('down') } }),
    });
    await app.register(aboutRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toEqual({ services: 0, databases: 0, deployments: 0, users: 0, plugins: 0 });
  });
});
