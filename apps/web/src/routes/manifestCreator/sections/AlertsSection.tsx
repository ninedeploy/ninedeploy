import type { Alert, AlertWhen } from '@ninedeploy/schemas';
import { Field, Input, ListEditor, Select } from '../../../components/ui.js';
import { msg, useT } from '../../../lib/i18n.js';

/** `pct` triggers carry `thresholdPct`, `ms` triggers `thresholdMs`. */
const WHEN_OPTIONS: ReadonlyArray<{ value: AlertWhen; label: string; threshold: 'pct' | 'ms' | null }> = [
  { value: 'deployFailed', label: msg('Deploy failed'), threshold: null },
  { value: 'restartLoop', label: msg('Restart loop (container keeps exiting)'), threshold: null },
  { value: 'highMemory', label: msg('High memory usage'), threshold: 'pct' },
  { value: 'highCpu', label: msg('High CPU usage'), threshold: 'pct' },
  { value: 'certExpiry', label: msg('TLS certificate expiring soon'), threshold: null },
  { value: 'highErrorRate', label: msg('High error rate (5xx, needs traffic analytics)'), threshold: 'pct' },
  { value: 'slowResponses', label: msg('Slow responses (p95, needs traffic analytics)'), threshold: 'ms' },
];

const createAlert = (): Alert => ({ when: 'deployFailed', channel: 'oncall' });

export function AlertsSection({
  value,
  onChange,
}: {
  value: Alert[] | undefined;
  onChange: (next: Alert[] | undefined) => void;
}) {
  const t = useT();
  const items = value ?? [];
  return (
    <ListEditor<Alert>
      value={items}
      onChange={(next) => onChange(next.length > 0 ? next : undefined)}
      createNew={createAlert}
      addLabel={t('Add alert')}
      emptyMessage={t('No alerts — the service uses platform defaults only.')}
      itemLabel={(a) => a.when}
      renderItem={(alert, update) => {
        const threshold = WHEN_OPTIONS.find((o) => o.value === alert.when)?.threshold ?? null;
        return (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('When')}>
              <Select
                value={alert.when}
                onChange={(e) => {
                  const nextWhen = e.target.value as AlertWhen;
                  const nextThreshold = WHEN_OPTIONS.find((o) => o.value === nextWhen)?.threshold ?? null;
                  const next: Alert = { when: nextWhen, channel: alert.channel };
                  // Carry over the existing threshold when the new value
                  // also needs one of the same kind (e.g. highMemory →
                  // highCpu); drop it when the new value doesn't; default to
                  // 90 % or 1000 ms when the previous value had none.
                  if (nextThreshold === 'pct') next.thresholdPct = alert.thresholdPct ?? 90;
                  if (nextThreshold === 'ms') next.thresholdMs = alert.thresholdMs ?? 1000;
                  update(next);
                }}
              >
                {WHEN_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.label)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('Channel name')}>
              <Input
                value={alert.channel}
                placeholder="oncall"
                onChange={(e) => update({ ...alert, channel: e.target.value })}
              />
            </Field>
            {threshold === 'ms' ? (
              <Field label={t('Threshold (ms, p95)')}>
                <Input
                  type="number"
                  min={1}
                  max={600000}
                  value={alert.thresholdMs ?? 1000}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    update({ ...alert, thresholdMs: Number.isFinite(n) ? n : 1000 });
                  }}
                />
              </Field>
            ) : threshold === 'pct' ? (
              <Field label={t('Threshold (%)')}>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={alert.thresholdPct ?? 90}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    update({ ...alert, thresholdPct: Number.isFinite(n) ? n : 90 });
                  }}
                />
              </Field>
            ) : (
              <div className="flex items-end pb-2 text-xs text-slate-500">
                {t('No threshold needed for this trigger')}
              </div>
            )}
          </div>
        );
      }}
    />
  );
}
