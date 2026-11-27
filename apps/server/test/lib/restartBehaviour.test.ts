/**
 * N07: what a person sees after a panel restart in the middle of a canary or of an idle window,
 * and that the work of the process that stopped cannot reach what the new one starts.
 *
 * A restart is the empty registry a new process begins with: neither module keeps anything
 * else (engine/canaryState.ts, lib/sleep.ts), and their reset functions stand in for it here.
 * The stable release the canary measured is the journal's business, proven by
 * test/primary-recovery.test.ts ("ends an interrupted canary …").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Service } from '@ninedeploy/db';
import {
  beginCanary,
  canaryActive,
  canaryOwnedBy,
  canaryPromoteRequested,
  canaryRouteFor,
  canaryStats,
  canaryStatus,
  endCanary,
  recordCanaryHit,
  requestCanaryPromote,
  resetCanaryState,
  setCanaryObservation,
  setCanaryStep,
} from '../../src/engine/canaryState.js';
import { lastServiceRequestAt, recordServiceRequest, resetRequestRates } from '../../src/lib/requestRate.js';
import { markAwake, resetSleepState, sleepHoldReason, wakeService, type SleepDeps } from '../../src/lib/sleep.js';

const T0 = Date.parse('2026-11-27T12:00:00Z');
const MINUTE = 60_000;
const SPLIT = { runtimeId: 'rt-canary', replicas: 1, port: null, weight: 20 };
const stats = (requests: number) => ({ canary: { requests, errors: 0, errorRate: 0, p95Ms: null }, stable: { requests: requests * 4, errors: 0, errorRate: 0, p95Ms: null } });

beforeEach(() => {
  resetCanaryState();
  resetSleepState();
  resetRequestRates();
});
afterEach(() => {
  resetCanaryState();
  resetSleepState();
  resetRequestRates();
});

describe('a canary the panel was running when it restarted', () => {
  const slug = 'web';
  const line = (leaf: 'stable' | 'canary', startMs: number, status = 200) => recordCanaryHit(`svc_${slug}_3_${leaf}@file`, status, 12, startMs);

  it('is over: the next routing sends nothing to the candidate, and the status says there is no canary', () => {
    beginCanary(5, slug, 41, 3, true);
    setCanaryStep(5, 1, SPLIT, T0, T0 + 5 * MINUTE);
    expect(canaryRouteFor(5)).toEqual(SPLIT);
    expect(canaryStatus(5)).toMatchObject({ active: true, deploymentId: 41, step: 1, weight: 20 });

    resetCanaryState();

    expect(canaryRouteFor(5)).toBeNull();
    expect(canaryActive(5)).toBe(false);
    expect(canaryStats(5)).toBeNull();
    expect(canaryStatus(5)).toEqual({ active: false });
  });

  it("is not something the operator's controls can reach any more", () => {
    beginCanary(5, slug, 41, 3, true);
    expect(requestCanaryPromote(5, 41)).toBe(true);

    resetCanaryState();

    // The promote route answers "This deployment has no canary in progress" for this false.
    expect(requestCanaryPromote(5, 41)).toBe(false);
    expect(canaryPromoteRequested(5)).toBe(false);
  });

  it('loses its measurements: they were the restarted process’s', () => {
    beginCanary(5, slug, 41, 3, true);
    setCanaryStep(5, 1, SPLIT, T0, T0 + 5 * MINUTE);
    line('canary', T0 + 1000);
    line('stable', T0 + 1000);
    expect(canaryStats(5)).toMatchObject({ canary: { requests: 1 }, stable: { requests: 1 } });

    resetCanaryState();

    // An access-log line of the old split that the tailer reads after the restart has no canary to count in.
    line('canary', T0 + 1000);
    expect(canaryStats(5)).toBeNull();
  });

  it('cannot be touched by the work of the process that stopped, once a new canary runs', () => {
    const oldOwner = beginCanary(5, slug, 41, 3, true);
    setCanaryStep(5, 1, SPLIT, T0, T0 + 5 * MINUTE);

    // The panel restarts, and the next deployment of the service runs its own canary.
    resetCanaryState();
    const newOwner = beginCanary(5, slug, 77, 3, true);
    setCanaryStep(5, 2, { ...SPLIT, weight: 60 }, T0 + 10 * MINUTE, T0 + 15 * MINUTE);

    // The old deployment's observations, promote request, and ending by its id or its owner change nothing.
    expect(setCanaryObservation(5, 41, 1, stats(10))).toBe(false);
    expect(requestCanaryPromote(5, 41)).toBe(false);
    endCanary(5, 41);
    endCanary(5, undefined, oldOwner);
    expect(canaryOwnedBy(5, 77, newOwner)).toBe(true);
    expect(canaryStatus(5)).toMatchObject({ active: true, deploymentId: 77, step: 2, weight: 60, promoting: false });
    // Nor does an observation for a step that is not the current one.
    expect(setCanaryObservation(5, 77, 1, stats(10))).toBe(false);
    expect(setCanaryObservation(5, 77, 2, stats(10))).toBe(true);
    expect(canaryStats(5)).toMatchObject({ canary: { requests: 10 } });
    // The new canary's own ending, by its owner, is the one that ends it.
    endCanary(5, 77, newOwner);
    expect(canaryActive(5)).toBe(false);
  });

  it('counts for the new canary only the lines of its own step', () => {
    beginCanary(5, slug, 77, 3, true);
    setCanaryStep(5, 1, SPLIT, T0 + 10 * MINUTE, T0 + 15 * MINUTE);
    // The tailer reads a few seconds behind: a line from before the step began is not this step's.
    line('canary', T0 + 10 * MINUTE - 1, 500);
    expect(canaryStats(5)).toMatchObject({ canary: { requests: 0 }, stable: { requests: 0 } });
    line('canary', T0 + 10 * MINUTE + 1, 500);
    line('stable', T0 + 10 * MINUTE + 2);
    expect(canaryStats(5)).toMatchObject({ canary: { requests: 1, errors: 1 }, stable: { requests: 1, errors: 0 } });
  });
});

describe('the idle window of a service when the panel restarted', () => {
  const service = { id: 9, name: 'quiet', type: 'docker', status: 'running', runtimeId: 'rt-9', serverId: null, orchestrator: 'compose', sleepAfterMinutes: 30, asleepAt: null } as unknown as Service;
  const ctx = (now: number) => ({ now, analyticsOn: true, inFlight: new Set<number>(), routedDomains: 1, canaryRunning: false });

  it('starts again: a service idle for hours before the restart is not put to sleep right after it', () => {
    markAwake(service, T0);
    // Three hours without a request: before the restart, it would sleep now.
    expect(sleepHoldReason(service, ctx(T0 + 3 * 60 * MINUTE))).toBeNull();

    resetSleepState();
    resetRequestRates();

    expect(sleepHoldReason(service, ctx(T0 + 3 * 60 * MINUTE))).toBe('just started; the idle window begins now');
    // A full window after that, still without a request, it sleeps.
    expect(sleepHoldReason(service, ctx(T0 + 3 * 60 * MINUTE + 30 * MINUTE))).toBeNull();
  });

  it('starts again for a runtime the restarted panel has not seen, and a request keeps the service awake', () => {
    markAwake(service, T0);
    resetSleepState();
    resetRequestRates();
    expect(sleepHoldReason(service, ctx(T0 + 10 * MINUTE))).toBe('just started; the idle window begins now');
    expect(lastServiceRequestAt(9)).toBeNull();
    recordServiceRequest(9, T0 + 20 * MINUTE);
    expect(sleepHoldReason(service, ctx(T0 + 40 * MINUTE))).toBe('it had a request within the idle window');
    // A request is known to the end of its ten-second bucket: the window is over ten seconds after the half hour.
    expect(sleepHoldReason(service, ctx(T0 + 50 * MINUTE))).toBe('it had a request within the idle window');
    expect(sleepHoldReason(service, ctx(T0 + 50 * MINUTE + 10_000))).toBeNull();
  });

  it('does not hold a new wake to the one the stopped process had started', async () => {
    const started: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = {
      docker: async (args: string[]) => {
        started.push(args);
        // The wake of the process that stops never hears of its containers.
        if (started.length === 1) await gate;
      },
      probe: async () => true,
      db: { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 9 }] }) }) }) },
      now: () => T0,
      log: () => undefined,
      writeConfig: async () => undefined,
      audit: async () => undefined,
    } as unknown as SleepDeps;

    const before = wakeService(deps, service, 'test');
    // In one process a second request joins the wake in progress.
    expect(wakeService(deps, service, 'again')).toBe(before);

    resetSleepState();

    const after = wakeService(deps, service, 'test');
    expect(after).not.toBe(before);
    expect(await after).toBe(true);
    expect(started).toHaveLength(2);
    expect(started[1]?.[0]).toBe('start');
    release();
    expect(await before).toBe(true);
  });
});
