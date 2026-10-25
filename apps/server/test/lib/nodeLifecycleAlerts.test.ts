import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auditLog, createDb, eq, nodeLifecycleIntents, notificationChannels, notificationLog, runMigrations, servers, serviceNotificationChannels, services, users } from '@ninedeploy/db';
import { createNodeRecoveryNotifier } from '../../src/lib/nodeLifecycleAlerts.js';
import { acceptNodeLifecycleIntent, claimNodeLifecycleIntent, holdNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { mapAuditToDomainEvent } from '../../src/kernel/auditBridge.js';
import { encrypt } from '../../src/lib/crypto.js';
import { HttpError } from '../../src/lib/errors.js';

const delivery = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/egressGuard.js', async original => ({ ...await original<typeof import('../../src/lib/egressGuard.js')>(), guardedFetch: delivery }));

let connection: ReturnType<typeof createDb>;
const service = async () => (await connection.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
const alerts = () => connection.db.select().from(auditLog);
async function heldCommand() {
  const command = await acceptNodeLifecycleIntent(connection.db, await service(), 'start');
  const claimed = await claimNodeLifecycleIntent(connection.db, command.id);
  await holdNodeLifecycleIntent(connection.db, claimed!, Error('Private agent output: token=fixture-secret'));
  return command.id;
}

beforeEach(async () => {
  delivery.mockReset(); delivery.mockResolvedValue(new Response('{}', { status: 200 }));
  connection = createDb({ url: 'file::memory:' }); await connection.ready; await runMigrations(connection.db);
  await connection.db.insert(users).values({ id: 1, email: 'alerts@example.test', passwordHash: 'fixture' });
  await connection.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await connection.db.insert(services).values({ id: 1, ownerUserId: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, runtimeId: 'web-9', status: 'running' });
});
afterEach(() => { vi.useRealTimers(); connection.client?.close(); });

it('coalesces concurrent and repeated warnings, re-alerts after cooldown and keeps agent output private', async () => {
  const id = await heldCommand();
  const notify = createNodeRecoveryNotifier(connection.db).held;
  vi.useFakeTimers({ toFake: ['Date'] });
  await Promise.all([notify(1, 'start', id), notify(1, 'start', id), notify(1, 'start', id)]);
  expect(await alerts()).toHaveLength(1);
  vi.setSystemTime(Date.now() + 599_999); await notify(1, 'start', id);
  expect(await alerts()).toHaveLength(1);
  vi.setSystemTime(Date.now() + 1); await notify(1, 'start', id);
  const rows = await alerts();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ action: 'alert.service_recovery_held', entity: 'Web #1', meta: { serviceId: 1, serverId: 4, commandId: id, action: 'start', phase: 'preparing' } });
  expect(JSON.stringify(rows)).not.toContain('fixture-secret');
  expect((await service()).status).toBe('running');
});

it('alerts a new held command immediately and ignores the superseded command', async () => {
  const notify = createNodeRecoveryNotifier(connection.db).held;
  const old = await heldCommand(); await notify(1, 'start', old);
  const current = await heldCommand();
  await notify(1, 'start', old); await notify(1, 'start', current);
  expect((await alerts()).map(row => row.meta?.['commandId'])).toEqual([old, current]);
});

it('delivers the real audit event through the service alert subscription and records its delivery', async () => {
  await connection.db.update(users).set({ isInstanceOperator: true }).where(eq(users.id, 1));
  await connection.db.insert(notificationChannels).values({ id: 3, name: 'Owned fixture', type: 'webhook', targetEncrypted: encrypt('https://fixture.invalid/held'), eventFilter: 'deploy.failed' });
  await connection.db.insert(serviceNotificationChannels).values({ serviceId: 1, channelId: 3, scope: 'alert' });
  await createNodeRecoveryNotifier(connection.db).held(1, 'start', await heldCommand());
  await vi.waitFor(async () => expect(await connection.db.select().from(notificationLog)).toMatchObject([{ channelId: 3, event: 'alert.service_recovery_held', status: 'sent', attempts: 1 }]));
  expect(delivery).toHaveBeenCalledOnce();
  const [url, init] = delivery.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://fixture.invalid/held');
  expect(JSON.parse(init.body as string)).toMatchObject({ event: 'alert.service_recovery_held', entity: 'Web #1' });
  expect(init.body).not.toContain('fixture-secret');
});

it('does not alert a service whose recovery receipt no longer exists', async () => {
  await createNodeRecoveryNotifier(connection.db).held(1, 'start', 99);
  expect(await alerts()).toEqual([]);
});

it.each(['queued', 'busy', 'completed', 'superseded', 'wrong-action', 'replaced', 'swarm', 'deleted'] as const)('suppresses a %s command that is not an idle current recovery hold', async state => {
  const id = await heldCommand();
  if (state === 'queued') await connection.db.update(nodeLifecycleIntents).set({ reason: null }).where(eq(nodeLifecycleIntents.id, id));
  if (state === 'busy') await connection.db.update(nodeLifecycleIntents).set({ ownerToken: 'new-owner', leaseUntil: new Date(Date.now() + 90_000) }).where(eq(nodeLifecycleIntents.id, id));
  if (state === 'completed' || state === 'superseded') await connection.db.update(nodeLifecycleIntents).set({ phase: state }).where(eq(nodeLifecycleIntents.id, id));
  if (state === 'replaced') await connection.db.update(services).set({ runtimeId: 'web-10' }).where(eq(services.id, 1));
  if (state === 'swarm') await connection.db.update(services).set({ orchestrator: 'swarm' }).where(eq(services.id, 1));
  if (state === 'deleted') await connection.db.delete(services).where(eq(services.id, 1));
  await createNodeRecoveryNotifier(connection.db).held(1, state === 'wrong-action' ? 'stop' : 'start', id);
  expect(await alerts()).toEqual([]);
});

