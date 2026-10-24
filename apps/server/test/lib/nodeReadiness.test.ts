import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyNodeReadiness } from '../../src/lib/nodeReadiness.js';

const targets = Array.from({ length: 10 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), name: `web-new${i ? `-r${i + 1}` : ''}` }));
const spec = { targets, mode: 'http-strict' as const, port: 3000, path: '/ready?db=1' };
let round: number, edit: (item: any, index: number, round: number) => any;
let latency: number;
const call = vi.fn(async (_op: string, input: any, _sink: unknown, _options: unknown) => {
  round++;
  if (latency) await new Promise(resolve => setTimeout(resolve, latency));
  return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: input.requestId, complete: true,
    items: targets.map((target, index) => edit({ ...target, status: 'running', health: 'healthy', restarts: 0, failingStreak: 0, ready: true }, index, round)) })}`] };
});
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); round = 0; latency = 0; edit = item => item; });
afterEach(() => vi.useRealTimers());
async function run(timeout = 10_000, checkpoint = async () => undefined) {
  const pending = verifyNodeReadiness(call, spec, timeout, checkpoint, () => undefined);
  const result = pending.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync(); return result;
}

describe('batched node readiness policy', () => {
  it('qualifies ten replicas in three shared rounds rather than three serial waves of stable probes', async () => {
    const start = Date.now(); expect(await run()).toEqual({ value: true });
    expect(Date.now() - start).toBe(4000); expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls.every(args => args[0] === 'docker.readiness' && args[1].targets.length === 10)).toBe(true);
    expect(new Set(call.mock.calls.map(args => args[1].requestId)).size).toBe(3);
  });
  it('continues checking an already qualified replica while another is starting', async () => {
    edit = (item, index, n) => index === 0 && n >= 4 || index === 9 && n < 4 ? { ...item, ready: false } : item;
    expect(await run()).toEqual({ value: false }); expect(call).toHaveBeenCalledTimes(5);
  });
  it('restarts the stable sample count after a single restart', async () => {
    edit = (item, index, n) => index === 0 ? { ...item, restarts: n >= 3 ? 1 : 0 } : item;
    expect(await run()).toEqual({ value: true }); expect(call).toHaveBeenCalledTimes(5);
  });
  it.each(['exited', 'dead', 'removing'])('refuses terminal container state %s', async status => {
    edit = (item, index) => index ? item : { ...item, status };
    expect(await run()).toEqual({ value: false }); expect(call).toHaveBeenCalledTimes(1);
  });
  it('refuses crash looping even when every instantaneous application probe passes', async () => {
    edit = (item, index, n) => index ? item : { ...item, restarts: n - 1 };
    expect(await run()).toEqual({ value: false }); expect(call).toHaveBeenCalledTimes(4);
  });
  it('requires Docker command health and never treats missing health as a passing command', async () => {
    edit = item => ({ ...item, health: 'none' });
    const pending = verifyNodeReadiness(call, { ...spec, mode: 'command' }, 5000, async () => undefined, () => undefined);
    await vi.runAllTimersAsync(); expect(await pending).toBe(false);
  });
  it('does not claim a success returned after the original deadline', async () => {
    latency = 2500; expect(await run(5000)).toEqual({ value: false }); expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]![3]).toMatchObject({ timeoutMs: 500 });
  });
  it('does not swallow cancellation between rounds', async () => {
    const checkpoint = vi.fn(async () => { if (round >= 1) throw new Error('Deployment cancelled'); });
    const result = await run(10_000, checkpoint); expect(result).toHaveProperty('error.message', 'Deployment cancelled');
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('checks ownership after an in-flight terminal failure too', async () => {
    edit = item => ({ ...item, status: 'dead' });
    const checkpoint = vi.fn(async () => { if (round) throw new Error('Ownership changed'); });
    expect(await run(10_000, checkpoint)).toHaveProperty('error.message', 'Ownership changed');
  });
  it('refuses a decreasing restart counter on the same immutable container', async () => {
    edit = (item, _index, n) => ({ ...item, restarts: n === 1 ? 2 : 0 });
    expect(await run()).toEqual({ value: false }); expect(call).toHaveBeenCalledTimes(2);
  });
  it.each(['identity', 'duplicate', 'missing', 'not-ready', 'streak', 'malformed'])('refuses incomplete or invalid evidence: %s', async kind => {
    edit = (item, index) => index ? item : kind === 'identity' ? { ...item, id: 'f'.repeat(64) }
      : kind === 'duplicate' ? { ...item, id: targets[1]!.id, name: targets[1]!.name }
      : kind === 'missing' ? { ...item, restarts: undefined }
      : kind === 'not-ready' ? { ...item, ready: false }
      : kind === 'streak' ? { ...item, failingStreak: 15 } : { ...item, ready: 'yes' };
    expect(await run(5000)).toEqual({ value: false });
  });
});
