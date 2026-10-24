import { describe, expect, it } from 'vitest';
import { proxyTrafficOpen, proxyTrafficSample, proxyTrafficSnapshot, proxyTrafficWindowId } from '../src/proxyTraffic.js';

const open = { requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4, step: 1, slug: 'web', durationMs: 1000, routingConfig: 'http: {}',
  stable: [{ name: 'old', id: 'a'.repeat(64), port: 80 }], canary: [{ name: 'new', id: 'b'.repeat(64), port: 80 }] };
const empty = { requests: 0, errors: 0, errorRate: null, p95Ms: null };
const snapshot = { protocol: 1, basis: 'traefik-request-sequence', precisionMs: 1, windowId: '2'.repeat(32), requestId: open.requestId,
  epoch: '3'.repeat(32), sourceId: 'c'.repeat(64), proxyId: 'd'.repeat(64), targetHash: 'e'.repeat(64), routingGeneration: 'f'.repeat(64), nodeId: 2, serviceId: 3,
  deploymentId: 4, step: 1, elapsedMs: 1000, startCounter: '10', endCounter: null, observed: 0, expected: null, complete: false,
  stable: empty, canary: empty };

describe('bounded node traffic protocol', () => {
  it('accepts distinct immutable runtime generations and bounded operation identities', () => {
    expect(proxyTrafficOpen.parse(open)).toEqual(open);
    expect(proxyTrafficWindowId.parse({ windowId: snapshot.windowId })).toEqual({ windowId: snapshot.windowId });
    expect(proxyTrafficSample.parse({ windowIds: [snapshot.windowId] }).windowIds).toEqual([snapshot.windowId]);
    expect(proxyTrafficSample.safeParse({ windowIds: [] }).success).toBe(false);
    expect(proxyTrafficSample.safeParse({ windowIds: Array(17).fill(snapshot.windowId) }).success).toBe(false);
    expect(proxyTrafficOpen.safeParse({ ...open, arbitraryCommand: 'echo private' }).success).toBe(false);
  });

  it('rejects both reused IDs and reused names across generations', () => {
    for (const canary of [[{ ...open.canary[0]!, id: open.stable[0]!.id }], [{ ...open.canary[0]!, name: open.stable[0]!.name }]]) {
      expect(proxyTrafficOpen.safeParse({ ...open, canary }).success).toBe(false);
    }
  });

  it('allows incomplete live receipts and complete contiguous empty or nonempty results', () => {
    expect(proxyTrafficSnapshot.parse(snapshot)).toEqual(snapshot);
    expect(proxyTrafficSnapshot.safeParse({ ...snapshot, endCounter: '11', expected: 0, complete: true }).success).toBe(true);
    expect(proxyTrafficSnapshot.safeParse({ ...snapshot, endCounter: '13', expected: 2, observed: 2, complete: true,
      canary: { requests: 2, errors: 1, errorRate: 50, p95Ms: 9 } }).success).toBe(true);
    expect(proxyTrafficSnapshot.safeParse({ ...snapshot, endCounter: '13', expected: 2, observed: 1 }).success).toBe(true);
    expect(proxyTrafficSnapshot.safeParse({ ...snapshot, startCounter: '18446744073709551615' }).success).toBe(true);
  });

  it.each(['private-counter', '0', '-1', '18446744073709551616'])('rejects unsafe counters without throwing: %s', startCounter => {
    expect(proxyTrafficSnapshot.safeParse({ ...snapshot, startCounter }).success).toBe(false);
  });

  it.each([
    { endCounter: '9', expected: 0 },
    { endCounter: '12', expected: null },
    { endCounter: '12', expected: 2 },
    { endCounter: '12', expected: 1, observed: 2 },
    { expected: 0 },
    { observed: 0, canary: { requests: 1, errors: 0, errorRate: 0, p95Ms: 0 } },
    { complete: true },
    { endCounter: '12', expected: 1, complete: true },
  ])('rejects contradictory coverage: %j', patch => {
    expect(proxyTrafficSnapshot.safeParse({ ...snapshot, ...patch }).success).toBe(false);
  });

  it.each([
    { requests: 0, errors: 1, errorRate: null, p95Ms: null },
    { requests: 2, errors: 1, errorRate: 0, p95Ms: 1 },
    { requests: 0, errors: 0, errorRate: null, p95Ms: 1 },
    { requests: 1, errors: 0, errorRate: 0, p95Ms: null },
  ])('rejects contradictory traffic statistics: %j', canary => {
    expect(proxyTrafficSnapshot.safeParse({ ...snapshot, observed: 2, canary }).success).toBe(false);
  });
});
