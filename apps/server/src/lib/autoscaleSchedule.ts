import type { AutoscaleConfig, AutoscaleSchedule } from '@ninedeploy/schemas';

/**
 * G5.6 scheduled replica floors. An autoscaled service can raise its minimum
 * in time windows (`schedules`), e.g. weekdays 08:00–18:00 in its
 * `timezone`: the autoscaler never goes below the highest floor in force,
 * capped at the maximum. A window whose end is before its start runs past
 * midnight and counts for the day it starts on.
 */

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** The weekday (0 = Sunday) and minute of the day at `now` in `timeZone`. */
export function localTime(now: number, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
    new Date(now),
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day: Math.max(0, day), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Whether `window` is in force at the given local day and minute. */
export function windowActive(window: Pick<AutoscaleSchedule, 'days' | 'from' | 'to'>, day: number, minute: number): boolean {
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  if (from < to) return window.days.includes(day) && minute >= from && minute < to;
  // Past midnight: the evening part on a listed day, the morning part on the day after one.
  const yesterday = (day + 6) % 7;
  return (window.days.includes(day) && minute >= from) || (window.days.includes(yesterday) && minute < to);
}

/** The minimum in force at `now`: the configured one, or a higher scheduled floor (capped at the maximum). */
export function effectiveMinimum(
  cfg: Pick<AutoscaleConfig, 'minReplicas' | 'maxReplicas' | 'schedules' | 'timezone'>,
  now: number,
): { minReplicas: number; window: AutoscaleSchedule | null } {
  let best: AutoscaleSchedule | null = null;
  if (cfg.schedules?.length) {
    const { day, minute } = localTime(now, cfg.timezone ?? 'UTC');
    for (const w of cfg.schedules) {
      if (windowActive(w, day, minute) && w.minReplicas > Math.max(cfg.minReplicas, best?.minReplicas ?? 0)) best = w;
    }
  }
  return best ? { minReplicas: Math.min(best.minReplicas, cfg.maxReplicas), window: best } : { minReplicas: cfg.minReplicas, window: null };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon–Fri 08:00–18:00 Europe/Istanbul", for logs and scaling reasons. */
export function describeWindow(w: Pick<AutoscaleSchedule, 'days' | 'from' | 'to'>, timeZone = 'UTC'): string {
  const days = [...new Set(w.days)].sort((a, b) => a - b);
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  const label = days.length === 7 ? 'every day' : contiguous ? `${DAY_NAMES[days[0]!]}–${DAY_NAMES[days.at(-1)!]}` : days.map((d) => DAY_NAMES[d]).join(', ');
  return `${label} ${w.from}–${w.to} ${timeZone}`;
}
