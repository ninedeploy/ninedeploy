import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRoutingAck } from '../src/lib/proxyRoutingAck.js';

const io = vi.hoisted(() => ({ spawn: vi.fn(async (..._args: unknown[]) => 0) }));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
vi.mock('../src/lib/exec.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/exec.js')>(),
  sleep: async (ms: number) => { vi.setSystemTime(Date.now() + ms); },
}));
const { runRegisteredOp } = await import('../src/agentOps/index.js');
afterEach(() => { vi.useRealTimers(); io.spawn.mockReset(); });
const routes = 'http:\n  routers:\n    web:\n      rule: "Host(`web.example.test`)"\n      entryPoints: [web]\n      service: app\n  services:\n    app:\n      loadBalancer:\n        servers:\n          - url: "http://web-2:3000"\n';
const generation = createHash('sha256').update(routes).digest('hex');
function answer(hash = generation, content = routes) {
  const parsed = load(withRoutingAck(content)) as { http: Record<string, Record<string, object>> };
  const state = Object.fromEntries(['routers', 'services', 'middlewares'].map(kind => [kind,
    Object.fromEntries(Object.entries(parsed.http[kind] ?? {}).map(([name, definition]) => [`${name}@file`, { ...definition, status: 'enabled' }])),
  ]));
  return `HTTP/1.1 200 OK\nX-NineDeploy-Generation: ${hash}\n\n${JSON.stringify(state)}`;
}
describe('sealed node proxy routing confirmation', () => {
  it('confirms an empty rendered routing table after the last target was removed', async () => {
    const hash = createHash('sha256').update('').digest('hex');
    io.spawn.mockImplementation(async (_exe, _args, sink) => { (sink as (s: string) => void)(answer(hash, '')); return 0; });
    const lines: string[] = [];
    expect(await runRegisteredOp('proxy.confirmRouting', { content: '' }, s => lines.push(s), { sealed: true })).toBe(0);
    expect(lines).toEqual([`ND-PROXY-ROUTING ${hash}`]);
  });
  it('observes both entry points using the fixed node proxy and returns only the requested generation receipt', async () => {
    io.spawn.mockImplementation(async (_exe, _args, sink) => { (sink as (s: string) => void)(answer()); return 0; });
    const lines: string[] = [];
    expect(await runRegisteredOp('proxy.confirmRouting', { content: routes, name: 'arbitrary-container' }, s => lines.push(s), { sealed: true })).toBe(0);
    expect(lines).toEqual([`ND-PROXY-ROUTING ${generation}`]);
    expect(io.spawn).toHaveBeenCalledTimes(2);
    for (const call of io.spawn.mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining(['exec', 'ninedeploy-proxy']));
      expect(call[1]).not.toContain('arbitrary-container');
      expect(call[3]).toMatchObject({ timeoutMs: expect.any(Number) });
    }
  });

  it('waits for the actual generation instead of returning success for an old handler', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); let calls = 0;
    io.spawn.mockImplementation(async (_exe, _args, sink) => { (sink as (s: string) => void)(answer(++calls === 1 ? '0'.repeat(64) : generation)); return 0; });
    expect(await runRegisteredOp('proxy.confirmRouting', { content: routes }, () => {}, { sealed: true })).toBe(0);
    expect(calls).toBe(3);
  });

  it('bounds an unavailable proxy without returning private API bodies', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    io.spawn.mockImplementation(async (_exe, _args, sink) => { (sink as (s: string) => void)('private routing secret'); return 1; });
    const lines: string[] = [];
    await expect(runRegisteredOp('proxy.confirmRouting', { content: routes }, s => lines.push(s), { sealed: true })).rejects.toThrow(/not confirm/);
    expect(lines).toEqual([]); expect(io.spawn.mock.calls.length).toBeLessThanOrEqual(60);
  });

  it('reassembles large JSON line fragments without changing their contents', async () => {
    io.spawn.mockImplementation(async (_exe, _args, sink) => {
      const raw = answer(), start = raw.indexOf('{');
      for (const line of raw.slice(0, start).split('\n').filter(Boolean)) (sink as (s: string) => void)(line);
      const body = raw.slice(start);
      for (let i = 0; i < body.length; i += 73) (sink as (s: string) => void)(body.slice(i, i + 73));
      return 0;
    });
    expect(await runRegisteredOp('proxy.confirmRouting', { content: routes }, () => {}, { sealed: true })).toBe(0);
  });

  it('rejects oversized observations even when they start with a valid receipt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    io.spawn.mockImplementation(async (_exe, _args, sink) => {
      (sink as (s: string) => void)(answer());
      (sink as (s: string) => void)('x'.repeat(4 * 1024 * 1024));
      return 0;
    });
    const lines: string[] = [];
    await expect(runRegisteredOp('proxy.confirmRouting', { content: routes }, s => lines.push(s), { sealed: true })).rejects.toThrow(/not confirm/);
    expect(lines).toEqual([]);
  });

  it.each([undefined, 'http: [', 'http: {}\u0000', 'x'.repeat(1024 * 1024 + 1)])('rejects invalid content before running Docker', async content => {
    await expect(runRegisteredOp('proxy.confirmRouting', { content }, () => {}, { sealed: true })).rejects.toThrow(/Invalid|too large/);
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it('refuses plaintext before running Docker', async () => {
    await expect(runRegisteredOp('proxy.confirmRouting', { content: routes }, () => {}, { sealed: false })).rejects.toThrow(/sealed/);
    expect(io.spawn).not.toHaveBeenCalled();
  });
});
