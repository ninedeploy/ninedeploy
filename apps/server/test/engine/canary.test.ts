import { afterEach, describe, expect, it, vi } from 'vitest';
import { canaryConfig } from '@ninedeploy/schemas';
import { CanaryAborted, canarySkipReason, runCanary, type RunCanaryDeps } from '../../src/engine/canary.js';
import {
  CANARY_SAMPLE_CAP,
  canaryActive,
  canaryPromoteRequested,
  canaryRouteFor,
  canaryStats,
  canaryStatus,
  beginCanary,
  endCanary,
  recordCanaryHit,
  requestCanaryPromote,
  resetCanaryState,
  setCanaryStep,
} from '../../src/engine/canaryState.js';

afterEach(() => resetCanaryState());

const runtime = { runtimeId: 'web-new', port: 3000, healthPath: '/', replicas: 1 };

/**
 * A fake clock: every sleep advances it, and `onTick` runs after each one,
 * which is where a test feeds access-log hits or asks for a promote.
 */
function harness(over: Partial<RunCanaryDeps> & { onTick?: (t: number) => void } = {}) {
  let t = 1_000_000;
  const lines: string[] = [];
  const routes: Array<number | null> = [];
  const deps: RunCanaryDeps = {
    serviceId: 1,
    slug: 'web',
    deploymentId: 7,
    config: canaryConfig.parse({ steps: [10, 50], stepSeconds: 30 }),
    runtime,
    log: (l) => lines.push(l),
    writeConfig: vi.fn(async () => {
      routes.push(canaryRouteFor(1)?.weight ?? null);
    }),
    probe: vi.fn(async () => true),
    checkpoint: vi.fn(async () => undefined),
    measured: true,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      over.onTick?.(t);
    },
    ...over,
  };
  return { deps, lines, routes, now: () => t };
}

const hits = (kind: 'canary' | 'stable', n: number, status: number, ms: number, at: number) => {
  for (let i = 0; i < n; i++) recordCanaryHit(`svc_web_4_${kind}@file`, status, ms, at);
};

