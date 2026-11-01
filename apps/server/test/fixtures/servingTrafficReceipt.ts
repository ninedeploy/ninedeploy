import { createDb, deployments, domains, nodeAutoscaleCapacity, runMigrations, servers, services } from '@ninedeploy/db';
import { servingTrafficOpen } from '@ninedeploy/schemas';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import { nodeServingTrafficContext } from '../../src/lib/nodeServingTrafficContext.js';

export async function servingReceiptFixture(url: string) {
  const c = createDb({ url }); await c.ready; await runMigrations(c.db);
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, status: 'running', runtimeId: 'web-9', port: 3000 });
  await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'running' });
  await c.db.insert(domains).values({ serviceId: 1, hostname: 'web.test', status: 'active' });
  await c.db.insert(nodeAutoscaleCapacity).values({ deploymentId: 9, serviceId: 1, serverId: 4, runtimeId: 'web-9', imageId: `sha256:${'f'.repeat(64)}`,
    targets: [{ name: 'web-9', id: 'a'.repeat(64) }, { name: 'web-9-r2', id: 'b'.repeat(64) }] });
  const input = servingTrafficOpen.parse({ purpose: 'autoscale', requestId: '1'.repeat(32), nodeId: 4, serviceId: 1, deploymentId: 9, slug: 'web', durationMs: 1000,
    routingConfig: await renderDynamicConfig(c.db, { serverId: 4 }), serving: [{ name: 'web-9', id: 'a'.repeat(64), port: 3000 }] });
  return { c, input, context: await nodeServingTrafficContext(c.db, input) };
}
