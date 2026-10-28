import { describe, expect, it } from 'vitest';
import { autoscaleConfig } from '../src/autoscale.js';
import { AUTOSCALE_SCHEDULES_MAX, autoscaleSchedule, isTimeZone, sizingReport } from '../src/sizing.js';

const window = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', minReplicas: 3 };

describe('scheduled replica minimums', () => {
  it('accepts named time zones, UTC and windows crossing midnight', () => {
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Europe/Istanbul')).toBe(true);
    expect(autoscaleSchedule.parse({ ...window, from: '23:30', to: '01:00' })).toMatchObject({ from: '23:30', to: '01:00' });
    expect(autoscaleConfig.parse({ maxReplicas: 4, target: 70, schedules: [window], timezone: 'Europe/Istanbul' }).schedules).toEqual([window]);
  });

  it('rejects invalid zones, equal times, invalid days and oversized schedules', () => {
    expect(isTimeZone('Not/A_Zone')).toBe(false);
    expect(autoscaleSchedule.safeParse({ ...window, to: window.from }).success).toBe(false);
    expect(autoscaleSchedule.safeParse({ ...window, days: [7] }).success).toBe(false);
    expect(autoscaleSchedule.safeParse({ ...window, from: '24:00' }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ maxReplicas: 4, target: 70, timezone: 'Not/A_Zone' }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ maxReplicas: 4, target: 70, schedules: Array(AUTOSCALE_SCHEDULES_MAX + 1).fill(window) }).success).toBe(false);
  });

  it('rejects a scheduled minimum above maximum capacity with a useful field path', () => {
    const result = autoscaleConfig.safeParse({ maxReplicas: 2, target: 70, schedules: [window] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['schedules', 0, 'minReplicas'] })]));
  });
});

it('validates the public resource sizing report and its suggestions', () => {
  const report = { serviceId: 7, spanHours: 24, samples: 50, memory: { p95: 100, peak: 150 }, cpu: null,
    limits: { memoryMiB: null, cpuCores: 2 }, enoughHistory: true,
    hints: [{ resource: 'memory', action: 'set', current: null, suggested: 256, reason: 'Observed usage' }] };
  expect(sizingReport.parse(report)).toEqual(report);
  expect(sizingReport.safeParse({ ...report, hints: [{ ...report.hints[0], action: 'delete' }] }).success).toBe(false);
});
