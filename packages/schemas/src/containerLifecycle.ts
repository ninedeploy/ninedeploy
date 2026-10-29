import { z } from 'zod';

const target = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  /** Explicit labels for an ordered Stop spanning retained generations. Never accepted for Start. */
  deploymentId: z.number().int().positive().optional() }).strict();
const boundedGenerations = (items: ReadonlyArray<{ deploymentId?: number }>) => {
  const explicit = items.filter(item => item.deploymentId !== undefined).length;
  return explicit === 0 ? items.length <= 10 : explicit === items.length;
};
export const containerLifecycleRequest = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  serviceId: z.number().int().positive(), deploymentId: z.number().int().positive(),
  revision: z.number().int().positive(), action: z.enum(['start', 'stop']),
  targets: z.array(target).max(30).refine(boundedGenerations, 'Use a complete explicit generation batch or at most ten legacy targets').refine(items => new Set(items.map(item => item.id)).size === items.length &&
    new Set(items.map(item => item.name)).size === items.length, 'Duplicate lifecycle target'),
  timeoutMs: z.number().int().min(1).max(30_000),
}).strict().refine(input => input.action === 'stop' || input.targets.length > 0 && input.targets.every(item => item.deploymentId === undefined),
  { message: 'Start requires one implicit generation; explicit generation batches are Stop only', path: ['targets'] });
export type ContainerLifecycleRequest = z.infer<typeof containerLifecycleRequest>;
export const containerLifecycleReply = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/),
  serviceId: z.number().int().positive(), deploymentId: z.number().int().positive(),
  revision: z.number().int().positive(), action: z.enum(['start', 'stop']), complete: z.literal(true),
  items: z.array(target.extend({ running: z.boolean() })).max(30).refine(boundedGenerations, 'Invalid lifecycle generation receipt batch'),
}).strict().refine(reply => reply.action === 'stop' || reply.items.length > 0 && reply.items.every(item => item.deploymentId === undefined),
  { message: 'Start requires one implicit generation receipt', path: ['items'] });
export type ContainerLifecycleReply = z.infer<typeof containerLifecycleReply>;

const retireTarget = target.extend({ deploymentId: z.number().int().positive() });
export const containerLifecycleRetireRequest = z.object({
  requestId: z.string().regex(/^[a-f0-9]{32}$/), serviceId: z.number().int().positive(), revision: z.number().int().positive(),
  targets: z.array(retireTarget).max(30).refine(items => new Set(items.map(item => item.id)).size === items.length &&
    new Set(items.map(item => item.name)).size === items.length, 'Duplicate retirement target'),
  timeoutMs: z.number().int().min(1).max(30_000),
}).strict();
export const containerLifecycleRetireReply = containerLifecycleRetireRequest.omit({ timeoutMs: true, targets: true }).extend({
  complete: z.literal(true), items: z.array(retireTarget.extend({ removed: z.literal(true) })).max(30)
    .refine(items => new Set(items.map(item => item.id)).size === items.length && new Set(items.map(item => item.name)).size === items.length, 'Duplicate retirement receipt'),
}).strict();
