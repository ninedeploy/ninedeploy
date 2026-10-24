import { z } from 'zod';

const identity = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
}).strict();
export const containerReadinessRequest = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  targets: z.array(identity).min(1).max(10).refine(items => new Set(items.map(i => i.id)).size === items.length && new Set(items.map(i => i.name)).size === items.length, 'Duplicate readiness target'),
  mode: z.enum(['auto', 'running', 'command', 'http-strict', 'tcp']),
  port: z.number().int().min(1).max(65535).nullable(),
  path: z.string().max(2048).refine(path => path.startsWith('/') && !path.includes('\\') && [...path].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127), 'Invalid readiness path'),
  timeoutMs: z.number().int().min(1).max(10_000),
}).strict().refine(value => !['http-strict', 'tcp'].includes(value.mode) || value.port !== null, 'Application readiness needs a port');
export type ContainerReadinessRequest = z.infer<typeof containerReadinessRequest>;

export const containerReadinessReply = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  complete: z.boolean(),
  items: z.array(identity.extend({
    status: z.string().max(32), health: z.string().max(32),
    restarts: z.number().int().nonnegative(), failingStreak: z.number().int().nonnegative(), ready: z.boolean(),
  })).min(1).max(10),
}).strict();
export type ContainerReadinessReply = z.infer<typeof containerReadinessReply>;
