import { afterEach, expect, it, vi } from 'vitest';
import { swarmTransitions } from '@ninedeploy/db';
import { servicesRoutes } from '../src/modules/services.js';
import { observabilityDb } from './fixtures/observability.js';
import { asUser, buildTestApp } from './helpers.js';
const io = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/dockerEngineApi.js', () => ({ dockerEngineRequest: io.request }));
let f: Awaited<ReturnType<typeof observabilityDb>>, app: Awaited<ReturnType<typeof buildTestApp>>;
afterEach(async () => { await app?.close(); f?.close(); io.request.mockReset(); });
async function boot() {
  f = await observabilityDb();
  await f.db.insert(swarmTransitions).values({ serviceId: 1, deploymentId: 9, managerNodeId: 'mgr0000000000000000000001', runtimeId: 'nd-web_web', payloadEncrypted: 'private-encrypted-spec-fixture', ownerToken: 'private-lease-fixture', leaseUntil: new Date(Date.now() + 90_000), phase: 'submitted' });
  app = await buildTestApp({ db: f.db }); await app.register(servicesRoutes);
}
it('exposes persisted Swarm recovery without specs, ciphertext, hashes or ownership tokens', async () => {
  await boot(); const response = await app.inject({ url: '/1/swarm/recovery', headers: asUser() });
  expect(response.statusCode).toBe(200); expect(response.json().entry).toMatchObject({ deploymentId: 9, phase: 'submitted', busy: true });
  expect(response.body).not.toMatch(/private-|payloadEncrypted|ownerToken|TaskTemplate|fingerprint|managerNodeId/);
});
it('refuses anonymous and unrelated callers for both reads and retries', async () => {
  await boot();
  for (const method of ['GET', 'POST'] as const) {
    expect((await app.inject({ method, url: '/1/swarm/recovery' })).statusCode).toBe(401);
    expect((await app.inject({ method, url: '/1/swarm/recovery', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(404);
  }
  expect(io.request).not.toHaveBeenCalled();
});
it('lets an owner view recovery but requires an operator to retry it', async () => {
  await boot(); const headers = asUser({ id: 1, isOperator: false });
  expect((await app.inject({ url: '/1/swarm/recovery', headers })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/1/swarm/recovery', headers })).statusCode).toBe(403);
  expect(io.request).not.toHaveBeenCalled();
});
it('preserves a live lease for an operator retry', async () => {
  await boot(); const response = await app.inject({ method: 'POST', url: '/1/swarm/recovery', headers: asUser() });
  expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ recovered: 0, held: 0, entry: { busy: true } });
  expect(io.request).not.toHaveBeenCalled();
});
