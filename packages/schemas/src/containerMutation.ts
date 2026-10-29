import { z } from 'zod';
import { utf8Length } from './serviceFiles.js';
const requestId = z.string().regex(/^[a-f0-9]{32}$/);
const positive = z.number().int().positive();
const name = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const target = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name, deploymentId: positive }).strict();
const distinct = (items: ReadonlyArray<{ id: string; name: string }>) => new Set(items.map(item => item.id)).size === items.length && new Set(items.map(item => item.name)).size === items.length;
export const runtimeFenceRequest = z.object({ requestId, serviceId: positive, revision: positive, timeoutMs: z.number().int().min(1).max(30_000), deploymentWatermark: positive.optional() }).strict();
export const runtimeFenceReply = runtimeFenceRequest.omit({ timeoutMs: true }).extend({ complete: z.literal(true) }).strict();
export const containerPrepareRequest = z.object({ requestId, serviceId: positive, deploymentId: positive, revision: positive,
  timeoutMs: z.number().int().min(1).max(300_000), startNames: z.array(name).max(10).refine(names => new Set(names).size === names.length, 'Duplicate serving name').optional(), specs: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
}).strict().superRefine((input, context) => {
  // Raw JSON stays under 1 MiB so its sealed envelope fits the 2 MiB agent route budget.
  try {
    if (utf8Length(JSON.stringify(input)) > 1_048_576) context.addIssue({ code: 'custom', path: ['specs'], message: 'Prepared container set exceeds the 1 MiB request limit' });
  } catch { context.addIssue({ code: 'custom', path: ['specs'], message: 'Preparation request must be JSON serializable' }); }
  const names = new Set<string>();
  for (const [index, spec] of input.specs.entries()) {
    if (!name.safeParse(spec.name).success || typeof spec.name !== 'string' || names.has(spec.name) ||
      spec.serviceId !== input.serviceId || spec.deploymentId !== input.deploymentId || spec.managed !== undefined && spec.managed !== 'service' ||
      typeof spec.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(spec.image)) {
      context.addIssue({ code: 'custom', path: ['specs', index], message: 'Prepare requires unique managed names, matching ownership and one immutable image' });
    }
    if (typeof spec.name === 'string') names.add(spec.name);
  }
  if (input.startNames?.some(item => !names.has(item))) context.addIssue({ code: 'custom', path: ['startNames'], message: 'Serving names must belong to the prepared set' });
  if (new Set(input.specs.map(spec => spec.image)).size !== 1) context.addIssue({ code: 'custom', path: ['specs'], message: 'Prepare one immutable image across the complete set' });
});
export const containerPrepareReply = z.object({ requestId, serviceId: positive, deploymentId: positive, revision: positive, complete: z.literal(true),
  items: z.array(target.extend({ running: z.boolean() })).min(1).max(10).refine(distinct, 'Duplicate creation receipt identity'),
}).strict();
export const containerRetireSetRequest = z.object({ requestId, serviceId: positive, revision: positive,
  timeoutMs: z.number().int().min(1).max(330_000), graceSeconds: z.number().int().min(0).max(300),
  targets: z.array(target).max(30).refine(distinct, 'Duplicate retirement target'),
}).strict();
export const containerRetireSetReply = containerRetireSetRequest.omit({ timeoutMs: true, graceSeconds: true, targets: true }).extend({ complete: z.literal(true),
  items: z.array(target.extend({ removed: z.literal(true) })).max(30).refine(distinct, 'Duplicate retirement receipt identity'),
}).strict();
export type RuntimeFenceRequest = z.infer<typeof runtimeFenceRequest>;
export type RuntimeFenceReply = z.infer<typeof runtimeFenceReply>;
export type ContainerPrepareRequest = z.infer<typeof containerPrepareRequest>;
export type ContainerPrepareReply = z.infer<typeof containerPrepareReply>;
export type ContainerRetireSetRequest = z.infer<typeof containerRetireSetRequest>;
export type ContainerRetireSetReply = z.infer<typeof containerRetireSetReply>;

export const containerNetworkSetRequest = z.object({ requestId, serviceId: positive, revision: positive,
  timeoutMs: z.number().int().min(1).max(60_000), action: z.enum(['connect', 'disconnect']),
  networks: z.array(name).min(1).max(32).refine(items => new Set(items).size === items.length, 'Duplicate network'),
  targets: z.array(target).min(1).max(30).refine(distinct, 'Duplicate network target'),
}).strict();
export const containerNetworkSetReply = containerNetworkSetRequest.omit({ timeoutMs: true, targets: true }).extend({ complete: z.literal(true),
  items: z.array(target.extend({ connected: z.boolean() })).min(1).max(30).refine(distinct, 'Duplicate network receipt identity'),
}).strict().refine(reply => reply.items.every(item => item.connected === (reply.action === 'connect')), 'Network receipt contradicts its action');
export type ContainerNetworkSetRequest = z.infer<typeof containerNetworkSetRequest>;
export type ContainerNetworkSetReply = z.infer<typeof containerNetworkSetReply>;

/** Discover every managed generation only under an acknowledged service fence. */
export const containerInventoryRequest = runtimeFenceRequest.extend({ expectedNames: z.array(name).max(30).refine(items => new Set(items).size === items.length, 'Duplicate expected name').optional() });
export const containerInventoryReply = runtimeFenceReply.extend({ items: z.array(target.extend({ running: z.boolean() })).max(30).refine(distinct, 'Duplicate inventory identity') });
export const containerStopSetRequest = containerRetireSetRequest;
export const containerStopSetReply = runtimeFenceReply.extend({ items: z.array(target.extend({ running: z.literal(false) })).max(30).refine(distinct, 'Duplicate Stop identity') });
export type ContainerInventoryReply = z.infer<typeof containerInventoryReply>;
export type ContainerStopSetReply = z.infer<typeof containerStopSetReply>;
