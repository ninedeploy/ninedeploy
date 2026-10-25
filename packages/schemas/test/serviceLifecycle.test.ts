import { describe, expect, it } from 'vitest';
import { serviceLifecycleCommand, serviceLifecycleResult, serviceLifecycleRetry, serviceLifecycleView } from '../src/serviceLifecycle.js';
const command = { id: 1, action: 'restart', phase: 'warming', reason: null, attempts: 1, busy: true, current: true, retryable: false,
  createdAt: '2026-10-25T12:00:00.000Z', updatedAt: '2026-10-25T12:00:00.000Z', nextAttemptAt: '2026-10-25T12:00:00.000Z' };
describe('public service lifecycle contracts', () => {
  it('accepts old synchronous results and explicit pending node results', () => {
    expect(serviceLifecycleResult.parse({ ok: true, status: 'running' })).toEqual({ ok: true, status: 'running' });
    expect(serviceLifecycleResult.parse({ ok: true, status: 'stopped', pending: true, lifecycle: command }).pending).toBe(true);
    expect(serviceLifecycleView.parse({ command: null })).toEqual({ command: null });
    expect(serviceLifecycleRetry.parse({ ok: true, pending: true, command }).command).toEqual(command);
  });
  it.each([{ id: 0 }, { attempts: -1 }, { phase: 'unknown' }, { action: 'wake' }, { createdAt: 'yesterday' },
    { ownerToken: 'private' }, { targets: [{ id: 'a'.repeat(64), name: 'private' }] }])('refuses invalid or private command fields %j', patch => {
    expect(serviceLifecycleCommand.safeParse({ ...command, ...patch }).success).toBe(false);
  });
});
