import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createNodeLifecycle } from '../../src/lib/nodeLifecycle.js';
import { runRegisteredOp } from '../../src/agentOps/index.js';

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const target = { id: 'a'.repeat(64), name: 'web-9' };
const request = (revision = 1, action = 'start', changed: Record<string, unknown> = {}) => ({ requestId: String(revision).padStart(32, '0'), serviceId: 7,
  deploymentId: 9, revision, action, targets: [target], timeoutMs: 5000, ...changed });
let root: string, row: Record<string, unknown>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nd-lifecycle-'));
  row = { ...target, name: '/web-9', managed: 'service', serviceId: '7', deploymentId: '9', status: 'exited', running: false };
  io.spawn.mockReset().mockImplementation(async (_bin, args, sink) => {
    if (args[0] === 'inspect') sink(JSON.stringify(row));
    else { row.running = args[0] === 'start'; row.status = row.running ? 'running' : 'exited'; }
    return 0;
  });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('nd-lifecycle-')) throw new Error('Unexpected fixture cleanup path');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
const effects = () => io.spawn.mock.calls.filter(call => call[1][0] !== 'inspect').map(call => call[1]);

describe('durable node lifecycle ordering', () => {
  it('keeps the existing immutable identity operation working as a control', async () => {
    const lines: string[] = [];
    expect(await runRegisteredOp('docker.identity', { name: target.name }, line => lines.push(line), { sealed: true }, {})).toBe(0);
    expect(JSON.parse(lines[0]!.slice(13))).toMatchObject(target);
  });
  it('starts only the verified immutable ID and returns a bound completion receipt', async () => {
    const receipt = await createNodeLifecycle(root).apply(request());
    expect(receipt).toMatchObject({ requestId: request().requestId, serviceId: 7, deploymentId: 9, revision: 1, action: 'start', complete: true,
      items: [{ ...target, running: true }] });
    expect(effects()).toEqual([['start', target.id]]);
  });
  it('persists a newer Stop before rejecting delayed Start even through a new instance', async () => {
    await createNodeLifecycle(root).apply(request(2, 'stop'));
    io.spawn.mockClear();
    await expect(createNodeLifecycle(root).apply(request(1))).rejects.toThrow(/stale|superseded/i);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(readdirSync(root).length).toBeGreaterThan(0);
  });
  it('returns the original receipt on an exact retry without repeating a Docker effect', async () => {
    const first = await createNodeLifecycle(root).apply(request());
    expect(first).toMatchObject({ complete: true });
    io.spawn.mockClear();
    expect(await createNodeLifecycle(root).apply(request())).toEqual(first);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each([{ action: 'stop' }, { requestId: 'f'.repeat(32) }, { targets: [{ ...target, name: 'other' }] }])('refuses reuse of a revision for different intent: %j', async changed => {
    await createNodeLifecycle(root).apply(request()); io.spawn.mockClear();
    await expect(createNodeLifecycle(root).apply(request(1, 'start', changed))).rejects.toThrow(/conflict|different|reused/i);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it('keeps the Stop fence when Docker fails and converges an exact retry', async () => {
    await createNodeLifecycle(root).apply(request());
    io.spawn.mockRejectedValueOnce(new Error('Docker offline'));
    await expect(createNodeLifecycle(root).apply(request(2, 'stop'))).rejects.toThrow(/offline/);
    await expect(createNodeLifecycle(root).apply(request())).rejects.toThrow(/stale|superseded/i);
    expect(await createNodeLifecycle(root).apply(request(2, 'stop'))).toMatchObject({ revision: 2, complete: true, items: [{ running: false }] });
  });
  it.each([{ managed: 'database' }, { serviceId: '8' }, { deploymentId: '10' }, { name: '/replacement' }, { id: 'c'.repeat(64) }])('refuses foreign or replaced identity before any effect: %j', async changed => {
    Object.assign(row, changed);
    await expect(createNodeLifecycle(root).apply(request())).rejects.toThrow(/identity|generation/i);
    expect(effects()).toEqual([]);
  });
  it('retains a pending fence when inspection fails after the Docker effect', async () => {
    const normal = io.spawn.getMockImplementation()!;
    let calls = 0;
    io.spawn.mockImplementation(async (...args) => { if (++calls === 3) throw Error('Post-inspection offline'); return normal(...args); });
    await expect(createNodeLifecycle(root).apply(request(2))).rejects.toThrow(/offline/);
    await expect(createNodeLifecycle(root).apply(request(1, 'stop'))).rejects.toThrow(/stale|superseded/i);
    io.spawn.mockImplementation(normal);
    expect(await createNodeLifecycle(root).apply(request(2))).toMatchObject({ complete: true });
    expect(effects()).toEqual([['start', target.id]]);
  });
  it('serializes a Stop behind an already-started Docker command across instances', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const normal = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => { if (args[1][0] === 'start') { entered(); await gate; } return normal(...args); });
    const first = createNodeLifecycle(root).apply(request());
    await Promise.race([started, first.then(() => { throw new Error('Start command was not executed'); })]);
    const second = createNodeLifecycle(root).apply(request(2, 'stop'));
    try { expect(effects()).toEqual([['start', target.id]]); }
    finally { release(); }
    await Promise.all([first, second]);
    expect(row.running).toBe(false);
    expect(effects()).toEqual([['start', target.id], ['stop', '-t', '5', target.id]]);
  });
  it('accepts a retry with a shorter transport budget as the same semantic intent', async () => {
    const first = await createNodeLifecycle(root).apply(request()); io.spawn.mockClear();
    expect(await createNodeLifecycle(root).apply(request(1, 'start', { timeoutMs: 1000 }))).toEqual(first);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each(['garbage', 'null', '[]', '{}', 'x'.repeat(65_537)])('refuses malformed or oversized inspection without any effect (case %#)', async line => {
    io.spawn.mockImplementation(async (_bin, _args, sink) => { sink(line); return 0; });
    await expect(createNodeLifecycle(root).apply(request())).rejects.toThrow(/inspection|identity/);
    expect(effects()).toEqual([]);
  });
  it('checks the complete target set before starting any member', async () => {
    const other = { id: 'c'.repeat(64), name: 'web-9-r2' };
    io.spawn.mockImplementation(async (_bin, _args, sink) => {
      sink(JSON.stringify(row)); sink(JSON.stringify({ ...row, ...other, serviceId: '8' })); return 0;
    });
    await expect(createNodeLifecycle(root).apply(request(1, 'start', { targets: [target, other] }))).rejects.toThrow(/generation/);
    expect(effects()).toEqual([]);
  });
  it('keeps unrelated services independent while another service is waiting on Docker', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const normal = io.spawn.getMockImplementation()!;
    const second = { id: 'c'.repeat(64), name: 'api-10' };
    io.spawn.mockImplementation(async (...args) => {
      if (args[1].includes(second.id)) {
        if (args[1][0] === 'inspect') args[2](JSON.stringify({ ...row, ...second, serviceId: '8', deploymentId: '10', running: true, status: 'running' }));
        return 0;
      }
      if (args[1][0] === 'start') { entered(); await gate; }
      return normal(...args);
    });
    const first = createNodeLifecycle(root).apply(request()); await started;
    try {
      expect(await createNodeLifecycle(root).apply(request(1, 'start', { serviceId: 8, deploymentId: 10, targets: [second] }))).toMatchObject({ serviceId: 8, complete: true });
    } finally { release(); await first; }
  });
  it('does not replace a corrupt journal with an empty in-memory ordering fence', async () => {
    writeFileSync(join(root, 'service-7.sqlite'), 'corrupt');
    await expect(createNodeLifecycle(root).apply(request())).rejects.toThrow(/database|file/i);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it('retains command ordering until a timed-out child has actually drained', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const normal = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => { if (args[1][0] === 'start') { entered(); await gate; } return normal(...args); });
    const first = createNodeLifecycle(root).apply(request(1, 'start', { timeoutMs: 10 })).then(() => null, error => error);
    await started;
    const second = createNodeLifecycle(root).apply(request(2, 'stop'));
    try {
      await vi.advanceTimersByTimeAsync(11);
      expect((await first)?.message).toMatch(/deadline/);
      expect(effects()).toEqual([['start', target.id]]);
    } finally { release(); }
    expect(await second).toMatchObject({ revision: 2, complete: true });
    expect(row.running).toBe(false);
  });
  it('expires queued work without letting it execute after the queue drains', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const normal = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => { if (args[1][0] === 'start') { entered(); await gate; } return normal(...args); });
    const first = createNodeLifecycle(root).apply(request()); await started;
    const expired = createNodeLifecycle(root).apply(request(2, 'stop', { timeoutMs: 10 })).then(() => null, error => error);
    try { await vi.advanceTimersByTimeAsync(11); expect((await expired)?.message).toMatch(/deadline/); }
    finally { release(); await first; }
    expect(await createNodeLifecycle(root).apply(request(3, 'stop'))).toMatchObject({ complete: true });
    expect(effects()).toEqual([['start', target.id], ['stop', '-t', '5', target.id]]);
  });
  it('refuses invalid operands before creating a journal or executing Docker', async () => {
    await expect(createNodeLifecycle(root).apply(request(1, 'start', { targets: [{ id: '--all', name: 'web' }] }))).rejects.toThrow(/id|Invalid/);
    expect(readdirSync(root)).toEqual([]); expect(io.spawn).not.toHaveBeenCalled();
  });
  it('does not acknowledge a failed Docker exit and still keeps the accepted revision', async () => {
    const normal = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => args[1][0] === 'start' ? 1 : normal(...args));
    await expect(createNodeLifecycle(root).apply(request(2))).rejects.toThrow(/unconfirmed/);
    await expect(createNodeLifecycle(root).apply(request(1, 'stop'))).rejects.toThrow(/stale|superseded/);
    expect(row.running).toBe(false);
  });
  it('uses one deadline before effect execution rather than extending it per command', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const normal = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => { const result = await normal(...args); now = 100; return result; });
    await expect(createNodeLifecycle(root).apply(request(2, 'start', { timeoutMs: 50 }))).rejects.toThrow(/deadline/);
    expect(effects()).toEqual([]);
    expect(io.spawn.mock.calls[0]![3].timeoutMs).toBeLessThanOrEqual(50);
    await expect(createNodeLifecycle(root).apply(request(1, 'stop'))).rejects.toThrow(/stale|superseded/);
  });
  it('bounds pending work and holds capacity until expired queued work has drained', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const normal = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => { if (args[1][0] === 'start') { entered(); await gate; } return normal(...args); });
    const first = createNodeLifecycle(root).apply(request()); await started;
    const waiting = Array.from({ length: 15 }, (_, n) => createNodeLifecycle(root).apply(request(n + 2, 'stop', { timeoutMs: 10 })).then(() => null, error => error));
    try {
      await vi.advanceTimersByTimeAsync(11);
      expect((await Promise.all(waiting)).every(error => /deadline/.test(error?.message))).toBe(true);
      await expect(createNodeLifecycle(root).apply(request(17, 'stop'))).rejects.toThrow(/capacity.*busy/);
    } finally { release(); await first; await vi.advanceTimersByTimeAsync(0); }
    expect(await createNodeLifecycle(root).apply(request(17, 'stop'))).toMatchObject({ complete: true });
    expect(effects()).toEqual([['start', target.id], ['stop', '-t', '5', target.id]]);
  });
});
