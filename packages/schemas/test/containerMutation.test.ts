import { describe, expect, it } from 'vitest';
import { containerInventoryRequest, containerInventoryReply, containerStopSetRequest, containerStopSetReply, containerPrepareReply, containerPrepareRequest, containerRetireSetReply, containerRetireSetRequest, runtimeFenceReply, runtimeFenceRequest, containerNetworkSetRequest, containerNetworkSetReply } from '../src/containerMutation.js';
const head = { requestId: 'a'.repeat(32), serviceId: 7, revision: 8, timeoutMs: 30_000 };
const spec = { name: 'web-10', image: 'sha256:' + 'b'.repeat(64), serviceId: 7, deploymentId: 10 };
const prepare = { ...head, deploymentId: 10, specs: [spec] };
const target = { id: 'c'.repeat(64), name: 'web-10', deploymentId: 10 };
const retired = { ...head, graceSeconds: 5, targets: [target] };
const replyHead = { requestId: head.requestId, serviceId: head.serviceId, revision: head.revision, complete: true };
describe('ordered runtime mutation wire contracts', () => {
  it('accepts an empty-generation fence, immutable batch preparation and exact retirement identities', () => {
    expect(runtimeFenceRequest.parse(head)).toEqual(head);
    expect(runtimeFenceReply.parse(replyHead)).toEqual(replyHead);
    expect(containerPrepareRequest.parse(prepare)).toEqual(prepare);
    expect(containerPrepareRequest.parse({ ...prepare, specs: [{ ...spec, managed: 'service' }] })).toMatchObject({ specs: [{ managed: 'service' }] });
    expect(containerPrepareReply.parse({ ...replyHead, deploymentId: 10, items: [{ ...target, running: true }] })).toMatchObject({ items: [{ id: target.id }] });
    expect(containerRetireSetRequest.parse(retired)).toEqual(retired);
    expect(containerRetireSetReply.parse({ ...replyHead, items: [{ ...target, removed: true }] })).toMatchObject({ items: [{ id: target.id }] });
  });
  it.each([{ requestId: 'x' }, { serviceId: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { timeoutMs: 0 }, { timeoutMs: 30_001 }, { extra: true }])('refuses an invalid fence header: %j', patch => {
    expect(runtimeFenceRequest.safeParse({ ...head, ...patch }).success).toBe(false);
  });
  it.each([
    { specs: [] }, { specs: Array.from({ length: 11 }, (_, index) => ({ ...spec, name: 'web-10-r' + index })) },
    { specs: [{ ...spec, name: '' }] }, { specs: [{ ...spec, name: 7 }] }, { specs: [spec, spec] },
    { specs: [{ ...spec, serviceId: 8 }] }, { specs: [{ ...spec, deploymentId: 11 }] }, { specs: [{ ...spec, managed: 'database' }] },
    { specs: [{ ...spec, image: 'busybox:1.36' }] }, { specs: [{ ...spec, image: 7 }] },
    { specs: [spec, { ...spec, name: 'web-10-r2', image: 'sha256:' + 'd'.repeat(64) }] },
    { timeoutMs: 300_001 }, { extra: true },
  ])('refuses unbound, ambiguous or mutable preparation: %j', patch => {
    expect(containerPrepareRequest.safeParse({ ...prepare, ...patch }).success).toBe(false);
  });
  it('accepts all ten distinct replicas from one immutable image', () => {
    expect(containerPrepareRequest.parse({ ...prepare, timeoutMs: 300_000, specs: Array.from({ length: 10 }, (_, index) => ({ ...spec, name: 'web-10-r' + index })) }).specs).toHaveLength(10);
  });
  it.each([{ targets: [target, target] }, { targets: [target, { ...target, name: 'other' }] },
    { targets: [target, { ...target, id: 'd'.repeat(64) }] }, { targets: [{ ...target, deploymentId: undefined }] },
    { targets: Array.from({ length: 31 }, (_, index) => ({ ...target, name: 'web-' + index, id: index.toString(16).padStart(64, '0') })) },
    { graceSeconds: -1 }, { graceSeconds: 301 }, { timeoutMs: 330_001 }, { extra: true },
  ])('refuses unsafe retirement identity or bounds: %j', patch => {
    expect(containerRetireSetRequest.safeParse({ ...retired, ...patch }).success).toBe(false);
  });
  it('accepts an empty retirement and thirty explicit generation identities', () => {
    expect(containerRetireSetRequest.parse({ ...retired, targets: [] }).targets).toEqual([]);
    expect(containerRetireSetReply.parse({ ...replyHead, items: [] }).items).toEqual([]);
    expect(containerRetireSetRequest.parse({ ...retired, targets: Array.from({ length: 30 }, (_, index) => ({ ...target, name: 'web-' + index, id: index.toString(16).padStart(64, '0') })) }).targets).toHaveLength(30);
  });
  it.each([
    { ...replyHead, deploymentId: 10, items: [] },
    { ...replyHead, deploymentId: 10, items: [{ ...target, running: 'false' }] },
    { ...replyHead, deploymentId: 10, items: [{ ...target, running: true }, { ...target, running: true, name: 'other' }] },
    { ...replyHead, deploymentId: 10, items: [{ ...target, running: true }, { ...target, running: true, id: 'd'.repeat(64) }] },
  ])('rejects an incomplete or duplicated creation receipt: %j', reply => {
    expect(containerPrepareReply.safeParse(reply).success).toBe(false);
  });
  it('rejects refusal or identity duplication in completion receipts', () => {
    expect(runtimeFenceReply.safeParse({ ...replyHead, complete: false }).success).toBe(false);
    expect(runtimeFenceReply.safeParse({ ...replyHead, extra: true }).success).toBe(false);
    expect(containerRetireSetReply.safeParse({ ...replyHead, items: [{ ...target, removed: false }] }).success).toBe(false);
    expect(containerRetireSetReply.safeParse({ ...replyHead, items: [{ ...target, removed: true }, { ...target, removed: true }] }).success).toBe(false);
  });
  it('keeps the complete UTF-8 request inside the sealed agent transport budget', () => {
    const batch = (length: number) => ({ ...prepare, specs: Array.from({ length: 10 }, (_, index) => ({ ...spec, name: 'web-10-r' + index, cmd: Array.from({ length: 64 }, () => 'ü'.repeat(length)) })) });
    expect(containerPrepareRequest.safeParse(batch(400)).success).toBe(true);
    const oversized = containerPrepareRequest.safeParse(batch(1000)); expect(oversized.success).toBe(false);
    if (!oversized.success) expect(oversized.error.issues.some(issue => issue.message.includes('1 MiB'))).toBe(true);
  });
  it('refuses values that cannot form a JSON wire request without throwing outside validation', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(containerPrepareRequest.safeParse({ ...prepare, specs: [{ ...spec, cpuShares: 1n }] }).success).toBe(false);
    expect(containerPrepareRequest.safeParse({ ...prepare, specs: [{ ...spec, runtimeOptions: cyclic }] }).success).toBe(false);
  });

  it('binds serving names to prepared capacity while allowing a completely stopped spare set', () => {
    expect(containerPrepareRequest.parse({ ...prepare, startNames: [] }).startNames).toEqual([]);
    expect(containerPrepareRequest.parse({ ...prepare, startNames: [spec.name] }).startNames).toEqual([spec.name]);
    expect(containerPrepareRequest.safeParse({ ...prepare, startNames: ['foreign'] }).success).toBe(false);
    expect(containerPrepareRequest.safeParse({ ...prepare, startNames: [spec.name, spec.name] }).success).toBe(false);
    expect(containerPrepareReply.parse({ ...replyHead, deploymentId: 10, items: [{ ...target, running: false }] }).items[0]!.running).toBe(false);
  });
  it.each(['connect', 'disconnect'] as const)('binds %s membership to exact generation identities', action => {
    const input = { ...head, action, networks: ['nd-dbnet-pg'], targets: [target] };
    expect(containerNetworkSetRequest.parse(input)).toEqual(input);
    const reply = { ...replyHead, action, networks: input.networks, items: [{ ...target, connected: action === 'connect' }] };
    expect(containerNetworkSetReply.parse(reply)).toEqual(reply);
    expect(containerNetworkSetReply.safeParse({ ...reply, items: [{ ...target, connected: action !== 'connect' }] }).success).toBe(false);
    expect(containerNetworkSetReply.safeParse({ ...reply, items: [reply.items[0], reply.items[0]] }).success).toBe(false);
  });
  it.each([{ networks: [] }, { networks: ['nd-x', 'nd-x'] }, { networks: ['--flag'] }, { networks: Array.from({ length: 33 }, (_, index) => 'nd-' + index) },
    { targets: [] }, { targets: [target, target] }, { targets: [target, { ...target, id: 'd'.repeat(64) }] }, { targets: [target, { ...target, name: 'other' }] },
    { timeoutMs: 60_001 }, { action: 'run' }, { extra: true },
  ])('refuses ambiguous network sets and bounds: %j', patch => {
    expect(containerNetworkSetRequest.safeParse({ ...head, action: 'connect', networks: ['nd-dbnet-pg'], targets: [target], ...patch }).success).toBe(false);
  });

});

