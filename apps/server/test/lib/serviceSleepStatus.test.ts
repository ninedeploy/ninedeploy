import { beforeEach, afterEach, expect, it } from 'vitest';
import { services, eq } from '@ninedeploy/db';
import { serviceSleepStatus } from '@ninedeploy/schemas';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, holdNodeSleep, nodeSleepCommand } from '../../src/lib/nodeSleepAuthority.js';
import { readServiceSleepStatus, registerNodeSleepObserver } from '../../src/lib/serviceSleepStatus.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';

let f: Awaited<ReturnType<typeof servingReceiptFixture>>;
const get = async () => (await f.c.db.query.services.findFirst())!;
beforeEach(async () => { f = await servingReceiptFixture('file::memory:'); await f.c.db.update(services).set({ sleepAfterMinutes: 5 }); });
afterEach(() => f.c.client?.close());

it('exposes a pending sleep without its execution authority or raw worker failure', async () => {
  const proof = await nodeSleepEvidence(f.c.db), admission = (await admitNodeSleep(f.c.db, await get(), proof.token))!;
  const pending = serviceSleepStatus.parse(await readServiceSleepStatus(f.c.db, await get()));
  expect(pending).toMatchObject({ phase: 'sleeping', idleMs: 300_000 });
  await holdNodeSleep(f.c.db, admission, 'private-worker-token secret SQL bindings');
  await f.c.db.update(services).set({ sleepAfterMinutes: null });
  const held = serviceSleepStatus.parse(await readServiceSleepStatus(f.c.db, await get()));
  expect(held).toMatchObject({ phase: 'held', configured: false, holding: 'Node verification is pending; the original command is retained' });
  for (const secret of [admission.workerToken, admission.binding, admission.owner.requestId!, 'secret SQL', 'private-worker-token']) expect(JSON.stringify(held)).not.toContain(secret);
});

it('reports asleep and retained fallback until the explicit Start actually clears it', async () => {
  const proof = await nodeSleepEvidence(f.c.db), admission = (await admitNodeSleep(f.c.db, await get(), proof.token))!;
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed'], ['routed', 'stopping']] as const) await advanceNodeSleep(f.c.db, admission, from, to);
  await completeNodeSleep(f.c.db, admission, { ...nodeSleepCommand(admission, 'stop'), complete: true,
    items: [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: false }] });
  expect(await readServiceSleepStatus(f.c.db, await get())).toMatchObject({ phase: 'asleep', idleMs: 300_000 });
  await acceptNodeLifecycleIntent(f.c.db, await get(), 'start');
  expect(await readServiceSleepStatus(f.c.db, await get())).toMatchObject({ phase: 'waking', holding: 'Application readiness and routing are pending' });
});

it('ignores an old generation journal and never invents coverage for a stopped service', async () => {
  const proof = await nodeSleepEvidence(f.c.db); await admitNodeSleep(f.c.db, await get(), proof.token);
  await f.c.db.update(services).set({ runtimeId: 'web-10', status: 'stopped' }).where(eq(services.id, 1));
  expect(await readServiceSleepStatus(f.c.db, await get())).toMatchObject({ phase: 'held', idleMs: null, idleSatisfied: false,
    holding: 'The service is not running with a routable application port' });
});

it('binds observer registration to one DB lifetime and retains a newer registration after old cleanup', async () => {
  const other = await servingReceiptFixture('file::memory:');
  const removeOld = registerNodeSleepObserver(f.c.db, { status: () => ({ idleMs: 10, requiredMs: 300_000, idleSatisfied: false, holding: null }) });
  const removeNew = registerNodeSleepObserver(f.c.db, { status: () => ({ idleMs: 20, requiredMs: 300_000, idleSatisfied: false, holding: null }) });
  try {
    removeOld();
    expect(await readServiceSleepStatus(f.c.db, await get())).toMatchObject({ idleMs: 20, nodeControllerActive: true, holding: null });
    expect((await readServiceSleepStatus(other.c.db, (await other.c.db.query.services.findFirst())!)).nodeControllerActive).toBe(false);
  } finally { removeNew(); other.c.client?.close(); }
  expect((await readServiceSleepStatus(f.c.db, await get())).nodeControllerActive).toBe(false);
});
