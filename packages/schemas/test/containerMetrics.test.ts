import { describe, expect, it } from 'vitest';
import { containerMetricsReply, containerMetricsRequest } from '../src/index.js';

const target = { id: 'a'.repeat(64), name: 'web-9' };
const request = { requestId: 'b'.repeat(32), serviceId: 7, deploymentId: 9, targets: [target], timeoutMs: 5000 };
const item = { ...target, cpuPct: 150.5, cpuLimitMilli: 1500, memBytes: 100, memLimitBytes: 1000, restarts: 0 };
const reply = { requestId: request.requestId, serviceId: 7, deploymentId: 9, complete: true, items: [item] };

describe('generation-bound container metric protocol', () => {
  it('accepts immutable identities, multi-core CPU and explicit unlimited resources', () => {
    expect(containerMetricsRequest.parse(request)).toEqual(request);
    expect(containerMetricsReply.parse(reply)).toEqual(reply);
    expect(containerMetricsReply.parse({ ...reply, items: [{ ...item, memLimitBytes: 0, cpuLimitMilli: 0 }] }).items[0]!.memLimitBytes).toBe(0);
  });
  it.each([
    { targets: [] }, { targets: Array(11).fill(target) }, { targets: [target, target] },
    { targets: [target, { ...target, id: 'c'.repeat(64) }] },
    { targets: [target, { ...target, name: 'other' }] },
    { targets: [{ ...target, id: 'abc123' }] }, { targets: [{ ...target, name: '--all' }] },
    { requestId: 'not-a-receipt' }, { serviceId: 0 }, { deploymentId: -1 },
    { timeoutMs: 0 }, { timeoutMs: 10_001 }, { timeoutMs: 2.5 }, { unexpected: true },
  ])('refuses invalid or ambiguous sampling requests: %j', changed => {
    expect(containerMetricsRequest.safeParse({ ...request, ...changed }).success).toBe(false);
  });
  it.each([
    { cpuPct: NaN }, { cpuPct: Infinity }, { cpuPct: -1 }, { cpuLimitMilli: -1 },
    { memBytes: -1 }, { memBytes: 1.5 }, { memLimitBytes: Number.MAX_SAFE_INTEGER + 1 },
    { restarts: -1 }, { restarts: 0.5 }, { extra: true },
  ])('refuses invalid resource evidence: %j', changed => {
    expect(containerMetricsReply.safeParse({ ...reply, items: [{ ...item, ...changed }] }).success).toBe(false);
  });
});
