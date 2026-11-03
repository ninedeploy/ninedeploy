import { eq, nodeSleepTransitions, type DB, type Service } from '@ninedeploy/db';
import type { ServiceSleepStatus } from '@ninedeploy/schemas';
import type { createNodeIdleScheduler } from './nodeIdleScheduler.js';

type Observation = Pick<ReturnType<typeof createNodeIdleScheduler>, 'status'>;
const observers = new WeakMap<DB, Observation>();

/** Registration belongs to one panel DB/plugin lifetime, not another app in this process. */
export function registerNodeSleepObserver(db: DB, observer: Observation) {
  observers.set(db, observer);
  return () => { if (observers.get(db) === observer) observers.delete(db); };
}

export async function readServiceSleepStatus(db: DB, service: Service): Promise<ServiceSleepStatus> {
  const supported = service.type === 'docker' && service.orchestrator !== 'swarm';
  const placement = !supported ? 'unsupported' : service.serverId != null ? 'node' : 'panel';
  const configured = service.sleepAfterMinutes != null;
  const observer = placement === 'node' ? observers.get(db) : undefined;
  const base: ServiceSleepStatus = { placement, configured, nodeControllerActive: !!observer,
    phase: !supported ? 'unsupported' : configured ? 'observing' : 'disabled',
    idleMs: null, requiredMs: configured ? service.sleepAfterMinutes! * 60_000 : null, idleSatisfied: false,
    holding: !supported ? 'Scale to zero requires an ordinary Docker service' : null };
  if (!supported) return base;
  if (placement === 'node') {
    const row = await db.query.nodeSleepTransitions.findFirst({ where: eq(nodeSleepTransitions.serviceId, service.id) });
    if (row && row.serverId === service.serverId && row.runtimeId === service.runtimeId && !['completed', 'superseded'].includes(row.phase)) {
      return { ...base, idleMs: Number.isSafeInteger(row.idleEvidence?.idleMs) && row.idleEvidence.idleMs >= 0 ? row.idleEvidence.idleMs : null,
        phase: row.phase === 'asleep' ? 'asleep' : row.reason ? 'held' : row.action === 'wake' ? 'waking' : 'sleeping',
        holding: row.reason ? 'Node verification is pending; the original command is retained' : null };
    }
    if (row?.fallbackRouting && row.serverId === service.serverId && row.runtimeId === service.runtimeId && service.status !== 'stopped') {
      return { ...base, phase: 'waking', holding: 'Application readiness and routing are pending' };
    }
  }
  if (service.asleepAt != null && service.status === 'running') return { ...base, phase: 'asleep' };
  if (!configured) return base;
  if (service.status !== 'running' || !service.runtimeId || !service.port) return { ...base, phase: 'held', holding: 'The service is not running with a routable application port' };
  if (placement === 'node') {
    const status = observer?.status(service);
    return { ...base, idleMs: status?.idleMs ?? null, idleSatisfied: status?.idleSatisfied ?? false,
      holding: status ? status.holding?.slice(0, 512) ?? null : observer ? 'Waiting for verified node idle coverage' : 'Node sleep controller is not running' };
  }
  return { ...base, holding: 'Panel sleep uses traffic analytics to observe idle requests' };
}
