import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, nodeSleepTransitions, services } from '@ninedeploy/db';
import { admitNodeSleep, checkpointNodeSleep, nodeSleepCommand, recoverNodeSleep } from '../../src/lib/nodeSleepAuthority.js';
import { servingReceiptFixture } from './servingTrafficReceipt.js';
import { nodeSleepEvidence } from './nodeSleepEvidence.js';

const [mode, root] = process.argv.slice(2); assert(root && ['accept', 'recover'].includes(mode!));
const url = `file:${join(root, 'sleep.db').replaceAll('\\', '/')}`, seedFile = join(root, 'seed.json');
if (mode === 'accept') {
  const f = await servingReceiptFixture(url);
  try {
    await f.c.db.update(services).set({ sleepAfterMinutes: 5 });
    const service = (await f.c.db.query.services.findFirst())!, proof = await nodeSleepEvidence(f.c.db);
    const admission = await admitNodeSleep(f.c.db, service, proof.token); assert(admission);
    await f.c.db.update(nodeSleepTransitions).set({ leaseUntil: new Date(0) });
    writeFileSync(seedFile, JSON.stringify({ admission, command: nodeSleepCommand(admission, 'fence') }));
    process.stdout.write(JSON.stringify({ persisted: true, epoch: admission.owner.epoch }));
  } finally { f.c.client?.close(); }
} else {
  const c = createDb({ url }); await c.ready;
  try {
    const before = JSON.parse(readFileSync(seedFile, 'utf8')), recovered = await recoverNodeSleep(c.db, before.admission.serviceId); assert(recovered);
    assert.equal(recovered.owner.epoch, before.admission.owner.epoch); assert.notEqual(recovered.workerToken, before.admission.workerToken);
    assert.deepEqual(nodeSleepCommand(recovered, 'fence'), before.command);
    await assert.rejects(checkpointNodeSleep(c.db, before.admission));
    assert.equal((await checkpointNodeSleep(c.db, recovered)).phase, 'accepted');
    assert.equal(await recoverNodeSleep(c.db, recovered.serviceId), null);
    assert.equal((await c.db.query.services.findFirst())!.asleepAt, null);
    process.stdout.write(JSON.stringify({ recovered: true, oldWorkerRefused: true, sameCommand: true, slept: false }));
  } finally { c.client?.close(); }
}