describe('runCanary', () => {
  it('walks every step, keeps the last split for the switch, and logs the stages', async () => {
    const h = harness();
    await expect(runCanary(h.deps)).resolves.toBe('completed');
    expect(h.routes).toEqual([10, 50]);
    // The route stays until the pipeline ends it in the same write that switches everything.
    expect(canaryRouteFor(1)?.weight).toBe(50);
    expect(h.lines.join('\n')).toContain('Canary release: 10% → 50% → 100%, 30s per step');
    expect(h.lines).toContain('##[stage:CANARY:running] Step 1/2: 10% of requests go to the new release for 30s');
    expect(h.lines).toContain('##[stage:CANARY:success] Every step passed');
    expect(h.lines.some((l) => l.startsWith('Only 0 requests reached the new release'))).toBe(true);
  });

  it('aborts on a 5xx rate over the limit and routes everything back', async () => {
    const h = harness({ onTick: (t) => (t > 1_010_000 ? undefined : hits('canary', 30, 503, 5, t)) });
    const err = await runCanary(h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanaryAborted);
    expect((err as Error).message).toBe(
      'Canary aborted: at 10%, 100% of 60 requests failed with a 5xx (the limit is 5%). All traffic is back on the previous release.',
    );
    expect(h.routes).toEqual([10, null]);
    expect(canaryActive(1)).toBe(false);
    expect(h.lines.some((l) => l.startsWith('##[stage:CANARY:failed] Canary aborted'))).toBe(true);
  });

  it('aborts on a p95 over the limit', async () => {
    const h = harness({
      config: canaryConfig.parse({ steps: [20], stepSeconds: 30, maxP95Ms: 200, minRequests: 5 }),
      onTick: (t) => {
        hits('canary', 5, 200, 900, t);
        hits('stable', 5, 200, 50, t);
      },
    });
    await expect(runCanary(h.deps)).rejects.toThrow('at 20%, p95 response time 900 ms over 30 requests (the limit is 200 ms)');
  });

  it('passes a healthy step and logs both releases', async () => {
    const h = harness({
      config: canaryConfig.parse({ steps: [50], stepSeconds: 30, minRequests: 5 }),
      onTick: (t) => {
        hits('canary', 10, 200, 20, t);
        hits('stable', 10, 500, 20, t);
      },
    });
    await expect(runCanary(h.deps)).resolves.toBe('completed');
    expect(h.lines).toContain('Step 1 measured: new release 60 requests, 0% 5xx, p95 20 ms; previous release 60 requests, 100% 5xx, p95 20 ms');
  });

  it('judges on the healthcheck only when traffic analytics is off', async () => {
    const h = harness({ measured: false, onTick: (t) => hits('canary', 50, 503, 5, t) });
    await expect(runCanary(h.deps)).resolves.toBe('completed');
    expect(h.lines.join('\n')).toContain('Traffic analytics is off (Traefik → Traffic, operators), so each step is judged on the healthcheck only.');
    expect(h.lines.some((l) => l.startsWith('Step 1 measured'))).toBe(false);
  });

  it('aborts when the new release fails a healthcheck during a step', async () => {
    const probe = vi.fn(async () => false);
    const h = harness({ probe });
    await expect(runCanary(h.deps)).rejects.toThrow('the new release failed its healthcheck at 10%');
    expect(h.routes).toEqual([10, null]);
  });

  it('aborts when the healthcheck fails at the end of a step', async () => {
    const h = harness({ probeEveryMs: 1_000_000, probe: vi.fn(async () => false) });
    await expect(runCanary(h.deps)).rejects.toThrow('failed its healthcheck at 10%');
  });

  it('a promote ends the steps early with the split in place', async () => {
    const h = harness({ onTick: () => requestCanaryPromote(1, 7) });
    await expect(runCanary(h.deps)).resolves.toBe('promoted');
    expect(h.routes).toEqual([10]);
    expect(h.lines).toContain('##[stage:CANARY:success] Promoted');
  });

  it('a cancel routes everything back and rethrows the checkpoint error', async () => {
    const cancelled = new Error('Deployment cancelled');
    const h = harness({ checkpoint: vi.fn(async () => Promise.reject(cancelled)) });
    await expect(runCanary(h.deps)).rejects.toBe(cancelled);
    expect(h.routes).toEqual([10, null]);
  });

  it('aborts when the split cannot be written, and retries the write back', async () => {
    let calls = 0;
    const h = harness({
      writeConfig: vi.fn(async () => {
        calls++;
        if (calls <= 2) throw new Error('disk full');
      }),
    });
    await expect(runCanary(h.deps)).rejects.toThrow('the Traefik config could not be written (disk full)');
    expect(calls).toBe(3);
  });

  it('logs a write back that keeps failing', async () => {
    const h = harness({ writeConfig: vi.fn(async () => Promise.reject('down')) });
    await expect(runCanary(h.deps)).rejects.toThrow('could not be written (down)');
    expect(h.lines).toContain('⚠ could not route the traffic back: down');
  });
});