it.each(['before', 'during-read'] as const)('does not turn %s shutdown cancellation into an operator warning', async when => {
  const id = await heldCommand(), abort = new AbortController();
  if (when === 'before') abort.abort();
  else {
    const original = connection.db.query.services.findFirst.bind(connection.db.query.services);
    vi.spyOn(connection.db.query.services, 'findFirst').mockImplementation(async (...args) => { const row = await original(...args); abort.abort(); return row; });
  }
  await createNodeRecoveryNotifier(connection.db, abort.signal).held(1, 'start', id);
  expect(await alerts()).toEqual([]);
});

it.each(['worker #2 #1', null])('bridges %j recovery holds as warnings rather than dead-service transitions', entity => {
  expect(mapAuditToDomainEvent({ id: 1, action: 'alert.service_recovery_held', entity, actorUserId: null, ts: new Date().toISOString() })).toEqual({
    name: 'alert.triggered', payload: { title: 'Service recovery held', message: entity ?? '', level: 'warn', ...(entity ? { serviceId: 1 } : {}) },
  });
});

it.each(['node_transport_unsealed', 'node_unreachable', 'node_agent_outdated', 'node_feature_disabled', 'node_lifecycle_identity_unknown'])('alerts a %s recovery refusal once without exposing its private message', async code => {
  const notify = createNodeRecoveryNotifier(connection.db), snapshot = await service();
  await notify.unavailable(snapshot, new HttpError(422, code, 'Private token=fixture-secret'));
  await notify.unavailable(snapshot, new HttpError(422, code, 'Repeated private error'));
  const rows = await alerts();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ action: 'alert.service_recovery_held', meta: { serviceId: 1, serverId: 4, code } });
  expect(JSON.stringify(rows)).not.toContain('fixture-secret');
  expect(await connection.db.select().from(nodeLifecycleIntents)).toEqual([]);
  expect((await service()).status).toBe('running');
});

it.each(['stopped', 'replaced', 'moved', 'compose', 'swarm', 'deleted', 'pending', 'superseded-error', 'deployment-busy', 'unclassified-error', 'local', 'no-runtime'] as const)('does not warn about a %s snapshot superseding automatic recovery', async state => {
  const snapshot = await service();
  if (state === 'stopped') await connection.db.update(services).set({ status: 'stopped' }).where(eq(services.id, 1));
  if (state === 'replaced') await connection.db.update(services).set({ runtimeId: 'web-10' }).where(eq(services.id, 1));
  if (state === 'moved') await connection.db.update(services).set({ serverId: null }).where(eq(services.id, 1));
  if (state === 'compose') await connection.db.update(services).set({ type: 'compose' }).where(eq(services.id, 1));
  if (state === 'swarm') await connection.db.update(services).set({ orchestrator: 'swarm' }).where(eq(services.id, 1));
  if (state === 'deleted') await connection.db.delete(services).where(eq(services.id, 1));
  if (state === 'pending') await acceptNodeLifecycleIntent(connection.db, snapshot, 'start');
  if (state === 'local') snapshot.serverId = null;
  if (state === 'no-runtime') snapshot.runtimeId = null;
  const error = state === 'unclassified-error' ? Error('Not a capability refusal')
    : new HttpError(409, state === 'superseded-error' ? 'node_lifecycle_superseded' : state === 'deployment-busy' ? 'node_lifecycle_deployment_busy' : 'node_agent_outdated', 'Fixture refusal');
  await createNodeRecoveryNotifier(connection.db).unavailable(snapshot, error);
  expect(await alerts()).toEqual([]);
});

it('warns about a new failure after a previous command completed', async () => {
  const id = await heldCommand();
  await connection.db.update(nodeLifecycleIntents).set({ phase: 'completed' }).where(eq(nodeLifecycleIntents.id, id));
  await createNodeRecoveryNotifier(connection.db).unavailable(await service(), new HttpError(422, 'node_agent_outdated', 'Fixture refusal'));
  expect(await alerts()).toHaveLength(1);
});

it.each(['before', 'during-read', 'during-receipt-read'] as const)('suppresses a capability warning when shutdown happens %s', async when => {
  const snapshot = await service(), abort = new AbortController();
  if (when === 'before') abort.abort();
  if (when === 'during-read') {
    const original = connection.db.query.services.findFirst.bind(connection.db.query.services);
    vi.spyOn(connection.db.query.services, 'findFirst').mockImplementation(async (...args) => { const row = await original(...args); abort.abort(); return row; });
  }
  if (when === 'during-receipt-read') {
    const original = connection.db.query.nodeLifecycleIntents.findFirst.bind(connection.db.query.nodeLifecycleIntents);
    vi.spyOn(connection.db.query.nodeLifecycleIntents, 'findFirst').mockImplementation(async (...args) => { const row = await original(...args); abort.abort(); return row; });
  }
  await createNodeRecoveryNotifier(connection.db, abort.signal).unavailable(snapshot, new HttpError(422, 'node_agent_outdated', 'Fixture refusal'));
  expect(await alerts()).toEqual([]);
});
