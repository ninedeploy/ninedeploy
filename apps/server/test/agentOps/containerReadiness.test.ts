import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { containerReadinessOps } from '../../src/agentOps/containerReadiness.js';

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const targets = Array.from({ length: 10 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), name: `web-new${i ? `-r${i + 1}` : ''}` }));
const input = { requestId: 'a'.repeat(32), targets, mode: 'http-strict', port: 3000, path: '/ready?db=1', timeoutMs: 10_000 };
let patch: (item: any, after: boolean) => any, inspection: number;
let probes: number, maxProbes: number;
beforeEach(() => {
  io.spawn.mockReset(); inspection = 0; probes = 0; maxProbes = 0; patch = item => item;
  io.spawn.mockImplementation(async (_bin, args, sink) => {
    if (args[0] === 'inspect') {
      inspection++;
      for (const target of targets) sink(JSON.stringify(patch({ ...target, name: `/${target.name}`, status: 'running', health: 'healthy', restarts: 0, failingStreak: 0 }, inspection > 1)));
      return 0;
    }
    if (args[0] === 'run') { probes++; maxProbes = Math.max(maxProbes, probes); await Promise.resolve(); sink('HTTP/1.0 200 OK'); probes--; }
    return 0;
  });
});
afterEach(() => vi.useRealTimers());
async function sample(params: any = input) {
  const lines: string[] = []; await containerReadinessOps.ops['docker.readiness']!.run(params, line => lines.push(line), { sealed: true });
  return JSON.parse(lines[0]!.slice(13));
}

describe('bounded immutable node readiness samples', () => {
  it('samples all ten immutable IDs concurrently and rechecks Docker health after probes', async () => {
    const reply = await sample(); expect(reply.complete).toBe(true); expect(reply.items).toHaveLength(10);
    expect(reply.items.every((item: any) => item.ready)).toBe(true); expect(inspection).toBe(2); expect(maxProbes).toBe(10);
    expect(io.spawn.mock.calls.filter(call => call[1][0] === 'run')).toHaveLength(10);
    expect(io.spawn.mock.calls.filter(call => call[1][0] === 'rm')).toHaveLength(10);
    expect(io.spawn.mock.calls.filter(call => call[1][0] === 'inspect').every(call => call[1].slice(3).join() === targets.map(t => t.id).join())).toBe(true);
  });
  it.each(['restarting', 'exited'])('does not launch probes against containers in state %s', async status => {
    patch = item => ({ ...item, status }); const reply = await sample(); expect(reply.items.every((item: any) => !item.ready)).toBe(true);
    expect(io.spawn.mock.calls.filter(call => call[1][0] === 'run')).toHaveLength(0);
  });
  it.each(['restarts', 'health', 'status'])('refuses readiness that changed during the probe: %s', async changed => {
    patch = (item, after) => after ? { ...item, [changed]: changed === 'restarts' ? 1 : changed === 'health' ? 'unhealthy' : 'restarting' } : item;
    const reply = await sample(); expect(reply.items.every((item: any) => !item.ready)).toBe(true);
  });
  it('never accepts the same name with a different immutable ID', async () => {
    patch = item => ({ ...item, id: 'f'.repeat(64) }); await expect(sample()).rejects.toThrow(/identity changed/);
    expect(io.spawn).toHaveBeenCalledTimes(1);
  });
  it('requires a real Docker command healthcheck', async () => {
    patch = item => ({ ...item, health: 'none' }); const reply = await sample({ ...input, mode: 'command' });
    expect(reply.items.every((item: any) => !item.ready)).toBe(true); expect(io.spawn).toHaveBeenCalledTimes(2);
  });
  it('still probes application readiness when an image has no Docker HEALTHCHECK', async () => {
    patch = item => ({ ...item, health: 'none' }); const reply = await sample();
    expect(reply.items.every((item: any) => item.ready)).toBe(true);
    expect(io.spawn.mock.calls.filter(call => call[1][0] === 'run')).toHaveLength(10);
  });
  it.each([{ targets: [] }, { targets: [targets[0], targets[0]] }, { mode: 'http-strict', port: null }, { timeoutMs: 10001 }, { path: '/ready\r\nInjected: yes' }, { targets: [{ id: '--privileged', name: 'web' }] }])('refuses invalid operands before Docker access: %j', async changed => {
    await expect(sample({ ...input, ...changed })).rejects.toThrow(); expect(io.spawn).not.toHaveBeenCalled();
  });
  it('rejects malformed and missing inspection rows without uncaught line-handler errors', async () => {
    io.spawn.mockImplementation(async (_bin, _args, sink) => { sink('not-json'); return 0; });
    await expect(sample()).rejects.toThrow(/Incomplete readiness inspection/);
  });
  it('does not claim late inspection or probe success outside the shared deadline', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const original = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => { const code = await original(...args); if (args[1][0] === 'run') now = 11; return code; });
    try { await expect(sample({ ...input, timeoutMs: 10 })).rejects.toThrow(/deadline|Incomplete readiness/); }
    finally { clock.mockRestore(); }
    expect(io.spawn.mock.calls.filter(call => call[1][0] === 'rm')).toHaveLength(10);
    expect(io.spawn.mock.calls.filter(call => call[1][0] === 'run').every(call => call[3].timeoutMs <= 10)).toBe(true);
  });
  it('holds capacity until every started helper has drained after another helper fails', async () => {
    let release!: () => void, waiting = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), original = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => {
      if (args[1][0] === 'run') {
        if (args[1].includes(`container:${targets[0]!.id}`)) throw new Error('Probe failed');
        waiting++; await gate;
      }
      return original(...args);
    });
    const first = sample().then(() => null, error => error), second = sample().then(() => null, error => error);
    try {
      for (let n = 0; n < 100 && waiting < 18; n++) await Promise.resolve();
      expect(waiting).toBe(18);
      await expect(sample()).rejects.toThrow('capacity is busy');
    } finally { release(); }
    expect((await Promise.all([first, second])).every(error => error.message === 'Probe failed')).toBe(true);
  });
});
