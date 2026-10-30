import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDb, deploymentRuntimeOwners, deployments, eq, nodeDeploymentPreparations, runMigrations, servers, services } from '@ninedeploy/db';
import { beginNodeDeploymentPreparation, completeNodeDeploymentPreparation, readNodeDeploymentPreparation } from '../../src/lib/nodeDeploymentPreparation.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';

let c: ReturnType<typeof createDb>;
const owner = { deploymentId: 9, serviceId: 1, serverId: 4, epoch: 1, requestId: 'a'.repeat(32) };
const spec = { runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`, serving: 1, capacity: 3 };
const targets = ['web-9', 'web-9-r2', 'web-9-r3'].map((name, i) => ({ name, id: String(i + 1).repeat(64) }));
beforeEach(async () => {
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'fixture', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'deploying' });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'deploying' });
  await reserveServiceRuntimeOwner(c.db, 1, 'deploy', null, owner.requestId);
  await c.db.insert(deploymentRuntimeOwners).values(owner);
});
afterEach(() => c.client?.close());

it('records and replays the same intent and immutable receipt', async () => {
  expect(await beginNodeDeploymentPreparation(c.db, owner, spec)).toMatchObject({ ...spec, phase: 'preparing', targets: null });
  expect(await beginNodeDeploymentPreparation(c.db, owner, spec)).toMatchObject({ phase: 'preparing' });
  expect(await completeNodeDeploymentPreparation(c.db, owner, targets)).toMatchObject({ phase: 'prepared', targets });
  expect(await completeNodeDeploymentPreparation(c.db, owner, targets)).toMatchObject({ phase: 'prepared', targets });
  expect(await completeNodeDeploymentPreparation(c.db, owner, targets.map(({ id, name }) => ({ id, name })))).toMatchObject({ phase: 'prepared', targets });
  expect(await readNodeDeploymentPreparation(c.db, owner)).toMatchObject({ phase: 'prepared', targets });
  expect((await c.db.select().from(nodeDeploymentPreparations))).toHaveLength(1);
});
it('fails closed when stored preparation evidence is malformed', async () => {
  expect(await readNodeDeploymentPreparation(c.db, owner)).toBeNull();
  await beginNodeDeploymentPreparation(c.db, owner, spec);
  expect(await readNodeDeploymentPreparation(c.db, owner)).toMatchObject({ phase: 'preparing' });
  await c.db.update(nodeDeploymentPreparations).set({ capacity: 11 }).where(eq(nodeDeploymentPreparations.deploymentId, 9));
  await expect(readNodeDeploymentPreparation(c.db, owner)).rejects.toThrow(/evidence is invalid/);
  await expect(completeNodeDeploymentPreparation(c.db, owner, targets)).rejects.toThrow(/intent unavailable/);
});
it('rejects changed intent and foreign generation without replacing the original', async () => {
  await beginNodeDeploymentPreparation(c.db, owner, spec);
  await expect(beginNodeDeploymentPreparation(c.db, owner, { ...spec, imageId: `sha256:${'e'.repeat(64)}` })).rejects.toThrow(/intent changed/);
  await expect(beginNodeDeploymentPreparation(c.db, owner, { ...spec, runtimeId: 'other-9' })).rejects.toThrow(/generation/);
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]).toMatchObject({ ...spec, phase: 'preparing' });
});
it('rejects incomplete or changed receipt without discarding the original', async () => {
  await beginNodeDeploymentPreparation(c.db, owner, spec);
  for (const bad of [targets.slice(0, 2), [targets[0]!, { ...targets[1]!, id: targets[0]!.id }, targets[2]!],
    [targets[0]!, { ...targets[1]!, name: 'foreign' }, targets[2]!]]) {
    await expect(completeNodeDeploymentPreparation(c.db, owner, bad)).rejects.toThrow(/receipt/);
  }
  await completeNodeDeploymentPreparation(c.db, owner, targets);
  await expect(completeNodeDeploymentPreparation(c.db, owner, [targets[0]!, { ...targets[1]!, id: 'd'.repeat(64) }, targets[2]!])).rejects.toThrow(/receipt changed/);
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]?.targets).toEqual(targets);
});
it('refuses old-owner updates after a newer operation or node placement wins', async () => {
  await beginNodeDeploymentPreparation(c.db, owner, spec);
  const previous = await c.db.query.serviceRuntimeOwners.findFirst({ where: (s, { eq: equals }) => equals(s.serviceId, 1) });
  await reserveServiceRuntimeOwner(c.db, 1, 'stop', previous!, 'b'.repeat(32));
  await expect(completeNodeDeploymentPreparation(c.db, owner, targets)).rejects.toThrow(/ownership/);
  await expect(readNodeDeploymentPreparation(c.db, owner)).rejects.toThrow(/ownership/);
  expect((await c.db.select().from(nodeDeploymentPreparations))[0]?.phase).toBe('preparing');
  await c.db.update(services).set({ serverId: null }).where(eq(services.id, 1));
  await expect(beginNodeDeploymentPreparation(c.db, owner, spec)).rejects.toThrow(/ownership|placement/);
});
it('does not admit new preparation for a settled deployment even if its owner remains current', async () => {
  for (const status of ['failed', 'cancelled', 'running'] as const) {
    await c.db.update(deployments).set({ status }).where(eq(deployments.id, 9));
    await expect(beginNodeDeploymentPreparation(c.db, owner, spec)).rejects.toThrow(/deployment.*active/i);
    expect(await c.db.select().from(nodeDeploymentPreparations)).toEqual([]);
  }
});
it('can retain an already-started creation receipt after cancellation', async () => {
  await beginNodeDeploymentPreparation(c.db, owner, spec);
  await c.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 9));
  expect(await completeNodeDeploymentPreparation(c.db, owner, targets)).toMatchObject({ phase: 'prepared', targets });
});