describe('generation-independent Stop wire contracts', () => {
  it('accepts fenced inventory and Stop without fabricating a deployment anchor', () => {
    expect(containerInventoryRequest.parse({ ...head, expectedNames: ['web-10'] })).toMatchObject({ serviceId: 7 });
    expect(containerInventoryRequest.parse(head).expectedNames).toBeUndefined();
    expect(containerInventoryReply.parse({ ...replyHead, items: [] }).items).toEqual([]);
    expect(containerInventoryReply.parse({ ...replyHead, items: [{ ...target, running: true }] }).items).toHaveLength(1);
    expect(containerStopSetRequest.parse({ ...retired, targets: [] }).targets).toEqual([]);
    expect(containerStopSetReply.parse({ ...replyHead, items: [{ ...target, running: false }] })).toMatchObject({ complete: true });
  });
  it.each([['x', 'x'], ['--unsafe'], Array.from({ length: 31 }, (_, i) => 'web-' + i)])('rejects ambiguous or unbounded expected names: %j', (...names) => {
    expect(containerInventoryRequest.safeParse({ ...head, expectedNames: names }).success).toBe(false);
  });
  it('rejects duplicate inventory and stopped-set identities or a still-running completion', () => {
    expect(containerInventoryReply.safeParse({ ...replyHead, items: [{ ...target, running: true }, { ...target, running: false }] }).success).toBe(false);
    expect(containerStopSetReply.safeParse({ ...replyHead, items: [{ ...target, running: true }] }).success).toBe(false);
    expect(containerStopSetReply.safeParse({ ...replyHead, items: [{ ...target, running: false }, { ...target, running: false }] }).success).toBe(false);
  });
});
