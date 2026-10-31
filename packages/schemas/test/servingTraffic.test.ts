import { expect, it } from 'vitest';
import { servingTrafficOpen, servingTrafficSnapshot } from '../src/proxyTraffic.js';

const target = { name: 'web-4', id: 'a'.repeat(64), port: 8080 };
const open = { purpose: 'autoscale', requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4,
  slug: 'web', durationMs: 1000, routingConfig: 'http: {}', serving: [target] };
const snapshot = { protocol: 1, purpose: 'autoscale', basis: 'traefik-request-sequence', precisionMs: 1,
  requestId: open.requestId, windowId: '2'.repeat(32), epoch: '3'.repeat(32), sourceId: 'a'.repeat(64),
  proxyId: 'b'.repeat(64), targetHash: 'c'.repeat(64), routingGeneration: 'd'.repeat(64), nodeId: 2,
  serviceId: 3, deploymentId: 4, elapsedMs: 1000, startCounter: '10', endCounter: null, expected: null,
  observed: 0, complete: false, serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };

it('represents a single ordinary generation without a canary or step', () => {
  expect(servingTrafficOpen.parse(open)).toEqual(open);
  expect(servingTrafficOpen.safeParse({ ...open, serving: [target, { ...target, name: 'web-4-r2', id: 'b'.repeat(64) }] }).success).toBe(true);
});

it.each([
  { serving: [] }, { serving: Array(11).fill(target) },
  { serving: [target, { ...target, name: 'web-4-r2' }] },
  { serving: [target, { ...target, name: 'web-4-r3', id: 'b'.repeat(64) }] },
  { serving: [{ ...target, name: 'other-4' }] }, { deploymentId: 5 },
  { step: 1 }, { canary: [target] }, { purpose: 'canary' }, { durationMs: 60_001 },
])('rejects unsupported or ambiguous serving identity: %j', change => {
  expect(servingTrafficOpen.safeParse({ ...open, ...change }).success).toBe(false);
});

it('distinguishes incomplete, contiguous empty and attributed nonempty windows', () => {
  expect(servingTrafficSnapshot.parse(snapshot)).toEqual(snapshot);
  expect(servingTrafficSnapshot.safeParse({ ...snapshot, endCounter: '11', expected: 0, complete: true }).success).toBe(true);
  expect(servingTrafficSnapshot.safeParse({ ...snapshot, endCounter: '13', expected: 2, observed: 2, complete: true,
    serving: { requests: 1, errors: 0, errorRate: 0, p95Ms: 1 } }).success).toBe(true);
  expect(servingTrafficSnapshot.safeParse({ ...snapshot, endCounter: '13', expected: 2, observed: 1 }).success).toBe(true);
});

it.each([
  { endCounter: '9', expected: 0 }, { endCounter: '13', expected: 1 },
  { endCounter: '13', expected: null }, { endCounter: '12', expected: 1, observed: 2 },
  { expected: 0 }, { complete: true },
  { endCounter: '13', expected: 2, observed: 1, complete: true },
  { serving: { requests: 1, errors: 0, errorRate: 0, p95Ms: 1 } },
  { startCounter: 'invalid' }, { stable: snapshot.serving }, { step: 1 },
])('rejects invalid or incomplete coverage: %j', change => {
  expect(servingTrafficSnapshot.safeParse({ ...snapshot, ...change }).success).toBe(false);
});
