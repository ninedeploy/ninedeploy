import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDb, deployments, eq, nodeAutoscaleTransitions, runMigrations, servers, services } from '/app/packages/db/dist/index.js';
import { prepareNodeAutoscaleCapacity } from '/app/apps/server/dist/engine/builders/nodeAutoscalePrepare.js';
import { createNodeRuntimeMutation } from '/app/apps/server/dist/lib/nodeRuntimeMutation.js';
import { admitNodeAutoscale, recoverNodeAutoscaleAdmission } from '/app/apps/server/dist/lib/nodeAutoscaleAuthority.js';
import { executeNodeAutoscale } from '/app/apps/server/dist/lib/nodeAutoscaleController.js';
import { reserveServiceRuntimeOwner } from '/app/apps/server/dist/lib/serviceRuntimeOwner.js';

const c = createDb({ url: `file:${join(process.cwd(), 'autoscale-panel.db')}` }), agent = createNodeRuntimeMutation(join(process.cwd(), '.agent-work', '.lifecycle'));
const imageId = process.env.PROOF_IMAGE;
assert.match(imageId ?? '', /^sha256:[a-f0-9]{64}$/);
try {
  await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Fixture node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 27, name: 'Fixture', slug: 'proofscale', type: 'docker', serverId: 4, status: 'running', runtimeId: 'proofscale-90', cmd: ['sh', '-c', 'trap "exit 0" TERM; while :; do sleep 1; done'],
    autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 120 } });
  await c.db.insert(deployments).values({ id: 90, serviceId: 27, status: 'running' });
  const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 27) }));
  const deployed = await reserveServiceRuntimeOwner(c.db, 27, 'deploy', null, 'a'.repeat(32));
  const owner = { serviceId: 27, serverId: 4, deploymentId: 90, epoch: deployed.epoch, requestId: deployed.requestId };
  mkdirSync('.agent-env', { recursive: true }); writeFileSync('.agent-env/proofscale-90.env', 'FIXTURE=1', { mode: 0o600 });
  const prepared = await prepareNodeAutoscaleCapacity({ fence: params => agent.fence(params), prepare: params => agent.prepare(params) },
    { service: await service(), owner, imageId, envFile: '.agent-env/proofscale-90.env', creationWatermark: 90, extraNetworks: ['nd-extra'] });
  const state = target => {
    const result = spawnSync('docker', ['inspect', '--type', 'container', '--format', '{{.State.Running}}', target.id], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim() === 'true';
  };
  assert.deepEqual(prepared.capacity.map(state), [true, false, false]);
  let lost = true, previousStart; const phases = [];
  const deps = {
    fence: (_node, input) => agent.fence(input), inventory: (_node, input) => agent.inventory(input),
    start: async (_node, input) => { previousStart = input; const result = await agent.start(input); if (lost) { lost = false; throw Error('fixture lost Start receipt'); } return result; },
    stop: (_node, input) => agent.stop(input), ready: async (_service, targets) => targets.every(state),
    route: async () => { phases.push('route'); }, drain: async () => { phases.push('drain'); },
  };
  const up = await admitNodeAutoscale(c.db, await service(), 2);
  await assert.rejects(executeNodeAutoscale(c.db, up, deps), /lost Start receipt/);
  assert.equal((await service()).runtimeReplicas, 1); assert.deepEqual(prepared.capacity.map(state), [true, true, false]);
  await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 27));
  await executeNodeAutoscale(c.db, await recoverNodeAutoscaleAdmission(c.db, 27), deps);
  assert.equal((await service()).runtimeReplicas, 2);
  await executeNodeAutoscale(c.db, await admitNodeAutoscale(c.db, await service(), 1), deps);
  assert.equal((await service()).runtimeReplicas, 1); assert.deepEqual(prepared.capacity.map(state), [true, false, false]);
  await assert.rejects(agent.start(previousStart), /stale/);
  assert.deepEqual(phases, ['route', 'route', 'drain']);
  console.log('PASS real Docker scale-up receipt recovery and scale-down; proxy and readiness are test doubles');
} finally { c.client?.close(); }
