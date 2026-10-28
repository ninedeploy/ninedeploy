import { describe, expect, it } from 'vitest';
import { autoscaleConfig } from '@ninedeploy/schemas';
import { describeWindow, effectiveMinimum, localTime, windowActive } from '../../src/lib/autoscaleSchedule.js';

/** G5.6 scheduled replica floors. */
const at = (iso: string) => Date.parse(iso);

describe('localTime', () => {
  it('reads the weekday and minute in the time zone', () => {
    // 2026-10-28 is a Wednesday. 06:30 UTC is 09:30 in Istanbul (UTC+3).
    expect(localTime(at('2026-10-28T06:30:00Z'), 'UTC')).toEqual({ day: 3, minute: 390 });
    expect(localTime(at('2026-10-28T06:30:00Z'), 'Europe/Istanbul')).toEqual({ day: 3, minute: 570 });
    // Past midnight in Tokyo, still Tuesday in New York.
    expect(localTime(at('2026-10-28T02:00:00Z'), 'America/New_York').day).toBe(2);
  });
});

describe('windowActive', () => {
  const office = { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' };
  it('covers the start and stops at the end', () => {
    expect(windowActive(office, 3, 8 * 60)).toBe(true);
    expect(windowActive(office, 3, 18 * 60 - 1)).toBe(true);
    expect(windowActive(office, 3, 18 * 60)).toBe(false);
    expect(windowActive(office, 0, 9 * 60)).toBe(false); // Sunday
  });
  it('runs past midnight into the next day', () => {
    const night = { days: [5], from: '22:00', to: '02:00' }; // Friday night
    expect(windowActive(night, 5, 23 * 60)).toBe(true);
    expect(windowActive(night, 6, 60)).toBe(true); // early Saturday
    expect(windowActive(night, 6, 23 * 60)).toBe(false);
    expect(windowActive(night, 5, 60)).toBe(false); // early Friday belongs to Thursday's window
  });
});

describe('effectiveMinimum', () => {
  // Not parsed: the schema refuses a floor above the maximum, and this checks the cap holds anyway.
  const cfg = {
    minReplicas: 1,
    maxReplicas: 5,
    timezone: 'Europe/Istanbul',
    schedules: [
      { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00', minReplicas: 3 },
      { days: [3], from: '12:00', to: '13:00', minReplicas: 9 },
    ],
  };
  it('takes the highest floor in force, capped at the maximum', () => {
    expect(effectiveMinimum(cfg, at('2026-10-28T06:30:00Z'))).toMatchObject({ minReplicas: 3 }); // Wed 09:30 local
    expect(effectiveMinimum(cfg, at('2026-10-28T09:30:00Z'))).toMatchObject({ minReplicas: 5 }); // Wed 12:30: 9 capped at 5
    expect(effectiveMinimum(cfg, at('2026-10-28T16:00:00Z'))).toEqual({ minReplicas: 1, window: null }); // 19:00 local
  });
  it('keeps the configured minimum when it is higher', () => {
    expect(effectiveMinimum({ ...cfg, minReplicas: 4 }, at('2026-10-28T06:30:00Z'))).toEqual({ minReplicas: 4, window: null });
  });
  it('describes a window for logs', () => {
    expect(describeWindow(cfg.schedules![0]!, cfg.timezone)).toBe('Mon–Fri 08:00–18:00 Europe/Istanbul');
    expect(describeWindow({ days: [0, 6], from: '10:00', to: '12:00' })).toBe('Sun, Sat 10:00–12:00 UTC');
  });
});

describe('the schema', () => {
  const base = { maxReplicas: 4, target: 70 };
  it('refuses a bad time zone, an empty window, a floor above the maximum, and bad times', () => {
    expect(autoscaleConfig.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ ...base, schedules: [{ days: [1], from: '08:00', to: '08:00', minReplicas: 2 }] }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ ...base, schedules: [{ days: [1], from: '08:00', to: '09:00', minReplicas: 5 }] }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ ...base, schedules: [{ days: [1], from: '8:00', to: '09:00', minReplicas: 2 }] }).success).toBe(false);
    expect(autoscaleConfig.safeParse({ ...base, schedules: [{ days: [7], from: '08:00', to: '09:00', minReplicas: 2 }] }).success).toBe(false);
  });
  it('keeps a stored configuration without schedules as it was', () => {
    expect(autoscaleConfig.parse(base)).toEqual({ minReplicas: 1, maxReplicas: 4, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 300 });
  });
});
