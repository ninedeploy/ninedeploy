/** G1.3 restart-loop limit (`lib/restartLimit.ts`, `modules/restartLimit.ts`) on a migrated SQLite. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployments, services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

const lib = await import('../../src/lib/restartLimit.js');
const { restartLimitRoutes } = await import('../../src/modules/restartLimit.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  lib.resetRestartHistory();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, runtimeId: 'web-1', status: 'running', runtimeReplicas: 2 },
    { id: 6, name: 'node', slug: 'node', type: 'docker', branch: 'main', ownerUserId: 1, runtimeId: 'node-1', status: 'running', serverId: null },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

const limit = { maxRestarts: 3, windowMinutes: 10 };
const MIN = 60_000;

describe('recordRestarts', () => {
  it('counts restarts per container from a baseline, within the window', () => {
    expect(lib.recordRestarts(1, new Map([['c1', 7]]), limit, 0)).toBe(false); // baseline only
    expect(lib.recordRestarts(1, new Map([['c1', 9]]), limit, 1 * MIN)).toBe(false); // 2 restarts
    expect(lib.recordRestarts(1, new Map([['c1', 10]]), limit, 2 * MIN)).toBe(true); // 3 within 10 min
  });

  it('forgets restarts older than the window, and a new container starts from its own baseline', () => {
    lib.recordRestarts(2, new Map([['c1', 0]]), limit, 0);
    lib.recordRestarts(2, new Map([['c1', 2]]), limit, 1 * MIN);
    expect(lib.recordRestarts(2, new Map([['c1', 3]]), limit, 20 * MIN)).toBe(false); // the first two expired
    // A deploy replaced the container: its count of 50 is a baseline, not 50 restarts.
    expect(lib.recordRestarts(2, new Map([['c2', 50]]), limit, 21 * MIN)).toBe(false);
  });
});

describe('enforceRestartLimits', () => {
  it('stops a crash-looping service like the Stop button, records the trip and reports it once', async () => {
    await lib.setRestartLimit(db, 5, limit);
    let count = 0;
    const sample = vi.fn(async (names: string[]) => {
      expect(names).toEqual(['web-1', 'web-1-r2']);
      return new Map([['id-web-1', count]]);
    });
    const stop = vi.fn(async () => undefined);
    const onTripped = vi.fn();
    const deps = { sample, stop, onTripped };
    expect(await lib.enforceRestartLimits(db, deps, 0)).toEqual([]);
    count = 1;
    expect(await lib.enforceRestartLimits(db, deps, 1 * MIN)).toEqual([]);
    count = 3;
    expect(await lib.enforceRestartLimits(db, deps, 2 * MIN)).toEqual([5]);
    expect(stop).toHaveBeenCalledWith(['web-1', 'web-1-r2']);
    expect((await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 5) }))?.status).toBe('stopped');
    expect(onTripped).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), limit, 3);
    expect((await lib.getRestartLimit(db, 5))?.trippedAt).toBe(new Date(2 * MIN).toISOString());
    // Stopped now: nothing more happens.
    count = 9;
    expect(await lib.enforceRestartLimits(db, deps, 3 * MIN)).toEqual([]);
    expect(onTripped).toHaveBeenCalledTimes(1);
  });

  it('stops a crash-looping PM2 service through PM2, never through docker', async () => {
    await db.insert(services).values({ id: 7, name: 'api', slug: 'api', type: 'pm2', branch: 'main', ownerUserId: 1, runtimeId: 'api-4', status: 'running' } as never);
    await lib.setRestartLimit(db, 7, limit);
    let count = 0;
    const samplePm2 = vi.fn(async (runtimeId: string) => {
      expect(runtimeId).toBe('api-4');
      return new Map([['3@1000', count]]);
    });
    const stopPm2 = vi.fn(async () => undefined);
    const sample = vi.fn(async () => new Map<string, number>());
    const stop = vi.fn(async () => undefined);
    const onTripped = vi.fn();
    const deps = { sample, stop, samplePm2, stopPm2, onTripped };
    expect(await lib.enforceRestartLimits(db, deps, 0)).toEqual([]);
    count = 3;
    expect(await lib.enforceRestartLimits(db, deps, 1 * MIN)).toEqual([7]);
    expect(stopPm2).toHaveBeenCalledWith('api-4');
    expect(sample).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect((await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 7) }))?.status).toBe('stopped');
    expect(onTripped).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), limit, 3);
  });

  it('leaves a service alone while it deploys, and does nothing without a limit', async () => {
    const sample = vi.fn(async () => new Map([['x', 100]]));
    expect(await lib.enforceRestartLimits(db, { sample })).toEqual([]);
    expect(sample).not.toHaveBeenCalled();
    await lib.setRestartLimit(db, 5, limit);
    await db.insert(deployments).values({ serviceId: 5, status: 'deploying', trigger: 'user' });
    await lib.enforceRestartLimits(db, { sample });
    expect(sample).not.toHaveBeenCalled();
  });
});

describe('routes', () => {
  it('reads and sets the limit, refuses bad values and turns it off', async () => {
    const app = await buildTestApp({ db });
    await app.register(restartLimitRoutes, { prefix: '/services' });
    expect((await app.inject({ method: 'GET', url: '/services/5/restart-limit', headers: asUser(1) })).json()).toEqual({
      limit: null,
      recentRestarts: 0,
      trippedAt: null,
    });
    const set = await app.inject({ method: 'PUT', url: '/services/5/restart-limit', headers: asUser(1), payload: { limit } });
    expect(set.json()).toMatchObject({ limit });
    expect((await app.inject({ method: 'PUT', url: '/services/5/restart-limit', headers: asUser(1), payload: { limit: { maxRestarts: 1, windowMinutes: 5 } } })).statusCode).toBe(400);
    const off = await app.inject({ method: 'PUT', url: '/services/5/restart-limit', headers: asUser(1), payload: { limit: null } });
    expect(off.json().limit).toBeNull();
  });

  it('refuses turning it on where the sweep never samples: a Swarm service; off stays allowed', async () => {
    await db.insert(services).values({ id: 8, name: 'sw', slug: 'sw', type: 'docker', branch: 'main', ownerUserId: 1, runtimeId: 'nd-sw', status: 'running', orchestrator: 'swarm' } as never);
    const app = await buildTestApp({ db });
    await app.register(restartLimitRoutes, { prefix: '/services' });
    const on = await app.inject({ method: 'PUT', url: '/services/8/restart-limit', headers: asUser(1), payload: { limit } });
    expect(on.statusCode).toBe(400);
    expect(on.json().error.code).toBe('restart_limit_unsupported');
    expect(await lib.getRestartLimit(db, 8)).toBeNull();
    expect((await app.inject({ method: 'PUT', url: '/services/8/restart-limit', headers: asUser(1), payload: { limit: null } })).statusCode).toBe(200);
  });

  it('names the services the sweep samples', () => {
    expect(lib.restartLimitSupported({ type: 'docker', serverId: null, orchestrator: null })).toBe(true);
    expect(lib.restartLimitSupported({ type: 'pm2', serverId: null, orchestrator: null })).toBe(true);
    expect(lib.restartLimitSupported({ type: 'docker', serverId: 4, orchestrator: null })).toBe(false);
    expect(lib.restartLimitSupported({ type: 'docker', serverId: null, orchestrator: 'swarm' })).toBe(false);
    expect(lib.restartLimitSupported({ type: 'compose', serverId: null, orchestrator: null })).toBe(false);
  });
});
