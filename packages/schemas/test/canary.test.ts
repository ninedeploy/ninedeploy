import { describe, expect, it } from 'vitest';
import {
  CANARY_DEFAULT_MAX_ERROR_RATE,
  CANARY_DEFAULT_MIN_REQUESTS,
  CANARY_DEFAULT_STEP_SECONDS,
  canaryConfig,
  canaryStepProblem,
  errorRatePercent,
  updateService,
} from '../src/index.js';

describe('canaryConfig', () => {
  it('fills the defaults around the steps', () => {
    expect(canaryConfig.parse({ steps: [10, 50] })).toEqual({
      steps: [10, 50],
      stepSeconds: CANARY_DEFAULT_STEP_SECONDS,
      maxErrorRate: CANARY_DEFAULT_MAX_ERROR_RATE,
      maxP95Ms: null,
      minRequests: CANARY_DEFAULT_MIN_REQUESTS,
    });
  });

  it('refuses steps that do not go up, are out of range, or are too many', () => {
    expect(canaryConfig.safeParse({ steps: [50, 10] }).success).toBe(false);
    expect(canaryConfig.safeParse({ steps: [10, 10] }).success).toBe(false);
    expect(canaryConfig.safeParse({ steps: [] }).success).toBe(false);
    expect(canaryConfig.safeParse({ steps: [0] }).success).toBe(false);
    expect(canaryConfig.safeParse({ steps: [100] }).success).toBe(false);
    expect(canaryConfig.safeParse({ steps: [1, 2, 3, 4, 5, 6] }).success).toBe(false);
    expect(canaryConfig.safeParse({ steps: [1, 2, 3, 4, 5] }).success).toBe(true);
  });

  it('bounds the step length and refuses unknown keys', () => {
    expect(canaryConfig.safeParse({ steps: [10], stepSeconds: 29 }).success).toBe(false);
    expect(canaryConfig.safeParse({ steps: [10], stepSeconds: 3601 }).success).toBe(false);
    expect(canaryConfig.safeParse({ steps: [10], weight: 5 }).success).toBe(false);
  });

  it('rides on the service PATCH, and null turns it off', () => {
    expect(updateService.parse({ canary: null }).canary).toBeNull();
    expect(updateService.parse({ canary: { steps: [25] } }).canary?.steps).toEqual([25]);
    expect(updateService.parse({}).canary).toBeUndefined();
  });
});

describe('errorRatePercent', () => {
  it('is null with no requests and rounds to two decimals', () => {
    expect(errorRatePercent(0, 0)).toBeNull();
    expect(errorRatePercent(1, 3)).toBe(33.33);
    expect(errorRatePercent(0, 10)).toBe(0);
  });
});

describe('canaryStepProblem', () => {
  const cfg = { maxErrorRate: 5, maxP95Ms: 800, minRequests: 20 };
  const stats = (requests: number, errors: number, p95Ms: number | null) => ({ requests, errors, errorRate: errorRatePercent(errors, requests), p95Ms });

  it('passes with too few requests to judge', () => {
    expect(canaryStepProblem(stats(5, 5, 9000), cfg)).toBeNull();
  });

  it('names an error rate over the limit', () => {
    expect(canaryStepProblem(stats(100, 6, 100), cfg)).toBe('6% of 100 requests failed with a 5xx (the limit is 5%)');
    expect(canaryStepProblem(stats(100, 5, 100), cfg)).toBeNull();
  });

  it('names a p95 over the limit, and skips latency when it is not judged', () => {
    expect(canaryStepProblem(stats(40, 0, 900), cfg)).toBe('p95 response time 900 ms over 40 requests (the limit is 800 ms)');
    expect(canaryStepProblem(stats(40, 0, 900), { ...cfg, maxP95Ms: null })).toBeNull();
    expect(canaryStepProblem(stats(40, 0, null), cfg)).toBeNull();
  });
});
