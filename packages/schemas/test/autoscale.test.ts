import { describe, expect, it } from 'vitest';
import { autoscaleConfig, desiredReplicas, updateService } from '../src/index.js';

describe('autoscaleConfig', () => {
  it('fills the defaults', () => {
    expect(autoscaleConfig.parse({ maxReplicas: 4, target: 70 })).toEqual({
      minReplicas: 1,
      maxReplicas: 4,
      metric: 'cpu',
      target: 70,
      scaleUpSeconds: 60,
      scaleDownSeconds: 300,
    });
  });

  it('needs max above min, and a percentage for cpu and memory', () => {
    expect(autoscaleConfig.safeParse({ minReplicas: 3, maxReplicas: 3, target: 50 }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ maxReplicas: 11, target: 50 }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ maxReplicas: 3, target: 150 }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ maxReplicas: 3, metric: 'memory', target: 101 }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ maxReplicas: 3, metric: 'rps', target: 150 }).success).toBe(true);
    expect(autoscaleConfig.safeParse({ maxReplicas: 3, target: 0 }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ maxReplicas: 3, target: 50, scaleDownSeconds: 30 }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ maxReplicas: 3, target: 50, extra: 1 }).success).toBe(false);
  });

  it('rides on the service PATCH, and null turns it off', () => {
    expect(updateService.parse({ autoscale: null }).autoscale).toBeNull();
    expect(updateService.parse({ autoscale: { maxReplicas: 3, target: 60 } }).autoscale?.metric).toBe('cpu');
  });
});

describe('desiredReplicas', () => {
  const cfg = { target: 50, minReplicas: 1, maxReplicas: 6 };

  it('scales by the ratio to the target', () => {
    expect(desiredReplicas(2, 100, cfg)).toBe(4);
    expect(desiredReplicas(4, 20, cfg)).toBe(2);
    expect(desiredReplicas(3, 60, cfg)).toBe(4);
  });

  it('holds within the 10% tolerance', () => {
    expect(desiredReplicas(3, 54, cfg)).toBe(3);
    expect(desiredReplicas(3, 46, cfg)).toBe(3);
  });

  it('stays within the bounds and treats zero running as one', () => {
    expect(desiredReplicas(5, 400, cfg)).toBe(6);
    expect(desiredReplicas(3, 0, cfg)).toBe(1);
    expect(desiredReplicas(3, 0, { ...cfg, minReplicas: 2 })).toBe(2);
    expect(desiredReplicas(0, 100, cfg)).toBe(2);
  });
});
