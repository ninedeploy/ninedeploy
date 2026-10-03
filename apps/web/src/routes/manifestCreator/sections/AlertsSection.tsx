import type { Alert, AlertWhen } from '@ninedeploy/schemas';
import { Field, Input, ListEditor, Select } from '../../../components/ui.js';

const WHEN_OPTIONS: ReadonlyArray<{ value: AlertWhen; label: string; needsThreshold: boolean }> = [
  { value: 'deployFailed', label: 'Deploy failed', needsThreshold: false },
  { value: 'restartLoop', label: 'Restart loop (container keeps exiting)', needsThreshold: false },
  { value: 'highMemory', label: 'High memory usage', needsThreshold: true },
  { value: 'highCpu', label: 'High CPU usage', needsThreshold: true },
  { value: 'certExpiry', label: 'TLS certificate expiring soon', needsThreshold: false },
];

const createAlert = (): Alert => ({ when: 'deployFailed', channel: 'oncall' });

export function AlertsSection({
  value,
  onChange,
}: {
  value: Alert[] | undefined;
  onChange: (next: Alert[] | undefined) => void;
}) {
  const items = value ?? [];
  return (
    <ListEditor<Alert>
      value={items}
      onChange={(next) => onChange(next.length > 0 ? next : undefined)}
      createNew={createAlert}
      addLabel="Add alert"
      emptyMessage="No alerts — the service uses platform defaults only."
      itemLabel={(a) => a.when}
      renderItem={(alert, update) => {
        const needsThreshold = WHEN_OPTIONS.find((o) => o.value === alert.when)?.needsThreshold ?? false;
        return (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="When">
              <Select
                value={alert.when}
                onChange={(e) => {
                  const nextWhen = e.target.value as AlertWhen;
                  const nextOpts = WHEN_OPTIONS.find((o) => o.value === nextWhen);
                  const nextNeedsThreshold = nextOpts?.needsThreshold ?? false;
                  const next: Alert = { when: nextWhen, channel: alert.channel };
                  // Carry over the existing threshold when the new value
                  // also needs one (e.g. highMemory → highCpu); drop it when
                  // the new value doesn't; default to 90 when the new
                  // value needs one but the previous value didn't.
                  if (nextNeedsThreshold) {
                    if (alert.thresholdPct != null) {
                      next.thresholdPct = alert.thresholdPct;
                    } else {
                      next.thresholdPct = 90;
                    }
                  }
                  update(next);
                }}
              >
                {WHEN_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Channel name">
              <Input
                value={alert.channel}
                placeholder="oncall"
                onChange={(e) => update({ ...alert, channel: e.target.value })}
              />
            </Field>
            {needsThreshold ? (
              <Field label="Threshold (%)">
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
                No threshold needed for this trigger
              </div>
            )}
          </div>
        );
      }}
    />
  );
}
