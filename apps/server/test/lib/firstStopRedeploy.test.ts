import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDb, runMigrations, services, servers, users, deployments, nodeLifecycleIntents, eq } from '@ninedeploy/db';
import { runOp } from '../../src/agent.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent } from '../../src/lib/nodeLifecycleController.js';
import { claimNodeDeploymentAttempt, createNodeDeploymentAuthority } from '../../src/lib/nodeDeploymentOwner.js';
import { recoverCompletedInitialStop } from '../../src/lib/nodeLegacyStopRecovery.js';

const docker = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: docker }));

it.each(['normal', 'lost-handoff-reply', 'wrong-fence-watermark', 'old-panel'] as const)('stops an initial deployment and fences old work before a later deployment: %s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'nd-first-stop-flow-'));
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  const c = createDb({ url: 'file::memory:' });
  docker.mockReset().mockImplementation(async (_bin, args: string[], sink: (line: string) => void) => {
    if (args[0] === 'inspect') { sink(`Error: No such container: ${args.at(-1)}`); return 1; }
    return 0;
  });
  try {
    await c.ready; await runMigrations(c.db);
    await c.db.insert(users).values({ id: 1, email: 'first-stop@example.test', passwordHash: 'fixture', isInstanceOperator: true });
    await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
    await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', type: 'docker', ownerUserId: 1, serverId: 4, runtimeId: null, status: 'deploying', port: 3000 });
    await c.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'deploying' });
    const service = (await c.db.query.services.findFirst())!;
    const intent = await acceptNodeLifecycleIntent(c.db, service, 'stop');
    let handoffAttempts = 0, fenceAttempts = 0;
    const deps = {
      sealed: async () => true, route: async () => {}, sleep: async () => {},
      agent: async (_server: number, op: string, params: Record<string, unknown>) => {
        if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version: '0.18.11', caps: ['docker.mutations', 'proxy.routingAck'] })] };
        if (op === 'docker.runtimeLegacyHandoff' && mode === 'old-panel') return { exitCode: 0, lines: ['ND-RUNTIME-LEGACY ' + JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, deploymentWatermark: params.deploymentWatermark, complete: true })] };
        const lines: string[] = [];
        const exitCode = await runOp(op, params, line => lines.push(line), { sealed: true });
        if (op === 'docker.runtimeFence' && ++fenceAttempts === 1 && mode === 'wrong-fence-watermark') {
          const frame = JSON.parse(lines[0]!.slice('ND-RUNTIME-FENCE '.length));
          lines[0] = 'ND-RUNTIME-FENCE ' + JSON.stringify({ ...frame, deploymentWatermark: 1 });
        }
        if (op === 'docker.runtimeLegacyHandoff' && ++handoffAttempts === 1 && mode === 'lost-handoff-reply') throw new Error('lost handoff reply');
        return { exitCode, lines };
      },
    };
    let outcome = await executeNodeLifecycleIntent(c.db, intent.id, deps);
    if (mode === 'lost-handoff-reply' || mode === 'wrong-fence-watermark') {
      expect(outcome.state).toBe('held');
      await c.db.update(nodeLifecycleIntents).set({ nextAttemptAt: new Date(0) }).where(eq(nodeLifecycleIntents.id, intent.id));
      outcome = await executeNodeLifecycleIntent(c.db, intent.id, deps);
    }
    expect(outcome.state, (await c.db.query.nodeLifecycleIntents.findFirst())?.reason ?? '').toBe('completed');
    await c.db.insert(deployments).values({ id: 11, serviceId: 1, status: 'queued' });
    const fresh = (await c.db.query.services.findFirst())!;
    const admission = await claimNodeDeploymentAttempt(c.db, 11, fresh, '{}');
    expect(admission.claimed).toBe(true);
    if (!admission.claimed) throw new Error('Missing deployment authority');
    const authority = createNodeDeploymentAuthority(c.db, admission.owner);
    await recoverCompletedInitialStop(c.db, fresh, {
      check: () => authority.check(), sealed: async () => true,
      agent: async (_server, op, params) => {
        const lines: string[] = [];
        return { exitCode: await runOp(op, params, line => lines.push(line), { sealed: true }), lines };
      },
    });
    docker.mockClear();
    const later = { name: 'web-11', image: 'sha256:' + 'f'.repeat(64), serviceId: 1, deploymentId: 11 };
    await expect(runOp('docker.runSpec', { ...later, name: 'web-10', deploymentId: 10 }, () => {}, { sealed: true })).rejects.toThrow(/stale|fenced/);
    await expect(runOp('docker.runSpec', later, () => {}, { sealed: true })).resolves.toBe(0);
    expect(docker).toHaveBeenCalled();
    if (mode === 'normal') {
      const nextStop = await acceptNodeLifecycleIntent(c.db, (await c.db.query.services.findFirst())!, 'stop');
      const nextResult = await executeNodeLifecycleIntent(c.db, nextStop.id, deps);
      expect(nextResult.state, (await c.db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.id, nextStop.id) }))?.reason ?? '').toBe('completed');
    }
  } finally {
    c.client?.close(); cwd.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
});
