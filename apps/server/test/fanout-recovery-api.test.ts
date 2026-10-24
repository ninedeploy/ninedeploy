import { afterEach, expect, it, vi } from 'vitest';
import { fanoutTransitions, servers } from '@ninedeploy/db';
import { servicesRoutes } from '../src/modules/services.js';
import { observabilityDb } from './fixtures/observability.js';
import { asUser, buildTestApp } from './helpers.js';
const io = vi.hoisted(() => ({ agent: vi.fn() }));
vi.mock('../src/lib/agentClient.js', async original => ({ ...await original<typeof import('../src/lib/agentClient.js')>(), agentOp: io.agent }));
let f: Awaited<ReturnType<typeof observabilityDb>>;
let app: Awaited<ReturnType<typeof buildTestApp>>;
afterEach(async () => { await app?.close(); f?.close(); io.agent.mockReset(); });
async function boot() {
  f = await observabilityDb(); await f.db.insert(servers).values({ id: 5, name: 'Edge', host: 'edge.test', tokenEncrypted: 'fixture' });
  await f.db.insert(fanoutTransitions).values({ serviceId: 1, serverId: 5, targetId: 1, deploymentId: 9, primaryRuntimeId: 'web-7',
    candidateRuntimeId: 'web-t5-9', port: 8080, ownerToken: 'private-lease-token', leaseUntil: new Date(Date.now() + 90000), phase: 'routing' });
  app = await buildTestApp({ db: f.db }); await app.register(servicesRoutes);
}
it('shows persisted recovery without lease tokens or immutable deletion identifiers', async () => {
  await boot(); const r = await app.inject({ url: '/1/targets/recovery', headers: asUser() });
  expect(r.statusCode).toBe(200); expect(r.json().entries[0]).toMatchObject({ serverId: 5, candidateRuntimeId: 'web-t5-9', busy: true });
  expect(r.body).not.toContain('ownerToken'); expect(r.body).not.toContain('private-lease-token'); expect(r.body).not.toContain('ContainerId');
});
it('does not allow another service owner or an anonymous caller to view or retry recovery', async () => {
  await boot();
  for (const method of ['GET', 'POST'] as const) {
    expect((await app.inject({ method, url: '/1/targets/recovery' })).statusCode).toBe(401);
    expect((await app.inject({ method, url: '/1/targets/recovery', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(404);
  }
  expect(io.agent).not.toHaveBeenCalled(); expect(await f.db.select().from(fanoutTransitions)).toHaveLength(1);
});
it('operator retries preserve an active deployment lease and report that it remains busy', async () => {
  await boot(); const r = await app.inject({ method: 'POST', url: '/1/targets/recovery', headers: asUser() });
  expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ recovered: 0, held: 0, entries: [{ busy: true }] });
  expect(io.agent).not.toHaveBeenCalled();
});
