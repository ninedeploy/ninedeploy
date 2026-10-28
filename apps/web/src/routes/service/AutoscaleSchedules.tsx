import { Plus, Trash2 } from 'lucide-react';
import { AUTOSCALE_SCHEDULES_MAX, type AutoscaleSchedule } from '@ninedeploy/schemas';
import { msg, useT } from '../../lib/i18n.js';
import { Button, Field, Input } from '../../components/ui.js';

/** The form of one floor window: strings while typing. */
export interface ScheduleRow {
  days: number[];
  from: string;
  to: string;
  minReplicas: string;
}

export const scheduleRowsFrom = (schedules: AutoscaleSchedule[] | undefined): ScheduleRow[] =>
  (schedules ?? []).map((s) => ({ days: [...s.days], from: s.from, to: s.to, minReplicas: String(s.minReplicas) }));

export const schedulesFromRows = (rows: ScheduleRow[]) =>
  rows.map((r) => ({ days: [...r.days].sort((a, b) => a - b), from: r.from, to: r.to, minReplicas: Number(r.minReplicas) }));

const DAYS = [msg('Sun'), msg('Mon'), msg('Tue'), msg('Wed'), msg('Thu'), msg('Fri'), msg('Sat')];
/** Monday first, as a week is usually read. */
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** The browser's time zone, the default for a new schedule. */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * G5.6: scheduled replica floors inside the autoscale card. Each window
 * raises the minimum on its days and hours, in the time zone below.
 */
export function AutoscaleSchedules({
  rows,
  onRows,
  timezone,
  onTimezone,
  error,
}: {
  rows: ScheduleRow[];
  onRows: (rows: ScheduleRow[]) => void;
  timezone: string;
  onTimezone: (tz: string) => void;
  error?: string;
}) {
  const t = useT();
  const update = (i: number, patch: Partial<ScheduleRow>) => onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleDay = (i: number, day: number) => {
    const days = rows[i]!.days.includes(day) ? rows[i]!.days.filter((d) => d !== day) : [...rows[i]!.days, day];
    update(i, { days });
  };
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-slate-500">
        {t('Raise the minimum in time windows, for example on weekdays during office hours. The highest floor in force wins, up to the maximum. A window that ends before it starts runs past midnight.')}
      </p>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-end gap-3 rounded-lg border border-white/[0.06] p-3">
          <fieldset className="flex flex-wrap gap-1 border-0 p-0" aria-label={t('Days')}>
            {ORDER.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={r.days.includes(d)}
                onClick={() => toggleDay(i, d)}
                className={`rounded-md px-2 py-1 text-xs ${r.days.includes(d) ? 'bg-indigo-500/25 text-indigo-100' : 'bg-white/[0.04] text-slate-500'}`}
              >
                {t(DAYS[d]!)}
              </button>
            ))}
          </fieldset>
          <Field label={t('From')}>
            <Input type="time" value={r.from} onChange={(e) => update(i, { from: e.target.value })} className="h-9 w-28 font-mono text-xs" />
          </Field>
          <Field label={t('To')}>
            <Input type="time" value={r.to} onChange={(e) => update(i, { to: e.target.value })} className="h-9 w-28 font-mono text-xs" />
          </Field>
          <Field label={t('At least')}>
            <Input value={r.minReplicas} onChange={(e) => update(i, { minReplicas: e.target.value })} inputMode="numeric" className="h-9 w-20 font-mono text-xs" />
          </Field>
          <Button type="button" size="sm" variant="ghost" onClick={() => onRows(rows.filter((_, j) => j !== i))} aria-label={t('Remove window')}>
            <Trash2 size={13} />
          </Button>
        </div>
      ))}
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex flex-wrap items-end gap-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={rows.length >= AUTOSCALE_SCHEDULES_MAX}
          onClick={() => onRows([...rows, { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00', minReplicas: '2' }])}
        >
          <Plus size={13} /> {t('Add window')}
        </Button>
        {rows.length > 0 && (
          <Field label={t('Time zone')}>
            <Input value={timezone} onChange={(e) => onTimezone(e.target.value)} placeholder="Europe/Istanbul" className="h-9 w-56 font-mono text-xs" />
          </Field>
        )}
      </div>
    </div>
  );
}
