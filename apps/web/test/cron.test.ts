import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  describeCron,
  isValidCron,
  nextCronRun,
  parseCron,
  presetCron,
} from '../src/lib/cron.js';

// All expectations use LOCAL-time Date constructors so the suite is
// timezone-independent: both sides of each comparison live in the same zone.
describe('parseCron / isValidCron', () => {
  it.each([
    ['* * * * *', true],
    ['*/15 * * * *', true],
    ['0 3 * * *', true],
    ['15,45 2 * * 0-6', true],
    ['0 0 29 2 *', true],
    ['7 9 * * 7', true], // Sunday as 7 is normalized to 0
    ['* * * *', false], // four fields
    ['* * * * * *', false], // six fields
    ['61 * * * *', false], // minute out of range
    ['* 24 * * *', false], // hour out of range
    ['* * 32 * *', false], // dom out of range
    ['* * * 13 *', false], // month out of range
    ['* * * * 8', false], // dow out of range
    ['hello world', false],
  ])('%s → %s', (expr, valid) => {
    expect(isValidCron(expr)).toBe(valid);
  });

  it('marks the dow field unrestricted only for a literal star', () => {
    const star = parseCron('* * * * *');
    expect(star?.weekdays).toBeNull();
    const stepped = parseCron('*/5 */5 * * 1-5');
    expect(stepped?.weekdays).not.toBeNull();
    expect([...stepped!.weekdays!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('describeCron', () => {
  it.each([
    ['* * * * *', 'every minute'],
    ['*/5 * * * *', 'every 5 minutes'],
    ['*/30 * * * *', 'every 30 minutes'],
    ['0 * * * *', 'every hour'],
    ['0 */6 * * *', 'every 6 hours'],
    ['0 3 * * *', 'every day at 03:00'],
    ['45 14 * * *', 'every day at 14:45'],
    ['15 4 * * 0', 'every Sunday at 04:15'],
    ['7 9 * * 5', 'every Friday at 09:07'],
    ['0 2 1 * *', 'monthly on the 1st at 02:00'],
    ['30 4 15 * *', 'monthly on the 15th at 04:30'],
    ['30 4 21 * *', 'monthly on the 21st at 04:30'],
  ] as Array<[string, string]>)('%s → "%s"', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  it('returns null for invalid or unsummable expressions instead of guessing', () => {
    expect(describeCron('not a cron')).toBeNull();
    // Two scattered minutes are not "every n minutes" — refuse to summarize.
    expect(describeCron('0,20,40 9 * * *')).toBeNull();
    // Missing the final rung of its step family must not read as uniform.
    expect(describeCron('0,15,30 * * * *')).toBeNull();
    // Multi-day day-of-month sets fire on more than one day a month — a
    // "monthly on the Nth" summary would be factually wrong (r022).
    expect(describeCron('0 0 1,15 * *')).toBeNull();
    expect(describeCron('0 0 */7 * *')).toBeNull();
    expect(describeCron('0 0 1-15 * *')).toBeNull();
  });
});

describe('nextCronRun', () => {
  it('r207: a later matching day starts from midnight, not the current clock', () => {
    // Monday 2026-09-14 10:30 local → weekly Wednesday 03:00 is 2026-09-16 03:00.
    const from = new Date(2026, 8, 14, 10, 30);
    expect(nextCronRun('0 3 * * 3', from)).toEqual(new Date(2026, 8, 16, 3, 0));
    // Monthly on the 1st at 01:00, seen mid-month in the afternoon.
    expect(nextCronRun('0 1 1 * *', new Date(2026, 8, 18, 15, 0))).toEqual(new Date(2026, 9, 1, 1, 0));
    // Month skip: January-only job seen in March.
    expect(nextCronRun('5 2 * 1 *', new Date(2026, 2, 10, 23, 50))).toEqual(new Date(2027, 0, 1, 2, 5));
  });

  it('steps one minute ahead of `from` for a every-minute expression', () => {
    const from = new Date(2026, 7, 27, 12, 34);
    expect(nextCronRun('* * * * *', from)).toEqual(new Date(2026, 7, 27, 12, 35));
  });

  it('finds tomorrow for a daily expression already past its time today', () => {
    const from = new Date(2026, 7, 27, 12, 0);
    expect(nextCronRun('0 3 * * *', from)).toEqual(new Date(2026, 7, 28, 3, 0));
  });

  it('still lands later TODAY when the time has not passed yet', () => {
    const from = new Date(2026, 7, 27, 9, 10);
    expect(nextCronRun('30 14 * * *', from)).toEqual(new Date(2026, 7, 27, 14, 30));
  });

  it('honours weekly expressions without missing the same-day slot', () => {
    // 2026-08-23 is a Sunday; 23:59 the same day comes before next week.
    const from = new Date(2026, 7, 23, 10, 0);
    expect(nextCronRun('59 23 * * 0', from)).toEqual(new Date(2026, 7, 23, 23, 59));
    expect(nextCronRun('59 23 * * 0', new Date(2026, 7, 23, 23, 59))).toEqual(new Date(2026, 7, 30, 23, 59));
  });

  it('matches either day restriction when BOTH dom and dow are set', () => {
    // Friday OR the 13th. From Sat Aug 1 2026 the Friday leg hits first on
    // Aug 7 (r207: this used to assert the 13th — the stale clock made the
    // search miss Aug 7's midnight slot); from Aug 8 the dom leg wins on
    // Thursday the 13th, before Friday the 14th.
    expect(nextCronRun('0 0 13 * 5', new Date(2026, 7, 1, 0, 0))).toEqual(new Date(2026, 7, 7, 0, 0));
    expect(nextCronRun('0 0 13 * 5', new Date(2026, 7, 8, 0, 0))).toEqual(new Date(2026, 7, 13, 0, 0));
  });

  it('survives impossible dates like Feb 30 and returns null past ~2 years', () => {
    const from = new Date(2026, 7, 27, 8, 0);
    expect(nextCronRun('0 0 30 2 *', from)).toBeNull();
  });

  it('skips months and days in bulk for sparse schedules', () => {
    const from = new Date(2026, 7, 27, 23, 59);
    expect(nextCronRun('0 0 1 * *', from)).toEqual(new Date(2026, 8, 1, 0, 0)); // Sep 1
    // One minute later it is Friday Aug 28 — a weekday, so today at 06:00.
    expect(nextCronRun('0 6 * * 1-5', from)).toEqual(new Date(2026, 7, 28, 6, 0));
  });

  it('rolls the hour scan past midnight AND the year boundary on Dec 31', () => {
    // 05:00 Dec 31 with a 00:00 job: hour walk hits h=23 → h=24 → d=32
    // overflows into Jan 1 of the NEXT year inside the hour-jump branch.
    const from = new Date(2026, 11, 31, 5, 0);
    expect(nextCronRun('0 0 * * *', from)).toEqual(new Date(2027, 0, 1, 0, 0));
  });

  it('rolls the minute scan past midnight on New Year’s Eve too', () => {
    const from = new Date(2026, 11, 31, 23, 58);
    expect(nextCronRun('15 * * * *', from)).toEqual(new Date(2027, 0, 1, 0, 15));
  });
});

describe('preset catalogue', () => {
  it('produces cron strings for picker-based presets', () => {
    const opts = { hour: 4, minute: 30, weekday: 0, monthday: 1 };
    const daily = PRESETS.find((p) => p.id === 'daily')!;
    const weekly = PRESETS.find((p) => p.id === 'weekly')!;
    const monthly = PRESETS.find((p) => p.id === 'monthly')!;
    const custom = PRESETS.find((p) => p.id === 'custom')!;
    expect(presetCron(daily, opts)).toBe('30 4 * * *');
    expect(presetCron(weekly, opts)).toBe('30 4 * * 0');
    expect(presetCron(monthly, opts)).toBe('30 4 1 * *');
    expect(presetCron(custom, opts)).toBeNull();
  });

  it('every fixed preset emits a valid, describable expression', () => {
    const opts = { hour: 3, minute: 0, weekday: 0, monthday: 1 };
    for (const preset of PRESETS) {
      const expr = presetCron(preset, opts);
      if (!expr) continue; // custom / pickers handled above
      expect(isValidCron(expr), preset.id).toBe(true);
      expect(describeCron(expr), preset.id).not.toBeNull();
      expect(nextCronRun(expr, new Date(2026, 7, 27, 0, 0)), preset.id).not.toBeNull();
    }
  });
});
