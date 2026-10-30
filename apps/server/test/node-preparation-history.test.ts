import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deployments, eq, nodeDeploymentPreparations, servers, services } from '@ninedeploy/db';
import { deploysRoutes } from '../src/modules/deploys.js';
import { servicesRoutes } from '../src/modules/services.js';
import { deleteLog } from '../src/engine/logs.js';
import { unsweepableDeploymentIds } from '../src/plugins/housekeeping.js';
import { observabilityDb } from './fixtures/observability.js';
import { asUser, buildTestApp } from './helpers.js';

vi.mock('../src/engine/logs.js', async original => ({ ...await original<typeof import('../src/engine/logs.js')>(), deleteLog: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
let f: Awaited<ReturnType<typeof observabilityDb>>;
let app: Awaited<ReturnType<typeof buildTestApp>>;
afterEach(async () => { await app?.close(); f?.close(); });
async function boot() {
  f = await observabilityDb();
  await f.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await f.db.update(services).set({ serverId: 4 }).where(eq(services.id, 1));
  await f.db.insert(deployments).values([{ id: 9, serviceId: 1, status: 'failed' }, { id: 10, serviceId: 1, status: 'failed' }]);
  await f.db.insert(nodeDeploymentPreparations).values({ deploymentId: 9, serviceId: 1, serverId: 4, epoch: 1, requestId: 'a'.repeat(32),
    runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`, serving: 1, capacity: 2 });
  app = await buildTestApp({ db: f.db }); await app.register(deploysRoutes, { prefix: '/services' }); await app.register(servicesRoutes, { prefix: '/services' });
}
it('protects unresolved node preparation from single deployment deletion and retention', async () => {
  await boot();
  expect(await unsweepableDeploymentIds(f.db)).toContain(9);
  const response = await app.inject({ method: 'DELETE', url: '/services/1/deploys/9', headers: asUser() });
  expect(response.statusCode).toBe(400);
  expect(await f.db.select().from(nodeDeploymentPreparations)).toHaveLength(1);
  expect(await f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) })).toBeDefined();
});
it('exposes pending preparation status without private ownership or container identifiers', async () => {
  await boot();
  const response = await app.inject({ method: 'GET', url: '/services/1/node-preparations', headers: asUser() });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ entries: [{ deploymentId: 9, serverId: 4, phase: 'preparing', deploymentStatus: 'failed' }] });
  expect(response.body).not.toContain('a'.repeat(32));
  expect(response.body).not.toContain('sha256:');
  const outsider = await app.inject({ method: 'GET', url: '/services/1/node-preparations', headers: asUser({ id: 2, role: 'member', isOperator: false }) });
  expect([403, 404]).toContain(outsider.statusCode);
  expect(outsider.body).not.toContain('preparing');
});
it('refuses service deletion while a node preparation remains unresolved', async () => {
  await boot();
  const response = await app.inject({ method: 'DELETE', url: '/services/1', headers: asUser() });
  expect(response.statusCode).toBe(409);
  expect(await f.db.query.services.findFirst({ where: eq(services.id, 1) })).toBeDefined();
  expect(await f.db.select().from(nodeDeploymentPreparations)).toHaveLength(1);
});
it('bulk deletion skips only the deployment with unresolved node preparation', async () => {
  await boot();
  const response = await app.inject({ method: 'POST', url: '/services/1/deploys/bulk-delete', headers: asUser(), payload: { ids: [9, 10] } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ removed: [10], skipped: 1 });
  expect(await f.db.select().from(nodeDeploymentPreparations)).toHaveLength(1);
  expect(deleteLog).toHaveBeenCalledWith(10);
  expect(deleteLog).not.toHaveBeenCalledWith(9);
});
