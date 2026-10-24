import { describe, expect, it } from 'vitest';
import { containerReadinessReply, containerReadinessRequest } from '../src/containerReadiness.js';

const targets = [{ id: 'a'.repeat(64), name: 'web-new' }, { id: 'b'.repeat(64), name: 'web-new-r2' }];
const input = { requestId: 'c'.repeat(32), targets, mode: 'http-strict', port: 3000, path: '/ready?db=1', timeoutMs: 10_000 };
describe('bounded immutable readiness contracts', () => {
  it('accepts ten identities and preserves the configured health query', () => {
    const ten = Array.from({ length: 10 }, (_, index) => ({ id: (index + 1).toString(16).padStart(64, '0'), name: `web-r${index + 1}` }));
    expect(containerReadinessRequest.parse({ ...input, targets: ten }).path).toBe('/ready?db=1');
  });
  it.each(['auto', 'running', 'command'])('allows a non-application sample without a port: %s', mode => {
    expect(containerReadinessRequest.parse({ ...input, mode, port: null }).port).toBe(null);
  });
  it.each([{ targets: [] }, { targets: [...targets, targets[0]] }, { targets: [targets[0], { ...targets[1], name: targets[0]!.name }] },
    { targets: Array(11).fill(targets[0]) }, { mode: 'http-strict', port: null }, { mode: 'tcp', port: null },
    { timeoutMs: 0 }, { timeoutMs: 10001 }, { path: 'ready' }, { path: '/ready\n' }, { path: '/ready\u007f' }, { path: '/ready\\private' }, { unexpected: true }])('refuses invalid request %j', patch => {
    expect(containerReadinessRequest.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it('accepts only bounded typed inspection replies', () => {
    const reply = { requestId: input.requestId, complete: true, items: targets.map(target => ({ ...target, ready: true, status: 'running', health: 'healthy', restarts: 0, failingStreak: 0 })) };
    expect(containerReadinessReply.parse(reply)).toEqual(reply);
    expect(containerReadinessReply.safeParse({ ...reply, items: [] }).success).toBe(false);
    expect(containerReadinessReply.safeParse({ ...reply, items: [{ ...reply.items[0], restarts: -1 }] }).success).toBe(false);
    expect(containerReadinessReply.safeParse({ ...reply, items: [{ ...reply.items[0], secret: 'unrecognized' }] }).success).toBe(false);
  });
});
