// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Owned hosted fixture, outside Turbo.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createDb, runMigrations, services, deployments, domains, servers } from '/app/packages/db/dist/index.js';
import { buildAgentApp } from '/app/apps/server/dist/agentApp.js';
import { agentRoutes } from '/app/apps/server/dist/agent.js';
import { encrypt, sha256 } from '/app/apps/server/dist/lib/crypto.js';
import { ensureNodeWakeCatcher, readNodeWakeDemand } from '/app/apps/server/dist/lib/nodeWakeCatcherClient.js';
import { nodeWakeKey } from '/app/apps/server/dist/lib/nodeWakeKey.js';
import { renderDynamicConfig, renderStaticConfig, getAcmeEmail, getDnsConfig } from '/app/apps/server/dist/engine/proxy.js';
import { withRoutingAck } from '/app/apps/server/dist/lib/proxyRoutingAck.js';
import { NodeIdleCoverage } from '/app/apps/server/dist/lib/nodeIdleCoverage.js';
import { nodeServingTrafficContext } from '/app/apps/server/dist/lib/nodeServingTrafficContext.js';
import { proxyTrafficTargetHash, proxyTrafficRoutingGeneration } from '/app/apps/server/dist/lib/proxyTrafficCounter.js';
import { admitNodeSleep, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, nodeSleepCommand } from '/app/apps/server/dist/lib/nodeSleepAuthority.js';
import { claimNodeWakeMaintenance } from '/app/apps/server/dist/lib/nodeWakeMaintenance.js';
import { executeNodeWakeMaintenance } from '/app/apps/server/dist/lib/nodeWakeMaintenanceController.js';
import { nodeWakeMaintenanceRuntime } from '/app/apps/server/dist/lib/nodeWakeMaintenanceRuntime.js';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
const mode = process.argv[2]; assert.ok(['seed', 'recover'].includes(mode));
const token = process.env.ND_PROOF_TOKEN; assert.match(token ?? '', /^[a-f0-9]{64}$/);
const c = createDb({ url: 'file:/fixture/panel.db' }); await c.ready; await runMigrations(c.db);
const app = await buildAgentApp(); await app.register(agentRoutes, { tokenHash: sha256(token), nonceFile: '/fixture/nonces' });
await app.listen({ host: '127.0.0.1', port: 8899 });
try {
  if (mode === 'seed') {
    await c.db.insert(servers).values({ id: 4, name: 'Owned fixture', host: '127.0.0.1', port: 8899, tokenEncrypted: encrypt(token) });
    await c.db.insert(services).values({ id: 1, name: 'Sleeping fixture', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9', port: 3000, sleepAfterMinutes: 5 });
    await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
    await c.db.insert(domains).values({ serviceId: 1, hostname: 'wake.invalid', status: 'active', ssl: false });
    const key = await nodeWakeKey(c.db, 4, true), catcher = await ensureNodeWakeCatcher(c.db, 4, key);
    // Seed a dormant journal using simulated idle/Stop receipts. This fixture
    // accepts maintenance only, not actual idle duration or service shutdown.
    const input = { purpose: 'idle', requestId: randomBytes(16).toString('hex'), nodeId: 4, serviceId: 1, deploymentId: 9, slug: 'web', durationMs: 300_000,
      routingConfig: await renderDynamicConfig(c.db, { serverId: 4 }), serving: [{ name: 'web-9', id: 'a'.repeat(64), port: 3000 }] };
    const opened = { protocol: 1, purpose: 'idle', basis: 'traefik-request-sequence', precisionMs: 1, windowId: randomBytes(16).toString('hex'),
      requestId: input.requestId, epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64), nodeId: 4, serviceId: 1, deploymentId: 9,
      targetHash: proxyTrafficTargetHash(input), routingGeneration: proxyTrafficRoutingGeneration(input), elapsedMs: 0, startCounter: '10', endCounter: null,
      observed: 0, expected: null, complete: false, serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };
    const clock = new NodeIdleCoverage(); clock.complete({ input, opened, finished: { ...opened, elapsedMs: 300_000, endCounter: '11', expected: 0, complete: true },
      beforeOpen: 0, afterOpen: 0, context: await nodeServingTrafficContext(c.db, input) });
    const service = await c.db.query.services.findFirst(), sleep = await admitNodeSleep(c.db, service, clock.takeEvidence()); assert.ok(sleep);
    await advanceNodeSleep(c.db, sleep, 'accepted', 'fencing'); await bindNodeSleepCatcher(c.db, sleep, catcher);
    for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed'], ['routed', 'stopping']]) await advanceNodeSleep(c.db, sleep, from, to);
    await completeNodeSleep(c.db, sleep, { ...nodeSleepCommand(sleep, 'stop'), complete: true, items: [{ id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: false }] });
    mkdirSync('/fixture/.agent-proxy/dynamic', { recursive: true });
    writeFileSync('/fixture/.agent-proxy/dynamic/ninedeploy.yml', withRoutingAck(await renderDynamicConfig(c.db, { serverId: 4 })));
    writeFileSync('/fixture/.agent-proxy/traefik.yml', renderStaticConfig(await getAcmeEmail(c.db), await getDnsConfig(c.db)));
    writeFileSync('/proof/seed.json', JSON.stringify({ catcherId: catcher.id, image: catcher.image, seededDormantJournal: true }));
  } else {
    const claim = await claimNodeWakeMaintenance(c.db, 4); assert.ok(claim);
    const result = await executeNodeWakeMaintenance(c.db, claim, nodeWakeMaintenanceRuntime(c.db));
    const row = await c.db.query.nodeWakeMaintenance.findFirst();
    let pinnedDemand = false;
    if (result.state === 'completed') {
      const sleeping = await c.db.query.nodeSleepTransitions.findFirst();
      assert.equal(sleeping.catcherId, row.catcherId); assert.equal(sleeping.catcherName, row.catcherName);
      for (const deadline = Date.now() + 5000; ;) {
        const demand = await readNodeWakeDemand(c.db, 4, row.catcherId, Math.max(0, Date.now() - 60_000), undefined, row.catcherName);
        pinnedDemand = demand.items.some(item => item.token === sleeping.wakeToken && item.count > 0);
        if (pinnedDemand || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    writeFileSync('/proof/maintenance.json', JSON.stringify({ result, phase: row.phase, catcherId: row.catcherId, catcherName: row.catcherName,
      pinnedDemand, realSealedHttp: true }));
  }
} finally { await app.close(); c.client?.close(); }
