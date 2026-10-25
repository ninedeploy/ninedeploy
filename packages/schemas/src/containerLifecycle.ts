import { z } from 'zod';

const target = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/) }).strict();
export const containerLifecycleRequest = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  serviceId: z.number().int().positive(), deploymentId: z.number().int().positive(),
  revision: z.number().int().positive(), action: z.enum(['start', 'stop']),
  targets: z.array(target).min(1).max(10).refine(items => new Set(items.map(item => item.id)).size === items.length &&
    new Set(items.map(item => item.name)).size === items.length, 'Duplicate lifecycle target'),
  timeoutMs: z.number().int().min(1).max(30_000),
}).strict();
export type ContainerLifecycleRequest = z.infer<typeof containerLifecycleRequest>;
export const containerLifecycleReply = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  serviceId: z.number().int().positive(), deploymentId: z.number().int().positive(),
  revision: z.number().int().positive(), action: z.enum(['start', 'stop']), complete: z.literal(true),
  items: z.array(target.extend({ running: z.boolean() })).min(1).max(10),
}).strict();
export type ContainerLifecycleReply = z.infer<typeof containerLifecycleReply>;
