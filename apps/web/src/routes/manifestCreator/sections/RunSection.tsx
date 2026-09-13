import type { Run, RestartPolicy } from '@ninedeploy/schemas';
import { Field, Input, Select } from '../../../components/ui.js';

const RESTART_OPTIONS: ReadonlyArray<{ value: RestartPolicy; label: string }> = [
  { value: 'unless-stopped', label: 'unless-stopped (default)' },
  { value: 'always', label: 'always' },
  { value: 'no', label: 'no' },
  { value: 'on-failure', label: 'on-failure (default retry)' },
  { value: 'on-failure:5', label: 'on-failure:5 (cap at 5 restarts)' },
];

export function RunSection({
  value,
  onChange,
}: {
  value: Run | undefined;
  onChange: (next: Run | undefined) => void;
}) {
  const update = (patch: Partial<Run>) => onChange({ ...(value ?? {}), ...patch });
  const port = value?.port;
  const healthcheck = value?.healthcheck ?? '';
  const portInvalid = port != null && (port < 1 || port > 65535);
  const healthcheckInvalid = healthcheck !== '' && !healthcheck.startsWith('/');
  return (
    <div className="space-y-4">
      <Field
        label="Container port"
        hint="The port the app listens on inside the container"
        error={portInvalid ? 'Port must be between 1 and 65535.' : undefined}
      >
        <Input
          type="number"
          min={1}
          max={65535}
          value={value?.port ?? ''}
          placeholder="3000"
          onChange={(e) => {
            const raw = e.target.value;
            const n = raw ? Number.parseInt(raw, 10) : undefined;
            update({ port: Number.isFinite(n) ? n : undefined });
          }}
        />
      </Field>
      <Field
        label="Healthcheck path"
        hint="HTTP path probed for liveness (must start with /)"
        error={healthcheckInvalid ? 'Healthcheck path must start with "/".' : undefined}
      >
        <Input
          value={value?.healthcheck ?? ''}
          placeholder="/healthz"
          onChange={(e) => update({ healthcheck: e.target.value || undefined })}
        />
      </Field>
      <Field label="Restart policy">
        <Select
          value={value?.restart ?? 'unless-stopped'}
          onChange={(e) => update({ restart: e.target.value as RestartPolicy })}
        >
          {RESTART_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
