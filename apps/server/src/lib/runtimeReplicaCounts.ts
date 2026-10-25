import type { Service } from '@ninedeploy/db';
import { autoscaleConfig } from '@ninedeploy/schemas';
import { MAX_REPLICAS } from '../engine/dockerNames.js';

type Shape = Pick<Service, 'replicas'> & Partial<Pick<Service, 'runtimeReplicas' | 'autoscale'>>;
const bounded = (count: number | null | undefined) => Number.isFinite(count)
  ? Math.max(1, Math.min(MAX_REPLICAS, Math.floor(count!))) : 1;

/** Start serving members only; stop/delete also cover pre-created autoscale spares. */
export function runtimeReplicaCounts(service: Shape): { serving: number; capacity: number } {
  const config = autoscaleConfig.safeParse(service.autoscale);
  const serving = bounded(service.runtimeReplicas ?? service.replicas);
  return { serving, capacity: Math.max(serving, bounded(service.replicas), bounded(service.runtimeReplicas),
    config.success ? config.data.maxReplicas : 1) };
}
