import { expect, it } from 'vitest';
import { idleWatchOpen, type IdleWatchSnapshot } from '@ninedeploy/schemas';
import { NodeIdleCoverage, spendNodeIdleEvidence, type CompletedIdleWindow } from '../../src/lib/nodeIdleCoverage.js';
import { proxyTrafficRoutingGeneration, proxyTrafficTargetHash } from '../../src/lib/proxyTrafficCounter.js';

function window(nonce = 1, start = '10', end = '20', beforeOpen = 0, context = 'runtime-owner-and-config'): CompletedIdleWindow {
  const input = idleWatchOpen.parse({ purpose: 'idle', requestId: nonce.toString(16).padStart(32, '0'), nodeId: 4, serviceId: 1, deploymentId: 9,
    slug: 'web', durationMs: 60_000, routingConfig: 'http: {}', serving: [{ name: 'web-9', id: 'a'.repeat(64), port: 3000 }] });
  const opened: IdleWatchSnapshot = { protocol: 1, purpose: 'idle', basis: 'traefik-request-sequence', precisionMs: 1,
    windowId: nonce.toString(16).padStart(32, '0'), requestId: input.requestId, epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64),
    nodeId: 4, serviceId: 1, deploymentId: 9, targetHash: proxyTrafficTargetHash(input), routingGeneration: proxyTrafficRoutingGeneration(input), elapsedMs: 0,
    startCounter: start, endCounter: null, observed: 0, expected: null, complete: false, serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };
  const observed = Number(BigInt(end) - BigInt(start) - 1n);
  return { input, opened, finished: { ...opened, elapsedMs: 60_000, endCounter: end, observed, expected: observed, complete: true }, beforeOpen, afterOpen: beforeOpen + 500, context };
}
function rebind(w: CompletedIdleWindow) {
  w.opened.targetHash = w.finished.targetHash = proxyTrafficTargetHash(w.input);
  w.opened.routingGeneration = w.finished.routingGeneration = proxyTrafficRoutingGeneration(w.input);
}
it('uses a fully completed zero, excluding unrelated global request counts', () => {
  expect(new NodeIdleCoverage().complete(window())).toEqual({ idleMs: 60_000, chained: false, reason: null });
});
it('chains overlapping counters without double-counting overlap or opening latency', () => {
  const clock = new NodeIdleCoverage(); clock.complete(window());
  expect(clock.complete(window(2, '19', '30', 50_000))).toMatchObject({ idleMs: 109_500, chained: true });
  expect(clock.complete(window(3, '29', '40', 100_000))).toMatchObject({ idleMs: 159_500, chained: true });
});
it.each(['20', '21'])('starts again if chained markers do not overlap (%s)', start => {
  const clock = new NodeIdleCoverage(); clock.complete(window());
  expect(clock.complete(window(2, start, '30', 60_000))).toMatchObject({ idleMs: 60_000, chained: false, reason: expect.stringMatching(/restarted/) });
});
it.each(['sourceId', 'proxyId', 'epoch'] as const)('starts again when %s changes', key => {
  const clock = new NodeIdleCoverage(); clock.complete(window()); const next = window(2, '19', '30', 50_000);
  next.opened[key] = next.finished[key] = '0'.repeat(key === 'epoch' ? 32 : 64);
  expect(clock.complete(next)).toMatchObject({ idleMs: 60_000, chained: false });
});
it('starts again on changed owner/configuration, route or immutable serving IDs', () => {
  for (const change of ['context', 'route', 'id']) {
    const clock = new NodeIdleCoverage(); clock.complete(window()); const next = window(2, '19', '30', 50_000);
    if (change === 'context') next.context = 'new owner';
    if (change === 'route') next.input.routingConfig = 'http: { routers: {} }';
    if (change === 'id') next.input.serving[0]!.id = 'b'.repeat(64);
    rebind(next); expect(clock.complete(next)).toMatchObject({ idleMs: 60_000, chained: false });
  }
});
it('requires a new full zero interval after any serving traffic', () => {
  const clock = new NodeIdleCoverage(); clock.complete(window()); const busy = window(2, '19', '30', 50_000);
  busy.finished.serving = { requests: 1, errors: 0, errorRate: 0, p95Ms: 3 };
  expect(clock.complete(busy)).toMatchObject({ idleMs: 0, reason: expect.stringMatching(/traffic/) });
  expect(clock.complete(window(3, '29', '40', 100_000))).toMatchObject({ idleMs: 60_000, chained: false });
});
it('refuses a repeated or superseded receipt and drops previous coverage', () => {
  const clock = new NodeIdleCoverage(), first = window(); clock.complete(first);
  expect(() => clock.complete(first)).toThrow(/repeated/);
  expect(clock.complete(window(2, '19', '30', 50_000))).toMatchObject({ idleMs: 60_000, chained: false });
});
it('does not stitch reversed monotonic panel time', () => {
  const clock = new NodeIdleCoverage(); clock.complete(window(1, '10', '20', 10_000));
  expect(() => clock.complete(window(2, '19', '30', 9000))).toThrow(/regressed/);
});
it.each(['incomplete', 'short', 'unbound', 'cached-opening', 'regressed-count', 'different-final-source'] as const)('refuses %s evidence and resets coverage', kind => {
  const clock = new NodeIdleCoverage(); clock.complete(window()); const next = window(2, '19', '30', 50_000);
  if (kind === 'incomplete') { next.finished.complete = false; next.finished.endCounter = null; next.finished.expected = null; }
  if (kind === 'short') next.finished.elapsedMs = 59_999;
  if (kind === 'unbound') next.finished.requestId = '0'.repeat(32);
  if (kind === 'cached-opening') next.opened.elapsedMs = 501;
  if (kind === 'regressed-count') next.opened.observed = next.finished.observed + 1;
  if (kind === 'different-final-source') next.finished.sourceId = '0'.repeat(64);
  expect(() => clock.complete(next)).toThrow();
  expect(clock.complete(window(3, '29', '40', 100_000))).toMatchObject({ idleMs: 60_000, chained: false });
});
it('keeps uint64 overlap comparisons exact', () => {
  const clock = new NodeIdleCoverage(); clock.complete(window(1, '18446744073709551600', '18446744073709551610'));
  expect(clock.complete(window(2, '18446744073709551609', '18446744073709551615', 50_000))).toMatchObject({ idleMs: 109_500, chained: true });
});
it('reset discards coverage after a lease or panel lifecycle loss', () => {
  const clock = new NodeIdleCoverage(); clock.complete(window()); clock.reset();
  expect(clock.complete(window(2, '19', '30', 50_000))).toMatchObject({ idleMs: 60_000, chained: false });
});
it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1])('refuses invalid panel clock bounds: %s', value => {
  const invalid = window(); invalid.beforeOpen = invalid.afterOpen = value;
  expect(() => new NodeIdleCoverage().complete(invalid)).toThrow(/timing/);
});
it('issues opaque evidence once per completed window and consumes it only once', () => {
  const clock = new NodeIdleCoverage(); clock.complete(window());
  const token = clock.takeEvidence()!; expect(token).not.toBeNull(); expect(Object.isFrozen(token)).toBe(true);
  expect(clock.takeEvidence()).toBeNull(); expect(spendNodeIdleEvidence(token)).toMatchObject({ idleMs: 60_000 });
  expect(spendNodeIdleEvidence(token)).toBeNull();
});
it.each(['monotonic', 'wall', 'reset', 'source', 'traffic'])('revokes evidence after %s changes or expiry', kind => {
  let mono = 1000, wall = 100_000;
  const clock = new NodeIdleCoverage(() => mono, () => wall); clock.complete(window()); const token = clock.takeEvidence()!;
  if (kind === 'monotonic') mono += 30_000;
  if (kind === 'wall') wall += 30_000;
  if (kind === 'reset') clock.reset();
  if (kind === 'source') { const next = window(2, '19', '30', 50_000); next.opened.sourceId = next.finished.sourceId = '0'.repeat(64); clock.complete(next); }
  if (kind === 'traffic') { const next = window(2, '19', '30', 50_000); next.finished.serving = { requests: 1, errors: 0, errorRate: 0, p95Ms: 1 }; clock.complete(next); }
  expect(spendNodeIdleEvidence(token)).toBeNull();
});
