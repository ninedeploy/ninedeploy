import { and, eq, notInArray, or, sql } from 'drizzle-orm';
import { nodeSleepTransitions, services } from '@ninedeploy/db';

/** Pending sleep/wake and a retained same-generation fallback forbid automatic resurrection. */
export function nodeSleepAutomationBlock(serviceId: number, selectedRuntime?: string | null) {
  const generation = selectedRuntime === undefined
    ? sql`(SELECT ${services.runtimeId} FROM ${services} WHERE ${services.id} = ${serviceId})`
    : selectedRuntime ?? '';
  return and(eq(nodeSleepTransitions.serviceId, serviceId), or(
    notInArray(nodeSleepTransitions.phase, ['completed', 'superseded']),
    and(eq(nodeSleepTransitions.fallbackRouting, true), eq(nodeSleepTransitions.runtimeId, generation)),
  ));
}
