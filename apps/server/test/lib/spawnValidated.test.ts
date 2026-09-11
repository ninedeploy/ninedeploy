import { describe, expect, it, vi, beforeEach } from 'vitest';
import { spawnValidated } from '../../src/lib/spawnValidated.js';

const childMocks = vi.hoisted(() => {
  const make = () => {
    const handlers: Record<string, Array<(arg: unknown) => void>> = {};
    return {
      handlers,
      child: {
        stdin: { on: vi.fn((ev: string, cb: (arg: unknown) => void) => { const list = (handlers[`stdin:${ev}`] ?? []); list.push(cb); handlers[`stdin:${ev}`] = list; }) },
        stdout: {
          on: vi.fn((ev: string, cb: (arg: unknown) => void) => { const list = (handlers[`stdout:${ev}`] ?? []); list.push(cb); handlers[`stdout:${ev}`] = list; }),
        },
        stderr: {
          on: vi.fn((ev: string, cb: (arg: unknown) => void) => { const list = (handlers[`stderr:${ev}`] ?? []); list.push(cb); handlers[`stderr:${ev}`] = list; }),
        },
        on: vi.fn((ev: string, cb: (arg: unknown) => void) => { const list = (handlers[ev] ?? []); list.push(cb); handlers[ev] = list; }),
      },
      emit: (ev: string, arg: unknown) => { for (const cb of handlers[ev] ?? []) cb(arg); },
    };
  };
  const api = {
    make,
    spawn: vi.fn(() => { const m = make(); (api as { current: unknown }).current = m; return m.child; }),
    current: null as null | ReturnType<typeof make>,
  };
  return api;
});
vi.mock('node:child_process', () => ({ spawn: childMocks.spawn }));

describe('spawnValidated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collects stdout/stderr lines and resolves with the exit code', async () => {
    const lines: string[] = [];
    const _mock = childMocks.current!;
    const promise = spawnValidated('docker', ['ps'], (l) => lines.push(l));
    const cur = childMocks.current!;
    cur.emit('stdout:data', Buffer.from('line1\nline2\n'));
    cur.emit('stderr:data', Buffer.from('err-out\n'));
    cur.emit('close', 0);
    await expect(promise).resolves.toBe(0);
    expect(lines).toEqual(['line1', 'line2', 'err-out']);
    expect(childMocks.spawn).toHaveBeenCalledWith('docker', ['ps'], { detached: process.platform !== 'win32' });
  });

  it('spawns git for the git executable', async () => {
    const promise = spawnValidated('git', ['fetch', '--all'], () => {});
    childMocks.current!.emit('close', 1);
    await expect(promise).resolves.toBe(1);
    expect(childMocks.spawn).toHaveBeenCalledWith('git', ['fetch', '--all'], { detached: process.platform !== 'win32' });
  });

  it('resolves 127 on a spawn error', async () => {
    const promise = spawnValidated('docker', ['ps'], () => {});
    childMocks.current!.emit('error', new Error('ENOENT'));
    await expect(promise).resolves.toBe(127);
  });

  it('reports failure when the child dies to a signal (r035 — a null exit code is signal death, not success)', async () => {
    // `close` fires with code=null when the child was killed by a signal
    // (supervisor stop, OOM kill, external terminate). Reporting 0 told the
    // agent's callers the op had succeeded — exec.ts's run()/capture() treat
    // the identical condition as failure.
    const promise = spawnValidated('git', ['reset', '--hard', 'abc123'], () => {});
    childMocks.current!.emit('close', null);
    await expect(promise).resolves.toBe(1);
  });

  it('swallows stdin EPIPE races', async () => {
    const promise = spawnValidated('git', ['clone', 'x'], () => {});
    childMocks.current!.emit('stdin:error', new Error('EPIPE'));
    childMocks.current!.emit('close', 0);
    await expect(promise).resolves.toBe(0);
  });

  it('keeps a multi-byte UTF-8 character intact across a chunk boundary', async () => {
    const lines: string[] = [];
    const promise = spawnValidated('git', ['log'], (l) => lines.push(l));
    const cur = childMocks.current!;
    // 日 is E6 97 A5 — the first chunk ends mid-sequence.
    cur.emit('stdout:data', Buffer.from('日', 'utf8').subarray(0, 2));
    cur.emit('stdout:data', Buffer.concat([Buffer.from('日', 'utf8').subarray(2), Buffer.from('\n')]));
    cur.emit('close', 0);
    await expect(promise).resolves.toBe(0);
    expect(lines).toEqual(['日']);
  });

  it('reassembles a line that straddles a chunk boundary', async () => {
    const lines: string[] = [];
    const promise = spawnValidated('docker', ['logs', 'x'], (l) => lines.push(l));
    const cur = childMocks.current!;
    cur.emit('stdout:data', Buffer.from('hel'));
    cur.emit('stdout:data', Buffer.from('lo\nworld\n'));
    cur.emit('close', 0);
    await expect(promise).resolves.toBe(0);
    expect(lines).toEqual(['hello', 'world']);
  });

  it('keeps stdout and stderr line discipline separate when partial lines interleave', async () => {
    const lines: string[] = [];
    const promise = spawnValidated('docker', ['build', '.'], (l) => lines.push(l));
    const cur = childMocks.current!;
    // A partial stdout line must not absorb stderr bytes arriving before the
    // stdout newline completes — otherwise interleaved progress output merges
    // into garbage lines.
    cur.emit('stdout:data', Buffer.from('Step 1/2'));
    cur.emit('stderr:data', Buffer.from('#10 extracting\n'));
    cur.emit('stdout:data', Buffer.from(' done\n'));
    cur.emit('close', 0);
    await expect(promise).resolves.toBe(0);
    expect(lines).toEqual(['#10 extracting', 'Step 1/2 done']);
  });

  it('flushes a trailing partial line when the child closes', async () => {
    const lines: string[] = [];
    const promise = spawnValidated('git', ['rev-parse', 'HEAD'], (l) => lines.push(l));
    const cur = childMocks.current!;
    cur.emit('stdout:data', Buffer.from('abc123')); // no trailing newline
    cur.emit('close', 0);
    await expect(promise).resolves.toBe(0);
    expect(lines).toEqual(['abc123']);
  });

  it('delivers a >64KB single-line chunk as ONE line (not N fragments)', async () => {
    // d.toString('utf8').split('\n') in HEAD slices at every 64 KB V8 slab
    // boundary, silently fragmenting a long docker/git output line into garbage.
    // makeLineSplitter + 'close' (working tree fix) reassembles it correctly.
    const lines: string[] = [];
    const promise = spawnValidated('docker', ['logs', 'big'], (l) => lines.push(l));
    const cur = childMocks.current!;
    const BIG_LINE = 'x'.repeat(80_000);
    cur.emit('stdout:data', Buffer.from(`${BIG_LINE}\n`));
    cur.emit('close', 0);
    await expect(promise).resolves.toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(80_000);
    expect(lines[0]).toBe(BIG_LINE);
  });
});
