import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, runMigrations, servers, services, users, eq } from '@ninedeploy/db';
import { logBus } from '../src/engine/logs.js';

/**
 * 0.16.9 canary routes against a real migrated SQLite: the status of a
 * canary in progress, its promote, and the service PATCH that configures it.
 */

const audit = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('../src/lib/audit.js', () => ({ audit }));

const { deploysRoutes } = await import('../src/modules/deploys.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { beginCanary, resetCanaryState, setCanaryStep, recordCanaryHit } = await import('../src/engine/canaryState.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
let app: Awaited<ReturnType<typeof buildTestApp>>;
const OWNER = asUser({ id: 2, isOperator: false });
const OTHER = asUser({ id: 3, isOperator: false });

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: 2, email: 'owner@example.com', passwordHash: 'x' },
    { id: 3, email: 'other@example.com', passwordHash: 'x' },
  ]);
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2 },
    { id: 6, name: 'stack', slug: 'stack', type: 'compose', branch: 'main', ownerUserId: 2 },
  ] as never);
  await db.insert(deployments).values([
    { id: 40, serviceId: 5, status: 'building' },
    { id: 41, serviceId: 6, status: 'building' },
  ]);
  app = await buildTestApp({ db });
  await app.register(servicesRoutes, { prefix: '/v1/services' });
  await app.register(deploysRoutes, { prefix: '/v1/services' });
  audit.mockClear();
});
afterEach(async () => {
  resetCanaryState();
  await app.close();
});

describe('GET /v1/services/:id/canary', () => {
  it('is inactive with no canary, and describes one in progress', async () => {
    expect((await app.inject({ url: '/v1/services/5/canary', headers: OWNER })).json()).toEqual({ active: false });
    beginCanary(5, 'web', 40, 2, true);
    setCanaryStep(5, 1, { runtimeId: 'web-40', replicas: 1, port: null, weight: 10 }, Date.now() - 1000, Date.now() + 60_000);
    recordCanaryHit('svc_web_1_canary@file', 200, 12, Date.now());
    const res = await app.inject({ url: '/v1/services/5/canary', headers: OWNER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ active: true, deploymentId: 40, step: 1, steps: 2, weight: 10, measured: true, canary: { requests: 1 } });
  });

  it('is hidden from a user who cannot see the service', async () => {
    expect((await app.inject({ url: '/v1/services/5/canary', headers: OTHER })).statusCode).toBe(404);
  });
});

describe('POST /v1/services/:id/deploys/:depId/canary/promote', () => {
  it('reports a pending measured step when promoting a node release', async () => {
    await db.insert(servers).values({ id: 9, name: 'Node', host: 'node.test', port: 4600, tokenEncrypted: 'fixture' });
    await db.update(services).set({ serverId: 9, runtimeId: 'web-old' }).where(eq(services.id, 5));
    beginCanary(5, 'web', 40, 2, true, true, { serverId: 9, stableRuntimeId: 'web-old' });
    const res = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/canary/promote', headers: OWNER });
    expect(res.statusCode, res.body).toBe(200);
    expect(logBus.read(40).trim().split('\n').at(-1)).toMatch(/waiting for the current measured step to finish and pass/);
    expect((await app.inject({ url: '/v1/services/5/canary', headers: OWNER })).json().promoting).toBe(true);
  });
  it('asks the canary to finish and audits it', async () => {
    beginCanary(5, 'web', 40, 2, true);
    const res = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/canary/promote', headers: OWNER });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.inject({ url: '/v1/services/5/canary', headers: OWNER })).json().promoting).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.anything(), 2, 'deploy.canary_promote', 'web #40', { serviceId: 5 });
  });

  it('answers 400 no_canary when the deployment runs none, and 404 for another service\'s deployment', async () => {
    const none = await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/canary/promote', headers: OWNER });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('no_canary');
    expect((await app.inject({ method: 'POST', url: '/v1/services/5/deploys/41/canary/promote', headers: OWNER })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/services/5/deploys/40/canary/promote', headers: OTHER })).statusCode).toBe(404);
  });
});

describe('PATCH /v1/services/:id canary', () => {
  it('stores the configuration with its defaults, shows it, and null turns it off', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { canary: { steps: [10, 50] } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().canary).toEqual({ steps: [10, 50], stepSeconds: 120, maxErrorRate: 5, maxP95Ms: null, minRequests: 20 });
    expect((await app.inject({ url: '/v1/services/5', headers: OWNER })).json().canary.steps).toEqual([10, 50]);
    const off = await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { canary: null } });
    expect(off.json().canary).toBeNull();
  });

  it('refuses steps that do not go up, and a service that is not docker', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { canary: { steps: [50, 10] } } })).statusCode).toBe(400);
    const compose = await app.inject({ method: 'PATCH', url: '/v1/services/6', headers: OWNER, payload: { canary: { steps: [10] } } });
    expect(compose.statusCode).toBe(400);
    expect(compose.json().error.message).toMatch(/docker services only/);
  });
});
