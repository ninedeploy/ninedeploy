import { expect, it } from 'vitest';
import { createDb, runMigrations, services, servers, users, deployments, nodeLifecycleIntents, eq } from '@ninedeploy/db';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent, type NodeLifecycleControllerDeps } from '../../src/lib/nodeLifecycleController.js';
import { claimNodeDeploymentAttempt } from '../../src/lib/nodeDeploymentOwner.js';
import { beginNodeDeploymentPreparation } from '../../src/lib/nodeDeploymentPreparation.js';

it.each(['normal', 'lost-reply', 'failed-before-effect', 'invalid-receipt', 'failed-preparation'] as const)('retires interrupted candidates after %s', async mode => {
  const c = createDb({ url: 'file::memory:' });
  try {
    await c.ready; await runMigrations(c.db);
    await c.db.insert(users).values({ id: 1, email: 'stop-candidate@example.test', passwordHash: 'fixture', isInstanceOperator: true });
    await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
    await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', ownerUserId: 1, serverId: 4,
      runtimeId: 'web-9', status: 'running', runtimeReplicas: 1, port: 3000 });
    await c.db.insert(deployments).values([{ id: 9, serviceId: 1, status: 'running' }, { id: 10, serviceId: 1, status: 'deploying' }]);
    if (mode === 'failed-preparation') {
      await c.db.update(deployments).set({ status: 'queued' }).where(eq(deployments.id, 10));
      const service = (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
      const admitted = await claimNodeDeploymentAttempt(c.db, 10, service, '{}');
      if (!admitted.claimed) throw Error('Missing deployment authority');
      await beginNodeDeploymentPreparation(c.db, admitted.owner, { runtimeId: 'web-10', imageId: `sha256:${'f'.repeat(64)}`, serving: 1, capacity: 2 });
      await c.db.update(deployments).set({ status: 'failed' }).where(eq(deployments.id, 10));
    }
    const containers = [
      { id: 'a'.repeat(64), name: 'web-9', serviceId: 1, deploymentId: 9, running: true },
      { id: 'b'.repeat(64), name: 'web-10', serviceId: 1, deploymentId: 10, running: true },
      { id: 'c'.repeat(64), name: 'web-10-r2', serviceId: 1, deploymentId: 10, running: true },
      { id: 'd'.repeat(64), name: 'other-10', serviceId: 2, deploymentId: 10, running: true },
    ];
    let retirementAttempts = 0;
    const deps: NodeLifecycleControllerDeps = {
      sealed: async () => true, route: async () => {}, sleep: async () => {},
      agent: async (_serverId, op, params) => {
        const reply = (prefix: string, body: unknown) => ({ exitCode: 0, lines: [prefix + JSON.stringify(body)] });
        if (op === 'agent.ping') return reply('ND-AGENT ', { version: '0.19.0', caps: ['docker.lifecycle', 'docker.lifecycle.generations', 'docker.lifecycle.creationFence', 'docker.lifecycle.retire', 'docker.recovery', 'docker.readiness', 'docker.mutations', 'proxy.routingAck'] });
        if (op === 'docker.identity') {
          const found = containers.find(container => container.name === params.name);
          return reply('ND-CONTAINER ', found ? { id: found.id, name: found.name, managed: 'service', serviceId: String(found.serviceId), deploymentId: String(found.deploymentId) } : null);
        }
        if (op === 'docker.runtimeFence') return reply('ND-RUNTIME-FENCE ', { requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, deploymentWatermark: params.deploymentWatermark, complete: true });
        if (op === 'docker.runtimeInventory') return reply('ND-RUNTIME-INVENTORY ', { requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true,
          items: containers.filter(container => container.serviceId === params.serviceId).map(({ serviceId: _serviceId, ...container }) => container) });
        if (op === 'docker.stopSet' || op === 'docker.retireSet') {
          const targets = params.targets as Array<{ id: string; name: string; deploymentId: number }>;
          for (const target of targets) {
            const index = containers.findIndex(container => container.id === target.id && container.name === target.name && container.deploymentId === target.deploymentId);
            if (index >= 0) {
              if (op === 'docker.retireSet') containers.splice(index, 1);
              else containers[index]!.running = false;
            }
          }
          return reply(op === 'docker.stopSet' ? 'ND-STOPPED-SET ' : 'ND-RETIRED-SET ', { requestId: params.requestId, serviceId: params.serviceId,
            revision: params.revision, complete: true, items: targets.map(target => ({ ...target, ...(op === 'docker.stopSet' ? { running: false } : { removed: true }) })) });
        }
        if (op === 'docker.lifecycle') {
          const targets = params.targets as Array<{ id: string; name: string }>;
          for (const target of targets) { const found = containers.find(container => container.id === target.id); if (found) found.running = params.action === 'start'; }
          return reply('ND-LIFECYCLE ', { requestId: params.requestId, serviceId: params.serviceId, deploymentId: params.deploymentId,
            revision: params.revision, action: params.action, complete: true,
            items: targets.map(target => ({ ...target, running: params.action === 'start' })) });
        }
        if (op === 'docker.lifecycleRetire') {
          const targets = params.targets as Array<{ id: string; name: string; deploymentId: number }>;
          retirementAttempts++;
          if (mode === 'failed-before-effect' && retirementAttempts === 1) throw new Error('Controlled retirement outage');
          for (const target of targets) {
            const index = containers.findIndex(container => container.id === target.id && container.name === target.name && container.deploymentId === target.deploymentId);
            if (index >= 0) containers.splice(index, 1);
          }
          if (mode === 'lost-reply' && retirementAttempts === 1) throw new Error('Controlled lost retirement reply');
          return reply('ND-LIFECYCLE-RETIRED ', { requestId: params.requestId, serviceId: params.serviceId, revision: params.revision,
            complete: true, items: targets.map((target, index) => ({ ...target,
              ...(mode === 'invalid-receipt' && retirementAttempts === 1 && index === 0 ? { id: 'e'.repeat(64) } : {}), removed: true })) });
        }
        throw new Error(`Unexpected operation ${op}`);
      },
    };
    const service = (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    const intent = await acceptNodeLifecycleIntent(c.db, service, 'stop');
    let result = await executeNodeLifecycleIntent(c.db, intent.id, deps);
    if (mode !== 'normal' && mode !== 'failed-preparation') {
      expect(result.state).toBe('held');
      expect((await c.db.query.nodeLifecycleIntents.findFirst())?.phase).toBe('applying');
      await c.db.update(nodeLifecycleIntents).set({ nextAttemptAt: new Date(0) }).where(eq(nodeLifecycleIntents.id, intent.id));
      result = await executeNodeLifecycleIntent(c.db, intent.id, deps);
    }
    expect(result.state, (await c.db.query.nodeLifecycleIntents.findFirst())?.reason ?? '').toBe('completed');
    expect(containers.filter(container => container.serviceId === 1 && container.running).map(container => container.name)).toEqual([]);
    expect(containers.filter(container => container.serviceId === 1).map(container => container.name)).toEqual(['web-9']);
    expect(containers.find(container => container.name === 'other-10')?.running).toBe(true);
  } finally { c.client?.close(); }
});