describe('canary state', () => {
  it('counts hits per release from the step start, only for a watched service', () => {
    recordCanaryHit('svc_web_4_canary@file', 500, 10, 5);
    beginCanary(1, 'web', 7, 2, true);
    recordCanaryHit('svc_web_4_canary@file', 500, 10, 5); // before any step
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 10 }, 100, 200);
    recordCanaryHit('svc_web_4_canary@file', 500, 10, 99); // logged before the step
    recordCanaryHit('svc_web_4_canary@file', 502, 30, 100);
    recordCanaryHit('svc_web_4_canary', 200, 10, 150);
    recordCanaryHit('svc_web_4_stable@file', 200, 5, 150);
    recordCanaryHit('svc_api_4_canary@file', 500, 5, 150);
    recordCanaryHit('svc_web_4@file', 500, 5, 150);
    recordCanaryHit(null, 500, 5, 150);
    expect(canaryStats(1)).toEqual({
      canary: { requests: 2, errors: 1, errorRate: 50, p95Ms: 30 },
      stable: { requests: 1, errors: 0, errorRate: 0, p95Ms: 5 },
    });
    expect(canaryStats(2)).toBeNull();
  });

  it('caps the kept durations but keeps counting', () => {
    beginCanary(1, 'web', 7, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'n', replicas: 1, port: null, weight: 10 }, 0, 1);
    for (let i = 0; i < CANARY_SAMPLE_CAP + 5; i++) recordCanaryHit('svc_web_1_canary', 200, 1, 0);
    expect(canaryStats(1)!.canary.requests).toBe(CANARY_SAMPLE_CAP + 5);
  });

  it('describes the canary in progress, and nothing once it ends', () => {
    expect(canaryStatus(1)).toEqual({ active: false });
    beginCanary(1, 'web', 7, 2, false);
    expect(canaryStatus(1)).toMatchObject({ active: true, deploymentId: 7, step: 0, steps: 2, weight: 0, measured: false, promoting: false });
    expect(canaryStatus(1).stepEndsAt).toBeUndefined();
    setCanaryStep(1, 2, { runtimeId: 'n', replicas: 1, port: null, weight: 50 }, Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 20, 0, 2));
    expect(requestCanaryPromote(1, 8)).toBe(false);
    expect(requestCanaryPromote(1, 7)).toBe(true);
    expect(canaryPromoteRequested(1)).toBe(true);
    expect(canaryStatus(1)).toMatchObject({
      step: 2,
      weight: 50,
      stepStartedAt: '2026-10-20T00:00:00.000Z',
      stepEndsAt: '2026-10-20T00:02:00.000Z',
      promoting: true,
      canary: { requests: 0, errors: 0, errorRate: null, p95Ms: null },
    });
    endCanary(1);
    endCanary(1);
    expect(canaryStatus(1)).toEqual({ active: false });
    expect(requestCanaryPromote(1, 7)).toBe(false);
    setCanaryStep(1, 1, { runtimeId: 'n', replicas: 1, port: null, weight: 5 }, 0, 1);
    expect(canaryRouteFor(1)).toBeNull();
  });

  it('a new canary for a reused slug does not lose its hits to the old one', () => {
    beginCanary(1, 'web', 7, 1, true);
    beginCanary(2, 'web', 8, 1, true);
    endCanary(1);
    setCanaryStep(2, 1, { runtimeId: 'n', replicas: 1, port: null, weight: 5 }, 0, 1);
    recordCanaryHit('svc_web_3_canary', 200, 1, 0);
    expect(canaryStats(2)!.canary.requests).toBe(1);
  });
});

describe('canarySkipReason', () => {
  const base = {
    config: canaryConfig.parse({ steps: [10] }),
    type: 'docker',
    serverId: null,
    orchestrator: null,
    previous: { runtimeId: 'web-old', port: 3000, healthPath: '/' },
    runtime,
    rollback: false,
    hostPorts: false,
    routedDomains: 1,
  };

  it('runs a canary for a docker service on the panel host with a previous release and a domain', () => {
    expect(canarySkipReason(base)).toBeNull();
    expect(canarySkipReason({ ...base, config: null })).toBeNull();
  });

  it('names why it does not', () => {
    expect(canarySkipReason({ ...base, type: 'compose' })).toBe('canary releases apply to docker services only');
    expect(canarySkipReason({ ...base, serverId: 3 })).toMatch(/panel host only/);
    expect(canarySkipReason({ ...base, orchestrator: 'swarm' })).toMatch(/Swarm/);
    expect(canarySkipReason({ ...base, previous: undefined })).toBe('there is no previous release to split traffic with');
    expect(canarySkipReason({ ...base, previous: { ...base.previous, runtimeId: 'web-new' } })).toMatch(/no previous release/);
    expect(canarySkipReason({ ...base, hostPorts: true })).toMatch(/host ports/);
    expect(canarySkipReason({ ...base, rollback: true })).toBe('a rollback switches all traffic at once');
    expect(canarySkipReason({ ...base, routedDomains: 0 })).toBe('no domain routes traffic to the service');
  });
});
