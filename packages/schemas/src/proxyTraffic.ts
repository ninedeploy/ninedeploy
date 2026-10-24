import { z } from 'zod';
import { id } from './common.js';
import { errorRatePercent } from './canary.js';

const opaque = z.string().regex(/^[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const COUNTER = /^[1-9][0-9]{0,19}$/;
const counter = z.string().regex(COUNTER).pipe(z.string().refine(value => BigInt(value) <= 18_446_744_073_709_551_615n, 'Request counter exceeds its supported range'));
const canaryReleaseStats = z.object({ requests: z.number().int().min(0).max(100_000), errors: z.number().int().min(0).max(100_000),
  errorRate: z.number().min(0).max(100).nullable(), p95Ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable() }).strict()
  .refine(v => v.errors <= v.requests && v.errorRate === errorRatePercent(v.errors, v.requests) && (v.requests === 0 ? v.p95Ms === null : v.p95Ms !== null), 'Invalid traffic statistics');
const target = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  id: hash, port: z.number().int().min(1).max(65535),
}).strict();

export const proxyTrafficOpen = z.object({
  requestId: opaque, nodeId: id, serviceId: id, deploymentId: id, step: z.number().int().min(1).max(5),
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/),
  durationMs: z.number().int().min(1000).max(3_600_000),
  routingConfig: z.string().min(1).max(1024 * 1024),
  stable: z.array(target).min(1).max(10), canary: z.array(target).min(1).max(10),
}).strict().superRefine((value, ctx) => {
  const all = [...value.stable, ...value.canary];
  if (new Set(all.map(t => t.id)).size !== all.length || new Set(all.map(t => t.name)).size !== all.length) {
    ctx.addIssue({ code: 'custom', message: 'Runtime generations must be distinct' });
  }
});
export type ProxyTrafficOpen = z.infer<typeof proxyTrafficOpen>;

export const proxyTrafficWindowId = z.object({ windowId: opaque }).strict();
export const proxyTrafficSample = z.object({ windowIds: z.array(opaque).min(1).max(16) }).strict();

const snapshotFields = z.object({
  protocol: z.literal(1), basis: z.literal('traefik-request-sequence'), precisionMs: z.literal(1),
  windowId: opaque, requestId: opaque, epoch: opaque, sourceId: hash, proxyId: hash, targetHash: hash, routingGeneration: hash,
  nodeId: id, serviceId: id, deploymentId: id, step: z.number().int().min(1).max(5),
  elapsedMs: z.number().int().min(0).max(3_630_000),
  startCounter: counter, endCounter: counter.nullable(), observed: z.number().int().min(0).max(100_000),
  expected: z.number().int().min(0).max(100_000).nullable(), complete: z.boolean(),
  canary: canaryReleaseStats, stable: canaryReleaseStats,
}).strict();
export const proxyTrafficSnapshot = snapshotFields.pipe(z.custom<z.infer<typeof snapshotFields>>().superRefine((value, ctx) => {
  const expected = value.endCounter === null ? null : BigInt(value.endCounter) - BigInt(value.startCounter) - 1n;
  if ((expected !== null && (expected < 0n || expected !== BigInt(value.expected ?? -1) || BigInt(value.observed) > expected)) ||
    (value.endCounter === null && value.expected !== null) ||
    value.canary.requests + value.stable.requests > value.observed ||
    (value.complete && (!value.endCounter || value.expected === null || value.expected !== value.observed))) {
    ctx.addIssue({ code: 'custom', message: 'Complete windows require contiguous sequence coverage' });
  }
}));
export type ProxyTrafficSnapshot = z.infer<typeof proxyTrafficSnapshot>;
