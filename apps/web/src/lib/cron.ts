/**
 * Minimal 5-field cron helpers for the scheduled-jobs editor.
 *
 * Deliberately NOT a full scheduler engine: presets generate simple
 * expressions and hand-typed ones are validated/previewed on a best-effort
 * basis (see nextCronRun's horizon note). Anything unparseable degrades
 * gracefully — the UI hides the "next run" hint instead of erroring.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
/** For day-of-week pickers; index === cron dow number (0 = Sunday). */
export const WEEKDAY_LABELS: readonly string[] = WEEKDAYS;

/** Expands one cron field into a set of matching values, or null if unsupported. */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    // Each comma-separated piece: "*", "n", "a-b", optionally "/step".
    const match = part.match(/^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!match) return null;
    const step = match[4] ? Math.max(1, Number(match[4])) : 1;
    let start = min;
    let end = max;
    if (!match[1]) {
      const lo = Number(match[2]);
      if (match[3]) {
        start = lo;
        end = Number(match[3]);
      } else {
        start = lo;
        end = match[4] ? max : lo; // "5/15" means "starting at 5, every 15"
      }
    }
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

export interface CronParts {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  /** Null = unrestricted (matching any weekday). */
  weekdays: Set<number> | null;
}

/** Parses a 5-field expression; returns null when structurally invalid. */
export function parseCron(expr: string): CronParts | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minutes = parseField(m, 0, 59);
  const hours = parseField(h, 0, 23);
  const daysOfMonth = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12);
  // Most implementations accept Sunday as both 0 and 7; normalize 7 → 0.
  const weekdays = parseField(dow, 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !weekdays) return null;
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    weekdays: dow === '*' ? null : weekdays,
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/**
 * Next matching wall-clock time strictly after `from`, or null when none is
 * found within ~2 years. Standard day-matching rule: when BOTH day-of-month
 * and weekday are restricted, a day matches if EITHER matches; otherwise
 * each must individually match.
 *
 * Advances by month/day/hour jumps instead of minute steps so sparse
 * expressions (yearly "0 0 29 2 *") stay cheap to evaluate on the fly.
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const parts = parseCron(expr);
  if (!parts) return null;

  // Start strictly after `from`, rounded up to a whole minute.
  let y = from.getFullYear();
  let mo = from.getMonth();
  let d = from.getDate();
  let h = from.getHours();
  let mi = from.getMinutes() + 1;
  if (mi > 59) {
    h += 1;
    mi = 0;
    if (h > 23) {
      h = 0;
      d += 1;
      const overflow = new Date(y, mo, d);
      y = overflow.getFullYear();
      mo = overflow.getMonth();
      d = overflow.getDate();
    }
  }

  // ~2y horizon guards impossible dates (e.g. Feb 30 in any year).
  const limitYear = y + 3;

  while (y < limitYear) {
    if (!parts.months.has(mo + 1)) {
      mo += 1;
      if (mo > 11) {
        mo = 0;
        y += 1;
      }
      d = 1;
      // r207: a fresh day starts at 00:00. The clock used to carry over from
      // `from`, so a day that only matches EARLIER than the current time of
      // day (a weekly 03:00 seen at 10:30) was skipped entirely.
      h = 0;
      mi = 0;
      continue;
    }
    const domRestricted = parts.daysOfMonth.size !== 31;
    const dowRestricted = parts.weekdays != null;
    const dateMatches = parts.daysOfMonth.has(d);
    const dowMatches = parts.weekdays?.has(new Date(y, mo, d).getDay()) ?? true;
    const dayOk =
      domRestricted && dowRestricted ? dateMatches || dowMatches : dateMatches && dowMatches;
    if (!dayOk) {
      d += 1;
      h = 0;
      mi = 0;
      if (new Date(y, mo, d).getDate() !== d) {
        // Rolled past end of month.
        mo += 1;
        if (mo > 11) {
          mo = 0;
          y += 1;
        }
        d = 1;
      }
      continue;
    }
    if (!parts.hours.has(h)) {
      // Jumping into a fresh hour must rescan its minutes from the top,
      // otherwise arriving mid-minute at the target hour skips its slot.
      h += 1;
      mi = 0;
      if (h > 23) {
        h = 0;
        d += 1;
        if (new Date(y, mo, d).getDate() !== d) {
          mo += 1;
          if (mo > 11) {
            mo = 0;
            y += 1;
          }
          d = 1;
        }
      }
      continue;
    }
    if (!parts.minutes.has(mi)) {
      mi += 1;
      if (mi > 59) {
        mi = 0;
        h += 1;
        if (h > 23) {
          h = 0;
          d += 1;
          if (new Date(y, mo, d).getDate() !== d) {
            mo += 1;
            if (mo > 11) {
              mo = 0;
              y += 1;
            }
            d = 1;
          }
        }
      }
      continue;
    }
    return new Date(y, mo, d, h, mi, 0, 0);
  }
  return null;
}

/** Lowest value of a field set (Sets fill in parsing order, not value order). */
function lowest(set: Set<number>): number {
  return Math.min(...set);
}

