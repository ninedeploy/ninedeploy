import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, services, users } from '@ninedeploy/db';

/**
 * 0.16.10: `GET /v1/services/:id/autoscale` and the service PATCH that
 * configures autoscaling, against a real migrated SQLite.
 */

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { servicesRoutes } = await import('../src/modules/services.js');
const { decide, resetAutoscaleState } = await import('../src/lib/autoscaler.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
let app: Awaited<ReturnType<typeof buildTestApp>>;
const OWNER = asUser({ id: 2, isOperator: false });
const OTHER = asUser({ id: 3, isOperator: false });

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 2, email: 'owner@example.com', passwordHash: 'x' },
    { id: 3, email: 'other@example.com', passwordHash: 'x' },
  ]);
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, runtimeReplicas: 2 },
    { id: 6, name: 'stack', slug: 'stack', type: 'compose', branch: 'main', ownerUserId: 2 },
  ] as never);
  app = await buildTestApp({ db });
  await app.register(servicesRoutes, { prefix: '/v1/services' });
  resetAutoscaleState();
});
afterEach(async () => {
  await app.close();
});

describe('autoscale configuration and status', () => {
  it('is off by default; a PATCH stores it with its defaults and the status shows it', async () => {
    expect((await app.inject({ url: '/v1/services/5/autoscale', headers: OWNER })).json()).toEqual({ enabled: false, replicas: 2 });
    const res = await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { autoscale: { maxReplicas: 4, target: 60 } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().autoscale).toEqual({ minReplicas: 1, maxReplicas: 4, metric: 'cpu', target: 60, scaleUpSeconds: 60, scaleDownSeconds: 300 });
    expect((await app.inject({ url: '/v1/services/5/autoscale', headers: OWNER })).json()).toEqual({
      enabled: true,
      replicas: 2,
      minReplicas: 1,
      maxReplicas: 4,
      metric: 'cpu',
      target: 60,
      value: null,
      desired: null,
      holding: null,
      lastEvent: null,
      scheduledFloor: null,
    });
  });

  it('a change starts the windows again', async () => {
    await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { autoscale: { maxReplicas: 4, target: 60 } } });
    const cfg = { minReplicas: 1, maxReplicas: 4, metric: 'cpu' as const, target: 60, scaleUpSeconds: 60, scaleDownSeconds: 300 };
    expect(decide(5, 2, 200, cfg, 0)).toBeNull();
    await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { autoscale: { ...cfg, target: 70 } } });
    // The need that began before the change no longer counts.
    expect(decide(5, 2, 200, cfg, 60_000)).toBeNull();
    const off = await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { autoscale: null } });
    expect(off.json().autoscale).toBeNull();
  });

  it('refuses bad bounds and services that are not docker; hides the status from others', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { autoscale: { minReplicas: 3, maxReplicas: 2, target: 50 } } })).statusCode).toBe(400);
    const compose = await app.inject({ method: 'PATCH', url: '/v1/services/6', headers: OWNER, payload: { autoscale: { maxReplicas: 3, target: 50 } } });
    expect(compose.statusCode).toBe(400);
    expect(compose.json().error.message).toBe('Autoscaling applies to docker services only');
    expect((await app.inject({ url: '/v1/services/5/autoscale', headers: OTHER })).statusCode).toBe(404);
  });
});
