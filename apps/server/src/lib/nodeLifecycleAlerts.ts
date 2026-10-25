import { eq, services, type DB, type Service } from '@ninedeploy/db';
import { audit } from './audit.js';
import { publicNodeLifecycle } from './nodeLifecycleRuntime.js';
import { HttpError } from './errors.js';

const COOLDOWN_MS = 10 * 60_000;
const UNAVAILABLE_CODES = new Set(['node_transport_unsealed', 'node_unreachable', 'node_agent_outdated', 'node_feature_disabled', 'node_lifecycle_identity_unknown']);

/** One worker's alert throttle. A panel restart may re-alert a held command. */
export function createNodeRecoveryNotifier(db: DB, signal?: AbortSignal) {
  const recent = new Map<number, { identity: string; at: number }>();
  const publish = async (service: Service, identity: string, meta: Record<string, unknown>) => {
    if (signal?.aborted) return;
    const now = Date.now();
    for (const [id, entry] of recent) if (now - entry.at >= COOLDOWN_MS) recent.delete(id);
    if (recent.get(service.id)?.identity === identity) return;
    recent.set(service.id, { identity, at: now });
    // Error text stays in the command's protected status view. Notification
    // metadata carries only identity and phase, never agent output or secrets.
    await audit(db, null, 'alert.service_recovery_held', `${service.name} #${service.id}`, {
      serviceId: service.id, serverId: service.serverId, ...meta,
    });
  };
  return {
    held: async (serviceId: number, action: 'start' | 'stop' | 'restart', commandId: number): Promise<void> => {
      if (signal?.aborted) return;
      const service = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
      if (signal?.aborted || !service) return;
      const { command } = await publicNodeLifecycle(db, service);
      if (signal?.aborted || !command?.current || command.id !== commandId || command.action !== action || command.busy ||
        command.reason === null || command.phase === 'completed') return;
      await publish(service, `command:${commandId}`, { commandId, action, phase: command.phase });
    },
    unavailable: async (snapshot: Pick<Service, 'id' | 'runtimeId' | 'serverId'>, error: unknown): Promise<void> => {
      if (signal?.aborted || snapshot.serverId == null || !snapshot.runtimeId || !(error instanceof HttpError) || !UNAVAILABLE_CODES.has(error.code)) return;
      const service = await db.query.services.findFirst({ where: eq(services.id, snapshot.id) });
      if (signal?.aborted || !service || service.type !== 'docker' || service.orchestrator === 'swarm' || service.status !== 'running' ||
        service.runtimeId !== snapshot.runtimeId || service.serverId !== snapshot.serverId) return;
      const { command } = await publicNodeLifecycle(db, service);
      if (command?.current && command.phase !== 'completed') return;
      await publish(service, `unavailable:${service.runtimeId}:${service.serverId}:${error.code}`, { code: error.code });
    },
  };
}