/** Single occurrence of "HH:MM" from the minute/hour singleton sets. */
function atTime(parts: CronParts): string {
  const h = String(lowest(parts.hours)).padStart(2, '0');
  const m = String(lowest(parts.minutes)).padStart(2, '0');
  return `${h}:${m}`;
}

/** Spacing of a uniformly spaced set covering its whole range anchored at min, else null. */
function uniformStep(set: Set<number>, min: number, max: number): number | null {
  if (set.size < 2) return null;
  const sorted = [...set].sort((a, b) => a - b);
  const gap = sorted[1]! - sorted[0]!;
  if (sorted[0] !== min || !Number.isInteger(gap)) return null;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! !== gap) return null;
  }
  // Full coverage at this spacing (e.g. */15 over minutes ⇒ exactly 4 values,
  // so "0,15,30" is NOT reported as "every 15 minutes").
  const fullCount = Math.floor((max - min) / gap) + 1;
  return set.size === fullCount ? gap : null;
}

/**
 * Human sentence for the job list chip. Returns null when the expression is
 * invalid or too exotic to summarise confidently — callers then show the
 * bare cron instead of risking a wrong description.
 */
export function describeCron(expr: string): string | null {
  const parts = parseCron(expr);
  if (!parts) return null;

  const trivialDom = parts.daysOfMonth.size === 31;
  const trivialMon = parts.months.size === 12;
  const trivialDow = parts.weekdays == null;

  const minuteStep = uniformStep(parts.minutes, 0, 59);
  const hourStep = uniformStep(parts.hours, 0, 23);
  // A wildcard hour field IS a full "every hour" rung family; guard on the
  // set size, not on the step value (a full star also yields step 1).
  const fullHours = parts.hours.size === 24;

  // Every n minutes across all hours.
  if (minuteStep && fullHours && trivialDom && trivialMon && trivialDow) {
    return minuteStep === 1 ? 'every minute' : `every ${minuteStep} minutes`;
  }
  // Every n hours, on the hour.
  if (hourStep && parts.minutes.size === 1 && parts.minutes.has(0) && trivialDom && trivialMon && trivialDow) {
    return hourStep === 1 ? 'every hour' : `every ${hourStep} hours`;
  }

  // Fixed daily time — e.g. "every day at 03:00".
  if (parts.minutes.size === 1 && parts.hours.size === 1 && trivialDom && trivialMon && trivialDow) {
    return `every day at ${atTime(parts)}`;
  }
  // Weekly — single weekday + fixed time.
  if (
    parts.minutes.size === 1 && parts.hours.size === 1 &&
    trivialDom && trivialMon && parts.weekdays?.size === 1
  ) {
    return `every ${WEEKDAYS[parts.weekdays ? lowest(parts.weekdays) : 0]} at ${atTime(parts)}`;
  }
  // Monthly — single day-of-month + fixed time, any weekday.
  if (
    parts.minutes.size === 1 && parts.hours.size === 1 &&
    parts.daysOfMonth.size === 1 && trivialMon && parts.weekdays == null
  ) {
    const d = lowest(parts.daysOfMonth);
    const suffix = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th';
    return `monthly on the ${d}${suffix} at ${atTime(parts)}`;
  }
  return null;
}

// ── Preset catalogue ───────────────────────────────────────────────────────

export interface PresetOption {
  id: string;
  label: string;
  /** Fixed cron produced by the preset; null ⇒ built from picker inputs. */
  cron: string | null;
  hint: string;
  /** Extra pickers the preset needs beyond itself. */
  needs?: 'time' | 'weekday-time' | 'monthday-time';
}

export const PRESETS: PresetOption[] = [
  { id: 'custom', label: 'Custom cron…', cron: null, hint: 'Write a 5-field cron expression yourself.' },
  { id: 'every-minute', label: 'Every minute', cron: '* * * * *', hint: 'Runs every minute.' },
  { id: 'every-5-min', label: 'Every 5 minutes', cron: '*/5 * * * *', hint: 'Runs every 5 minutes.' },
  { id: 'every-15-min', label: 'Every 15 minutes', cron: '*/15 * * * *', hint: 'Runs every 15 minutes.' },
  { id: 'every-30-min', label: 'Every 30 minutes', cron: '*/30 * * * *', hint: 'Runs every 30 minutes.' },
  { id: 'hourly', label: 'Hourly', cron: '0 * * * *', hint: 'Runs at the top of every hour.' },
  { id: 'daily', label: 'Daily…', cron: null, hint: '', needs: 'time' },
  { id: 'weekly', label: 'Weekly…', cron: null, hint: '', needs: 'weekday-time' },
  { id: 'monthly', label: 'Monthly…', cron: null, hint: '', needs: 'monthday-time' },
];

/** Builds the cron string for a preset from its picker inputs. */
export function presetCron(
  option: PresetOption,
  opts: { hour: number; minute: number; weekday: number; monthday: number },
): string | null {
  switch (option.needs) {
    case 'time':
      return `${opts.minute} ${opts.hour} * * *`;
    case 'weekday-time':
      return `${opts.minute} ${opts.hour} * * ${opts.weekday}`;
    case 'monthday-time':
      return `${opts.minute} ${opts.hour} ${opts.monthday} * *`;
    default:
      return option.cron ?? null;
  }
}
