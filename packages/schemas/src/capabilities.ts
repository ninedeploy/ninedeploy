import { z } from 'zod';

// ── Service capabilities (COMPETITIVE_ROADMAP_2026-11 C1) ──────────────────
// What a service can use, given where and how it runs. The server evaluates
// each feature with the same function its own route uses to refuse it, so
// the panel can disable a control before save instead of after, and the
// public support matrix (docs/SUPPORT_MATRIX.md) is generated from it.

export const SERVICE_CAPABILITY_IDS = [
  'maintenance',
  'errorPages',
  'forwardAuth',
  'restartLimit',
  'inlineDockerfile',
  'fileMounts',
  'autoscale',
  'scaleToZero',
  'canary',
] as const;
export const serviceCapabilityId = z.enum(SERVICE_CAPABILITY_IDS);
export type ServiceCapabilityId = z.infer<typeof serviceCapabilityId>;

/**
 * - `available`: works for this service.
 * - `limited`: can be saved, but works only partly here or is held at run time (the reason says how).
 * - `in_progress`: being built for this runtime; saved settings wait until it is accepted.
 * - `unavailable`: refused when saved, for the reason given.
 */
export const capabilityStatus = z.enum(['available', 'limited', 'in_progress', 'unavailable']);
export type CapabilityStatus = z.infer<typeof capabilityStatus>;

export const serviceCapability = z.object({
  status: capabilityStatus,
  /** Why it is not fully available; null when it is. */
  reason: z.string().nullable(),
});
export type ServiceCapability = z.infer<typeof serviceCapability>;

export const serviceCapabilitiesView = z.object({
  serviceId: z.number().int(),
  /** Where it runs, as the support matrix names it: panel-docker, node-docker, swarm-docker, panel-compose, … */
  runtime: z.string(),
  capabilities: z.record(serviceCapabilityId, serviceCapability),
});
export type ServiceCapabilitiesView = z.infer<typeof serviceCapabilitiesView>;
