import { z } from 'zod';

/** Public observation state; never contains wake credentials or execution authority. */
export const serviceSleepStatus = z.object({
  placement: z.enum(['panel', 'node', 'unsupported']),
  phase: z.enum(['disabled', 'unsupported', 'observing', 'sleeping', 'asleep', 'waking', 'held']),
  configured: z.boolean(), nodeControllerActive: z.boolean(),
  idleMs: z.number().int().nonnegative().nullable(), requiredMs: z.number().int().positive().nullable(),
  idleSatisfied: z.boolean(), holding: z.string().max(512).nullable(),
}).strict();
export type ServiceSleepStatus = z.infer<typeof serviceSleepStatus>;
