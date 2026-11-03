import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, nodeWakeMaintenance, services } from '@ninedeploy/db';
import { servingReceiptFixture } from './servingTrafficReceipt.js';
import { nodeSleepEvidence } from './nodeSleepEvidence.js';
import { admitNodeSleep, admitNodeWake, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, nodeSleepCommand } from '../../src/lib/nodeSleepAuthority.js';
import { claimNodeWakeMaintenance, checkpointNodeWakeMaintenance, completeNodeWakeMaintenance, confirmNodeWakeMaintenanceRouting, recordNodeWakeMaintenanceCatcher, completeNodeWakeRetirement } from '../../src/lib/nodeWakeMaintenance.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';

const [mode, root] = process.argv.slice(2); assert(root && ['accept', 'recover'].includes(mode!));
const url = `file:${join(root, 'panel.db').replaceAll('\\', '/')}`, seed = join(root, 'claim.json');
if (mode === 'accept') {
  const f = await servingReceiptFixture(url);
  try {
    await f.c.db.update(services).set({ sleepAfterMinutes: 5 }); await nodeWakeKey(f.c.db, 4, true);
    const proof = await nodeSleepEvidence(f.c.db), service = (await f.c.db.query.services.findFirst())!;
    const sleep = await admitNodeSleep(f.c.db, service, proof.token); assert(sleep);
    await advanceNodeSleep(f.c.db, sleep, 'accepted', 'fencing');
    await bindNodeSleepCatcher(f.c.db, sleep, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
    for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed'], ['routed', 'stopping']] as const) await advanceNodeSleep(f.c.db, sleep, from, to);
    const row = (await f.c.db.query.nodeSleepTransitions.findFirst())!;
    await completeNodeSleep(f.c.db, sleep, { ...nodeSleepCommand(sleep, 'stop'), complete: true,
      items: row.targets.map(({ id, name, deploymentId }) => ({ id, name, deploymentId, running: false })) });
    const claim = await claimNodeWakeMaintenance(f.c.db, 4); assert(claim);
    await f.c.db.update(nodeWakeMaintenance).set({ leaseUntil: new Date(0) }); writeFileSync(seed, JSON.stringify(claim));
    process.stdout.write(JSON.stringify({ persisted: true }));
  } finally { f.c.client?.close(); }
} else {
  const c = createDb({ url }); await c.ready;
  try {
    const prior = JSON.parse(readFileSync(seed, 'utf8')), service = (await c.db.query.services.findFirst())!, sleeping = (await c.db.query.nodeSleepTransitions.findFirst())!;
    assert.equal(await admitNodeWake(c.db, service, { nodeId: 4, token: sleeping.wakeToken, catcherId: sleeping.catcherId!, demandAt: Date.now(), receivedAt: Date.now() }), null);
    const claim = await claimNodeWakeMaintenance(c.db, 4); assert(claim); assert.equal(claim.requestId, prior.requestId); assert.equal(claim.generation, prior.generation);
    assert.notEqual(claim.workerToken, prior.workerToken); await assert.rejects(checkpointNodeWakeMaintenance(c.db, prior));
    await recordNodeWakeMaintenanceCatcher(c.db, claim, { id: 'e'.repeat(64), image: `sha256:${'f'.repeat(64)}`, name: `ninedeploy-wake-g-${'f'.repeat(32)}` });
    await confirmNodeWakeMaintenanceRouting(c.db, claim); assert.equal(await completeNodeWakeMaintenance(c.db, claim), 1);
    assert.equal((await c.db.query.nodeSleepTransitions.findFirst())!.catcherId, 'e'.repeat(64));
    assert.equal((await c.db.query.nodeWakeMaintenance.findFirst())!.phase, 'retiring');
    await completeNodeWakeRetirement(c.db, claim, [{ id: 'c'.repeat(64), name: 'ninedeploy-wake', fenced: true, removed: true }]);
    assert.equal((await c.db.query.nodeWakeMaintenance.findFirst())!.phase, 'completed');
    process.stdout.write(JSON.stringify({ recovered: true, oldWorkerRefused: true, admissionBlocked: true, rebound: 1 }));
  } finally { c.client?.close(); }
}
