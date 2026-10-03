import type { Notifications } from '@ninedeploy/schemas';
import { ChipInput, Field } from '../../../components/ui.js';

export function NotificationsSection({
  value,
  onChange,
}: {
  value: Notifications | undefined;
  onChange: (next: Notifications | undefined) => void;
}) {
  const update = (patch: Partial<Notifications>) =>
    onChange({ onDeploy: [], onFailure: [], onAlert: [], ...(value ?? {}), ...patch });
  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-500">
        Each row lists the channel <em>names</em> (matching notification channels
        created in the panel). The actual webhook URLs live in the channel config.
      </p>
      <Field label="onDeploy" hint="Pinged on every successful deploy">
        <ChipInput
          value={value?.onDeploy ?? []}
          onChange={(onDeploy) => update({ onDeploy })}
          placeholder="ops"
        />
      </Field>
      <Field label="onFailure" hint="Pinged when a deploy or healthcheck fails">
        <ChipInput
          value={value?.onFailure ?? []}
          onChange={(onFailure) => update({ onFailure })}
          placeholder="oncall"
        />
      </Field>
      <Field label="onAlert" hint="Pinged when an alert rule fires">
        <ChipInput
          value={value?.onAlert ?? []}
          onChange={(onAlert) => update({ onAlert })}
          placeholder="oncall"
        />
      </Field>
    </div>
  );
}
