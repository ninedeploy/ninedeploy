import { describe, expect, it } from 'vitest';
import { containerLifecycleReply, containerLifecycleRequest, containerLifecycleRetireReply, containerLifecycleRetireRequest } from '../src/index.js';
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

describe('retirement bound to a stopped generation', () => {
  const candidate = { ...target, deploymentId: 9 };
  const request = { requestId: input.requestId, serviceId: 7, revision: 12, targets: [candidate], timeoutMs: 5000 };
  const receipt = { requestId: input.requestId, serviceId: 7, revision: 12, complete: true, items: [{ ...candidate, removed: true }] };
  it('accepts immutable identity requests and receipts', () => {
    expect(containerLifecycleRetireRequest.parse(request)).toEqual(request);
    expect(containerLifecycleRetireReply.parse(receipt)).toEqual(receipt);
  });
  it.each([{ targets: [candidate, candidate] }, { targets: [{ ...candidate, deploymentId: undefined }] },
    { targets: [{ ...candidate, id: 'short' }] }, { timeoutMs: 30_001 }, { action: 'start' }])('refuses invalid requests: %j', changed => {
    expect(containerLifecycleRetireRequest.safeParse({ ...request, ...changed }).success).toBe(false);
  });
  it('rejects duplicate or unconfirmed retirement receipts', () => {
    expect(containerLifecycleRetireReply.safeParse({ ...receipt, items: [receipt.items[0], receipt.items[0]] }).success).toBe(false);
    expect(containerLifecycleRetireReply.safeParse({ ...receipt, items: [{ ...candidate, removed: false }] }).success).toBe(false);
  });
});


describe('explicit generation Stop batches', () => {
  const old = { ...target, deploymentId: 9 };
  const candidate = { id: 'c'.repeat(64), name: 'web-10', deploymentId: 10 };
  const stop = { ...input, action: 'stop', targets: [old, candidate] };
  const receipt = { requestId: input.requestId, serviceId: 7, deploymentId: 9, revision: 12, action: 'stop', complete: true,
    items: [old, candidate].map(item => ({ ...item, running: false })) };
  it('binds every target and receipt to its own deployment without widening Start', () => {
    expect(containerLifecycleRequest.parse(stop)).toEqual(stop);
    expect(containerLifecycleReply.parse(receipt)).toEqual(receipt);
    expect(containerLifecycleRequest.safeParse({ ...stop, action: 'start' }).success).toBe(false);
    expect(containerLifecycleReply.safeParse({ ...receipt, action: 'start' }).success).toBe(false);
  });
  it('keeps the legacy limit while bounding explicit Stop batches at thirty immutable targets', () => {
    const batch = Array.from({ length: 30 }, (_, n) => ({ id: (n + 1).toString(16).padStart(64, '0'), name: 'web-' + (n + 1), deploymentId: n + 1 }));
    expect(containerLifecycleRequest.parse({ ...stop, targets: batch }).targets).toHaveLength(30);
    expect(containerLifecycleReply.parse({ ...receipt, items: batch.map(item => ({ ...item, running: false })) }).items).toHaveLength(30);
    const tooMany = [...batch, { id: 'f'.repeat(64), name: 'overflow', deploymentId: 31 }];
    expect(containerLifecycleRequest.safeParse({ ...stop, targets: tooMany }).success).toBe(false);
    expect(containerLifecycleReply.safeParse({ ...receipt, items: tooMany.map(item => ({ ...item, running: false })) }).success).toBe(false);
    const legacy = batch.slice(0, 11).map(({ id, name }) => ({ id, name }));
    expect(containerLifecycleRequest.safeParse({ ...stop, targets: legacy }).success).toBe(false);
    expect(containerLifecycleReply.safeParse({ ...receipt, items: legacy.map(item => ({ ...item, running: false })) }).success).toBe(false);
  });
  it('refuses partial generation annotation and duplicate identities across generations', () => {
    expect(containerLifecycleRequest.safeParse({ ...stop, targets: [old, { ...candidate, deploymentId: undefined }] }).success).toBe(false);
    expect(containerLifecycleReply.safeParse({ ...receipt, items: [{ ...old, running: false }, { ...target, running: false }] }).success).toBe(false);
    expect(containerLifecycleRequest.safeParse({ ...stop, targets: [old, { ...candidate, id: old.id }] }).success).toBe(false);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10'])('refuses an invalid target generation: %s', deploymentId => {
    expect(containerLifecycleRequest.safeParse({ ...stop, targets: [{ ...candidate, deploymentId }] }).success).toBe(false);
    expect(containerLifecycleReply.safeParse({ ...receipt, items: [{ ...candidate, deploymentId, running: false }] }).success).toBe(false);
  });
});
