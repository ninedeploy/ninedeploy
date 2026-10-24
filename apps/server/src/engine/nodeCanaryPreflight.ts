import { and, eq } from 'drizzle-orm';
import { domains, type DB, type Service } from '@ninedeploy/db';
import { canaryConfig } from '@ninedeploy/schemas';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { capabilityRefusal } from '../lib/agentCapabilities.js';
import { autoHostFor } from '../lib/autoUrl.js';

/** Validate an explicitly requested node canary before build/run can replace any runtime. */
export async function preflightNodeCanary(db: DB, service: Service, rollback: boolean, checkpoint: () => Promise<void>): Promise<void> {
  if (service.serverId == null || service.canary == null || rollback) return;
  await checkpoint();
  const parsed = canaryConfig.safeParse(service.canary);
  if (!parsed.success) throw new Error('Node canary settings are invalid; save them again under Service → Settings.');
  if (service.type !== 'docker' || service.orchestrator === 'swarm') throw new Error('Node canary requires a plain Docker service.');
  if ((service.replicas ?? 1) !== 1 || (service.runtimeReplicas ?? 1) > 1) throw new Error('Node canary currently requires one replica; set replicas to 1 or disable canary releases.');
  if (service.publishedPort != null || (service.portMappings ?? []).length) throw new Error('Node canary requires domain routing without published host ports or port mappings.');
  if (service.healthCheck !== 'http-strict') throw new Error('Node canary requires explicit HTTP readiness; choose HTTP readiness under Service → Settings.');
  const active = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.serviceId, service.id), eq(domains.status, 'active'))).limit(1);
  if (!active.length && !await autoHostFor(db, service)) throw new Error('Node canary requires an active domain or a configured automatic URL.');
  const refusal = await capabilityRefusal((op, params, sink) => agentOp(db, service.serverId!, op, params, sink, { timeoutMs: 5000 }), `#${service.serverId}`,
    await agentTransportSealed(db, service.serverId), { cap: ['proxy.traffic', 'proxy.routingAck', 'docker.recovery', 'docker.probe', 'docker.readiness'],
      feature: 'deploy node canary releases', sealedRequired: true });
  if (refusal) throw new Error(refusal.message);
  await checkpoint();
}
