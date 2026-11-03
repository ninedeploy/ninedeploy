import { join } from 'node:path';
import { servingReceiptFixture } from './servingTrafficReceipt.js';
import { nodeSleepEvidence } from './nodeSleepEvidence.js';
import { createNodeSleepCoordinator } from '../../src/lib/nodeSleepCoordinator.js';
import { services, deployments, domains, nodeAutoscaleCapacity } from '@ninedeploy/db';
const f = await servingReceiptFixture(`file:${join(process.argv[2]!, 'panel.db')}`);
let coordinator: ReturnType<typeof createNodeSleepCoordinator> | undefined;
try {
  await f.c.db.update(services).set({ sleepAfterMinutes: 5 });
  for (let id = 2; id <= 6; id++) {
    const deploymentId = id + 8, slug = `web${id}`, runtimeId = `${slug}-${deploymentId}`;
    await f.c.db.insert(services).values({ id, name: slug, slug, type: 'docker', serverId: 4, status: 'running', runtimeId, port: 3000, sleepAfterMinutes: 5 });
    await f.c.db.insert(deployments).values({ id: deploymentId, serviceId: id, status: 'running' });
    await f.c.db.insert(domains).values({ serviceId: id, hostname: `${slug}.test`, status: 'active' });
    await f.c.db.insert(nodeAutoscaleCapacity).values({ deploymentId, serviceId: id, serverId: 4, runtimeId, imageId: `sha256:${'f'.repeat(64)}`,
      targets: [{ name: runtimeId, id: String(id).repeat(64) }] });
  }
  const proofs = new Map();
  for (let id = 1; id <= 6; id++) proofs.set(id, await nodeSleepEvidence(f.c.db, 300_000, id === 1 ? {} : {
    serviceId: id, deploymentId: id + 8, slug: `web${id}`, serving: [{ name: `web${id}-${id + 8}`, id: String(id).repeat(64), port: 3000 }],
  }));
  const taken: number[] = [], errors: string[] = []; let entered = 0;
  coordinator = createNodeSleepCoordinator(f.c.db, { idle: { takeEvidence: service => { taken.push(service.id); return proofs.get(service.id)?.token; } },
    onError: error => errors.push(String((error as { cause?: { code?: string } }).cause?.code ?? error)),
    runtime: signal => ({ sealed: () => new Promise(resolve => { entered++; signal.addEventListener('abort', () => resolve(false), { once: true }); }),
      agent: async () => { throw new Error('No agent mutation expected'); }, route: async () => { throw new Error('No routing expected'); }, drain: async () => {} }),
  });
  await coordinator.tick();
  for (const deadline = Date.now() + 6000; entered + errors.length < 4 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 10));
  await coordinator.tick(); await coordinator.close();
  console.log(JSON.stringify({ taken, entered, errors }));
} finally { await coordinator?.close(); f.c.client?.close(); }
