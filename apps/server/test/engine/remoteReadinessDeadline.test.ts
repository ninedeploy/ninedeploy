import { describe, expect, it, vi } from 'vitest';
import { createRemoteDockerBuilder } from '../../src/engine/builders/remoteDocker.js';

const runtime = { runtimeId: 'web-7', port: 3000, healthCheck: 'http-strict' as const, healthPath: '/ready' };
describe('remote readiness deadline', () => {
  it.each(['before', 'after-inspect'])('propagates cancellation %s instead of probing or accepting a candidate', async phase => {
    let inspected = false;
    const cancelled = new Error('Deployment cancelled');
    const call = vi.fn(async (op: string) => {
      if (op === 'docker.inspect') inspected = true;
      return { exitCode: 0, lines: [op === 'docker.inspect' ? 'running|none|0|0' : 'ND-PROBE {"ready":true,"protocol":"http","status":200}'] };
    });
    const settled = await createRemoteDockerBuilder(call).isHealthy(runtime, 500, 0, () => undefined, {
      checkpoint: async () => { if (phase === 'before' || inspected) throw cancelled; },
    }).then(value => ({ value, error: null }), error => ({ value: undefined, error }));
    expect(settled.error).toBe(cancelled);
    expect(call.mock.calls.map(args => args[0])).toEqual(phase === 'before' ? [] : ['docker.inspect']);
  });
  it.each(['container', 'http'] as const)('rejects a successful %s reply arriving after the deadline', async mode => {
    vi.useFakeTimers();
    const call = vi.fn(async (op: string) => {
      const result = { exitCode: 0, lines: [op === 'docker.inspect' ? 'running|none|0|0' : 'ND-PROBE {"ready":true,"protocol":"http","status":200}'] };
      if (op === (mode === 'container' ? 'docker.inspect' : 'docker.probe')) await new Promise(resolve => setTimeout(resolve, 600));
      return result;
    });
    try {
      const result = createRemoteDockerBuilder(call).isHealthy(mode === 'http' ? runtime : { runtimeId: runtime.runtimeId, port: runtime.port }, 500, 0);
      await vi.advanceTimersByTimeAsync(1000); await expect(result).resolves.toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it.each(['docker.inspect', 'docker.probe'])('bounds a delayed %s by the remaining readiness budget', async blocked => {
    vi.useFakeTimers(); let settled = false;
    const call = vi.fn(async (op: string, _params: Record<string, unknown>, _sink: (line: string) => void, options?: { timeoutMs?: number }) => {
      if (op === blocked) return await new Promise<{ exitCode: number; lines: string[] }>((_resolve, reject) => setTimeout(() => reject(Error('RPC deadline')), options?.timeoutMs ?? 5000));
      return { exitCode: 0, lines: [op === 'docker.inspect' ? 'running|none|0|0' : 'ND-PROBE {"ready":true,"protocol":"http","status":200}'] };
    });
    const result = createRemoteDockerBuilder(call).isHealthy(runtime, 500, 0);
    void result.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(501);
      expect(settled).toBe(true); await expect(result).resolves.toBe(false);
      const request = call.mock.calls.find(args => args[0] === blocked)!;
      expect(request[3]?.timeoutMs).toBeLessThanOrEqual(500);
    } finally { await vi.advanceTimersByTimeAsync(10000); await result; vi.useRealTimers(); }
  });
  it('also bounds diagnostic log retrieval after a terminal runtime failure', async () => {
    vi.useFakeTimers(); let settled = false;
    const call = vi.fn(async (op: string, _params: Record<string, unknown>, _sink: (line: string) => void, options?: { timeoutMs?: number }) => {
      if (op === 'docker.logs') return await new Promise<{ exitCode: number; lines: string[] }>((_resolve, reject) => setTimeout(() => reject(Error('logs unavailable')), options?.timeoutMs ?? 5000));
      return { exitCode: 0, lines: ['exited|none|0|0'] };
    });
    const result = createRemoteDockerBuilder(call).isHealthy(runtime, 500, 0); void result.then(() => { settled = true; });
    try { await vi.advanceTimersByTimeAsync(501); expect(settled).toBe(true); await expect(result).resolves.toBe(false); }
    finally { await vi.advanceTimersByTimeAsync(10000); await result; vi.useRealTimers(); }
  });
  it('still admits an immediately confirmed running and HTTP-ready candidate', async () => {
    const call = vi.fn(async (op: string) => ({ exitCode: 0, lines: [op === 'docker.inspect' ? 'running|none|0|0' : 'ND-PROBE {"ready":true,"protocol":"http","status":200}'] }));
    await expect(createRemoteDockerBuilder(call).isHealthy(runtime, 500, 0)).resolves.toBe(true);
    expect(call.mock.calls.map(args => args[0])).toEqual(['docker.inspect', 'docker.probe']);
  });
});
