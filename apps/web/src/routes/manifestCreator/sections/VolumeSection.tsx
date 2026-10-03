import type { Volume } from '@ninedeploy/schemas';
import { cn, Field, Input } from '../../../components/ui.js';

/** One-click schedules for the most common backup cadences. */
const SCHEDULE_CHIPS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: 'Daily 03:00', cron: '0 3 * * *' },
  { label: 'Every 6h', cron: '0 */6 * * *' },
  { label: 'Weekly Sun 04:00', cron: '0 4 * * 0' },
  { label: 'Monthly 1st 05:00', cron: '0 5 1 * *' },
];

export function VolumeSection({
  value,
  onChange,
}: {
  value: Volume | undefined;
  onChange: (next: Volume | undefined) => void;
}) {
  const schedule = value?.backups?.schedule ?? '';
  return (
    <div className="space-y-4">
      <Field
        label="Mount path"
        hint="Container path where the persistent volume is mounted (e.g. /data)"
      >
        <Input
          value={value?.mount ?? ''}
          placeholder="/data"
          onChange={(e) => onChange({ ...(value ?? {}), mount: e.target.value || undefined })}
        />
      </Field>
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Off-site backups
        </div>
        <p className="mb-3 text-[11px] text-slate-500">
          Cron schedule in standard 5-field format. Backups are written to the
          configured S3 destination; retention deletes older copies.
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {SCHEDULE_CHIPS.map((chip) => {
            const active = schedule === chip.cron;
            return (
              <button
                key={chip.cron}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onChange({
                    ...(value ?? {}),
                    backups: {
                      schedule: chip.cron,
                      retention: value?.backups?.retention ?? 7,
                    },
                  });
                }}
                className={cn(
                  'rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition',
                  active
                    ? 'bg-indigo-500/15 text-indigo-200 ring-indigo-500/30'
                    : 'bg-white/[0.03] text-slate-400 ring-white/[0.08] hover:bg-white/[0.06] hover:text-slate-200',
                )}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Cron schedule">
            <Input
              value={schedule}
              placeholder="0 3 * * *"
              onChange={(e) => {
                const raw = e.target.value.trim();
                if (!raw) {
                  const { backups: _drop, ...rest } = value ?? {};
                  void _drop;
                  onChange(Object.keys(rest).length > 0 ? rest : undefined);
                  return;
                }
                onChange({
                  ...(value ?? {}),
                  backups: {
                    schedule: raw,
                    retention: value?.backups?.retention ?? 7,
                  },
                });
              }}
            />
          </Field>
          <Field label="Retention (days)">
            <Input
              type="number"
              min={1}
              max={365}
              value={value?.backups?.retention ?? 7}
              disabled={!value?.backups?.schedule}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (!value?.backups?.schedule || !Number.isFinite(n)) return;
                onChange({
                  ...(value ?? {}),
                  backups: { schedule: value.backups.schedule, retention: n },
                });
              }}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}
