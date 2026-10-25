import { z } from 'zod';

const target = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
}).strict();
export const containerMetricsRequest = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  serviceId: z.number().int().positive(),
  deploymentId: z.number().int().positive(),
  targets: z.array(target).min(1).max(10).refine(items => new Set(items.map(i => i.id)).size === items.length && new Set(items.map(i => i.name)).size === items.length, 'Duplicate metric target'),
  timeoutMs: z.number().int().min(1).max(10_000),
}).strict();
export type ContainerMetricsRequest = z.infer<typeof containerMetricsRequest>;
export const containerMetricsReply = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  serviceId: z.number().int().positive(),
  deploymentId: z.number().int().positive(),
  complete: z.boolean(),
  items: z.array(target.extend({
    cpuPct: z.number().finite().nonnegative(),
    cpuLimitMilli: z.number().finite().nonnegative(),
    memBytes: z.number().int().nonnegative().safe(),
    memLimitBytes: z.number().int().nonnegative().safe(),
    restarts: z.number().int().nonnegative(),
  })).min(1).max(10),
}).strict();
export type ContainerMetricsReply = z.infer<typeof containerMetricsReply>;
