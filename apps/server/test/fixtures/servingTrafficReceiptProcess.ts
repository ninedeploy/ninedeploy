import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createDb, nodeServingTrafficReceipts } from '@ninedeploy/db';
import { servingTrafficOpen, type ServingTrafficSnapshot } from '@ninedeploy/schemas';
import { servingReceiptFixture } from './servingTrafficReceipt.js';
import { consumeNodeServingTraffic } from '../../src/lib/nodeServingTrafficReceipt.js';
import { proxyTrafficRoutingGeneration, proxyTrafficTargetHash } from '../../src/lib/proxyTrafficCounter.js';

const [mode, root] = process.argv.slice(2);
assert(root && ['seed', 'replay', 'concurrent'].includes(mode!));
const url = `file:${join(root, 'panel.db').replaceAll('\\', '/')}`, seedFile = join(root, 'seed.json');
const observation = { openedAt: 100_000, receivedAt: 101_000 };
if (mode === 'seed') {
  const { c, input, context } = await servingReceiptFixture(url);
  try {
    const receipt: ServingTrafficSnapshot = { protocol: 1, purpose: 'autoscale', basis: 'traefik-request-sequence', precisionMs: 1,
      windowId: 'c'.repeat(32), requestId: input.requestId, epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64),
      nodeId: 4, serviceId: 1, deploymentId: 9, targetHash: proxyTrafficTargetHash(input), routingGeneration: proxyTrafficRoutingGeneration(input),
      elapsedMs: 1000, startCounter: '10', endCounter: '11', observed: 0, expected: 0, complete: true,
      serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };
    assert.equal((await consumeNodeServingTraffic(c.db, input, receipt, { context, ...observation }, () => observation.receivedAt)).value, 0);
    writeFileSync(seedFile, JSON.stringify({ input, receipt, context }));
    process.stdout.write(JSON.stringify({ persisted: 1 }));
  } finally { c.client?.close(); }
} else {
  const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  const c = createDb({ url }); await c.ready;
  try {
    if (mode === 'replay') {
      await assert.rejects(consumeNodeServingTraffic(c.db, seed.input, seed.receipt, { context: seed.context, ...observation }, () => observation.receivedAt), /already consumed/);
      assert.equal((await c.db.select().from(nodeServingTrafficReceipts)).length, 1);
      process.stdout.write(JSON.stringify({ replayRefused: true, persisted: 1 }));
    } else {
      const second = createDb({ url }); await second.ready;
      try {
        const input = servingTrafficOpen.parse({ ...seed.input, requestId: '2'.repeat(32) });
        const receipt = { ...seed.receipt, requestId: input.requestId, windowId: '2'.repeat(32), targetHash: proxyTrafficTargetHash(input), startCounter: '12', endCounter: '13' };
        const results = await Promise.allSettled([c.db, second.db].map(db => consumeNodeServingTraffic(db, input, receipt, { context: seed.context, ...observation }, () => observation.receivedAt)));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter(result => result.status === 'rejected').length, 1);
        assert.equal((await c.db.select().from(nodeServingTrafficReceipts)).length, 2);
        process.stdout.write(JSON.stringify({ accepted: 1, rejected: 1, persisted: 2 }));
      } finally { second.client?.close(); }
    }
  } finally { c.client?.close(); }
}
