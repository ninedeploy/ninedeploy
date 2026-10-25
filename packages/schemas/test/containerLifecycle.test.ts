import { describe, expect, it } from 'vitest';
import { containerLifecycleReply, containerLifecycleRequest } from '../src/index.js';
const target = { id: 'a'.repeat(64), name: 'web-9' };
const input = { requestId: 'b'.repeat(32), serviceId: 7, deploymentId: 9, revision: 12, action: 'start', targets: [target], timeoutMs: 5000 };
describe('fenced container lifecycle protocol', () => {
  it('accepts only fixed effects on immutable identities and bound receipts', () => {
    expect(containerLifecycleRequest.parse(input)).toEqual(input);
    expect(containerLifecycleRequest.parse({ ...input, action: 'stop' }).action).toBe('stop');
    expect(containerLifecycleReply.parse({ requestId: input.requestId, serviceId: 7, deploymentId: 9, revision: 12, action: 'start', complete: true,
      items: [{ ...target, running: true }] }).items).toEqual([{ ...target, running: true }]);
  });
  it('permits a Stop fence before identity discovery while refusing an empty Start receipt', () => {
    expect(containerLifecycleRequest.parse({ ...input, action: 'stop', targets: [] }).targets).toEqual([]);
    const reply = { requestId: input.requestId, serviceId: 7, deploymentId: 9, revision: 12, action: 'stop', complete: true, items: [] };
    expect(containerLifecycleReply.parse(reply).items).toEqual([]);
    expect(containerLifecycleReply.safeParse({ ...reply, action: 'start' }).success).toBe(false);
  });
  it.each([
    { action: 'exec' }, { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { requestId: 'invalid' }, { serviceId: -1 }, { deploymentId: 0 }, { timeoutMs: 0 }, { timeoutMs: 30_001 },
    { targets: [] }, { targets: Array(11).fill(target) }, { targets: [target, target] },
    { targets: [target, { ...target, id: 'c'.repeat(64) }] }, { targets: [target, { ...target, name: 'other' }] },
    { targets: [{ ...target, id: 'abc' }] }, { targets: [{ ...target, name: '--all' }] }, { rawCommand: 'docker start anything' },
  ])('refuses ambiguous or unbounded lifecycle requests: %j', changed => {
    expect(containerLifecycleRequest.safeParse({ ...input, ...changed }).success).toBe(false);
  });
});
