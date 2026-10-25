import { z } from 'zod';

/** Public command state deliberately excludes execution tokens and Docker identities. */
export const serviceLifecycleCommand = z.object({
  id: z.number().int().positive(), action: z.enum(['start', 'stop', 'restart']),
  phase: z.enum(['fencing', 'preparing', 'routing', 'applying', 'readiness', 'starting', 'warming', 'publishing', 'completed', 'superseded']),
  reason: z.string().nullable(), attempts: z.number().int().nonnegative(),
  busy: z.boolean(), current: z.boolean(), retryable: z.boolean(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), nextAttemptAt: z.iso.datetime(),
}).strict();
export type ServiceLifecycleCommand = z.infer<typeof serviceLifecycleCommand>;
export const serviceLifecycleView = z.object({ command: serviceLifecycleCommand.nullable() }).strict();
export type ServiceLifecycleView = z.infer<typeof serviceLifecycleView>;
/** Local and older panels complete synchronously; ordered node commands acknowledge acceptance. */
export const serviceLifecycleResult = z.object({ ok: z.boolean(), status: z.string(), pending: z.literal(true).optional(),
  lifecycle: serviceLifecycleCommand.nullable().optional() });
export type ServiceLifecycleResult = z.infer<typeof serviceLifecycleResult>;
export const serviceLifecycleRetry = serviceLifecycleView.extend({ ok: z.literal(true), pending: z.literal(true) });
export type ServiceLifecycleRetry = z.infer<typeof serviceLifecycleRetry>;
