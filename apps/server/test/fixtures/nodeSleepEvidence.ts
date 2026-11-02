import { randomBytes } from 'node:crypto';
import type { DB } from '@ninedeploy/db';
import { idleWatchOpen, type IdleWatchOpen, type IdleWatchSnapshot } from '@ninedeploy/schemas';
import { NodeIdleCoverage } from '../../src/lib/nodeIdleCoverage.js';
import { nodeServingTrafficContext } from '../../src/lib/nodeServingTrafficContext.js';
import { proxyTrafficRoutingGeneration, proxyTrafficTargetHash } from '../../src/lib/proxyTrafficCounter.js';
import { renderDynamicConfig } from '../../src/engine/proxy.js';

/** Trusted agent-receipt fixture; no real elapsed-time or hosted acceptance claim. */
export async function nodeSleepEvidence(db: DB, durationMs = 300_000, binding: Partial<Pick<IdleWatchOpen, 'nodeId' | 'serviceId' | 'deploymentId' | 'slug' | 'serving'>> = {}) {
  const input = idleWatchOpen.parse({ purpose: 'idle', requestId: randomBytes(16).toString('hex'), nodeId: 4, serviceId: 1, deploymentId: 9,
    slug: 'web', durationMs, routingConfig: await renderDynamicConfig(db, { serverId: binding.nodeId ?? 4 }), serving: [{ name: 'web-9', id: 'a'.repeat(64), port: 3000 }], ...binding });
  const opened: IdleWatchSnapshot = { protocol: 1, purpose: 'idle', basis: 'traefik-request-sequence', precisionMs: 1,
    windowId: randomBytes(16).toString('hex'), requestId: input.requestId, epoch: 'd'.repeat(32), sourceId: 'e'.repeat(64), proxyId: 'f'.repeat(64),
    nodeId: input.nodeId, serviceId: input.serviceId, deploymentId: input.deploymentId, targetHash: proxyTrafficTargetHash(input), routingGeneration: proxyTrafficRoutingGeneration(input), elapsedMs: 0,
    startCounter: '10', endCounter: null, observed: 0, expected: null, complete: false, serving: { requests: 0, errors: 0, errorRate: null, p95Ms: null } };
  const clock = new NodeIdleCoverage();
  clock.complete({ input, opened, finished: { ...opened, elapsedMs: durationMs, endCounter: '11', expected: 0, complete: true },
    beforeOpen: 0, afterOpen: 0, context: await nodeServingTrafficContext(db, input) });
  return { clock, token: clock.takeEvidence()! };
}
