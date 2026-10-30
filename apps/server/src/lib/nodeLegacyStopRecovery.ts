import { and, desc, eq, nodeLifecycleIntents, serviceTargets, services, type DB, type Service } from '@ninedeploy/db';
import { z } from 'zod';
import { nodeLifecycleWireRevision } from './nodeLifecycleIntent.js';
import { agentVersionAtLeast, capabilityRefusal, parseAgentCapabilities } from './agentCapabilities.js';

type RecoveryDeps = {
  check: () => Promise<void>;
  sealed: (serverId: number) => Promise<boolean>;
  agent: (serverId: number, op: string, params: Record<string, unknown>) => Promise<{ exitCode: number; lines: string[] }>;
};
const confirmation = z.object({ requestId: z.string(), serviceId: z.number(), revision: z.number(), deploymentWatermark: z.number(), complete: z.literal(true) }).strict();

/** Recover an initial Stop completed by an older panel before a successor creates containers. */
export async function recoverCompletedInitialStop(db: DB, service: Service, deps: RecoveryDeps): Promise<void> {
  if (service.type !== 'docker' || service.orchestrator === 'swarm' || service.runtimeId !== null || service.serverId === null) return;
  await deps.check();
  const command = await db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.serviceId, service.id), orderBy: desc(nodeLifecycleIntents.id) });
  if (!command || command.phase !== 'completed' || command.action !== 'stop' || command.runtimeId !== null || !command.snapshot.unselected) return;
  const watermark = command.snapshot.creationFenceDeploymentId;
  if (!Number.isSafeInteger(watermark) || watermark! < 1 || command.serverId !== service.serverId || command.targets === null ||
    command.targets.some(target => !Number.isSafeInteger(target.deploymentId) || target.deploymentId! > watermark!)) throw new Error('Completed initial Stop evidence is unconfirmed');
  const accepted = [command.serverId, ...(command.snapshot.fanout ?? []).map(target => target.serverId)];
  const nodes = command.snapshot.unselected.participants;
  if (!Array.isArray(nodes) || nodes.length !== accepted.length || new Set(accepted).size !== accepted.length ||
    new Set(nodes.map(node => node.serverId)).size !== nodes.length || nodes.some(node => !accepted.includes(node.serverId))) throw new Error('Completed initial Stop placement is unconfirmed');
  const checkpoint = async () => {
    await deps.check();
    const current = await db.query.services.findFirst({ where: and(eq(services.id, service.id), eq(services.serverId, command.serverId)) });
    const fanout = await db.select({ targetId: serviceTargets.id, serverId: serviceTargets.serverId, runtimeId: serviceTargets.runtimeId })
      .from(serviceTargets).where(eq(serviceTargets.serviceId, service.id)).orderBy(serviceTargets.id);
    const latest = await db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.serviceId, service.id), orderBy: desc(nodeLifecycleIntents.id) });
    await deps.check();
    if (!current || current.type !== 'docker' || current.orchestrator === 'swarm' || current.runtimeId !== null ||
      JSON.stringify(fanout) !== JSON.stringify(command.snapshot.fanout ?? []) || latest?.id !== command.id || latest.phase !== 'completed' ||
      latest.requestId !== command.requestId || latest.serverId !== command.serverId || latest.action !== 'stop' || latest.runtimeId !== null ||
      JSON.stringify(latest.snapshot) !== JSON.stringify(command.snapshot) || JSON.stringify(latest.targets) !== JSON.stringify(command.targets)) {
      throw new Error('Completed initial Stop placement changed');
    }
  };
  await checkpoint();
  for (const serverId of accepted) {
    await checkpoint();
    if (!await deps.sealed(serverId)) throw new Error('Completed initial Stop requires a sealed node connection');
    await checkpoint();
    let ping: { exitCode: number; lines: string[] } | undefined;
    const refusal = await capabilityRefusal(async (op, params) => {
      await checkpoint();
      const result = await deps.agent(serverId, op, params);
      await checkpoint();
      if (op === 'agent.ping') ping = result;
      return result;
    }, `#${serverId}`, true, { cap: 'docker.mutations', feature: 'recover an initial Stop', sealedRequired: true });
    if (refusal) throw new Error(refusal.message);
    if (!ping || ping.exitCode !== 0 || !agentVersionAtLeast(parseAgentCapabilities(ping.lines).version, '0.18.11')) {
      throw new Error(`Update the agent on node #${serverId} to 0.18.11 or newer to recover its initial Stop`);
    }
  }
  for (const serverId of accepted) {
    await checkpoint();
    const input = { requestId: command.requestId, serviceId: command.serviceId, revision: nodeLifecycleWireRevision(command, 'effect'), deploymentWatermark: watermark!, timeoutMs: 30_000 };
    const result = await deps.agent(serverId, 'docker.runtimeLegacyHandoff', input);
    await checkpoint();
    const frames = result.lines.filter(line => line.startsWith('ND-RUNTIME-LEGACY '));
    if (result.exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 16_384) throw new Error('Completed initial Stop handoff receipt unavailable');
    const reply = confirmation.parse(JSON.parse(frames[0]!.slice('ND-RUNTIME-LEGACY '.length)));
    if (reply.requestId !== input.requestId || reply.serviceId !== input.serviceId || reply.revision !== input.revision || reply.deploymentWatermark !== input.deploymentWatermark) {
      throw new Error('Completed initial Stop handoff ownership changed');
    }
  }
}
