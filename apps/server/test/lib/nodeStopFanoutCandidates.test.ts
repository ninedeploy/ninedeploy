import { expect, it } from 'vitest';
import { createDb, runMigrations, deployments, eq, servers, services, serviceTargets } from '@ninedeploy/db';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent, type NodeLifecycleControllerDeps } from '../../src/lib/nodeLifecycleController.js';

it.each([true, false])('stops and retires candidates on both nodes when the second node has a selected runtime: %s', async selected => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await runMigrations(c.db);
    await c.db.insert(servers).values([{ id: 4, name: 'Primary', host: 'primary.test', tokenEncrypted: 'fixture' }, { id: 5, name: 'Target', host: 'target.test', tokenEncrypted: 'fixture' }]);
    await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, runtimeId: 'web-9', status: 'running', port: 3000 });
    await c.db.insert(serviceTargets).values({ id: 1, serviceId: 1, serverId: 5, runtimeId: selected ? 'web-t5-9' : null, status: 'running' });
    await c.db.insert(deployments).values([{ id: 9, serviceId: 1, status: 'running' }, { id: 10, serviceId: 1, status: 'deploying' }]);
    const rows = [
      { serverId: 4, id: 'a'.repeat(64), name: 'web-9', deploymentId: 9, running: true },
      { serverId: 4, id: 'b'.repeat(64), name: 'web-10', deploymentId: 10, running: true },
      ...(selected ? [{ serverId: 5, id: 'c'.repeat(64), name: 'web-t5-9', deploymentId: 9, running: true }] : []),
      { serverId: 5, id: 'd'.repeat(64), name: 'web-t5-10', deploymentId: 10, running: true },
    ];
    const routes: number[] = [];
    const deps: NodeLifecycleControllerDeps = {
      sealed: async () => true, route: async (_service, _signal, serverId) => { routes.push(serverId!); }, sleep: async () => {},
      agent: async (serverId, op, params) => {
        const reply = (prefix: string, body: unknown) => ({ exitCode: 0, lines: [prefix + JSON.stringify(body)] });
        if (op === 'agent.ping') return reply('ND-AGENT ', { version: '0.19.0', caps: ['docker.lifecycle', 'docker.lifecycle.generations', 'docker.lifecycle.creationFence', 'docker.lifecycle.retire', 'docker.recovery', 'docker.readiness', 'proxy.routingAck'] });
        if (op === 'docker.identity') {
          const row = rows.find(item => item.serverId === serverId && item.name === params.name);
          return reply('ND-CONTAINER ', row ? { id: row.id, name: row.name, managed: 'service', serviceId: '1', deploymentId: String(row.deploymentId) } : null);
        }
        const targets = params.targets as Array<{ id: string; name: string; deploymentId: number }>;
        if (op === 'docker.lifecycle') {
          for (const target of targets) { const row = rows.find(item => item.serverId === serverId && item.id === target.id); if (row) row.running = false; }
          return reply('ND-LIFECYCLE ', { requestId: params.requestId, serviceId: params.serviceId, deploymentId: params.deploymentId,
            revision: params.revision, action: params.action, complete: true, items: targets.map(target => ({ ...target, running: false })) });
        }
        if (op === 'docker.lifecycleRetire') {
          for (const target of targets) { const index = rows.findIndex(item => item.serverId === serverId && item.id === target.id); if (index >= 0) rows.splice(index, 1); }
          return reply('ND-LIFECYCLE-RETIRED ', { requestId: params.requestId, serviceId: params.serviceId, revision: params.revision,
            complete: true, items: targets.map(target => ({ ...target, removed: true })) });
        }
        throw new Error(`Unexpected ${op}`);
      },
    };
    const service = (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    const intent = await acceptNodeLifecycleIntent(c.db, service, 'stop');
    expect(await executeNodeLifecycleIntent(c.db, intent.id, deps)).toEqual({ state: 'completed' });
    expect(routes).toEqual([4, 5]);
    expect(rows.map(row => row.name)).toEqual(selected ? ['web-9', 'web-t5-9'] : ['web-9']);
    expect(rows.every(row => !row.running)).toBe(true);
    expect((await c.db.query.serviceTargets.findFirst({ where: eq(serviceTargets.id, 1) }))?.status).toBe('idle');
  } finally { c.client?.close(); }
});
