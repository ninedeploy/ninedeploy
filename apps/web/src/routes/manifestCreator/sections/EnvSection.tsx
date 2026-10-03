import type { Env } from '@ninedeploy/schemas';
import { ChipInput, Field, KeyValueEditor } from '../../../components/ui.js';

export function EnvSection({
  value,
  onChange,
}: {
  value: Env | undefined;
  onChange: (next: Env | undefined) => void;
}) {
  return (
    <div className="space-y-5">
      <Field
        label="Required env keys"
        hint="The build warns if any of these are missing from the service env"
      >
        <ChipInput
          value={value?.required ?? []}
          onChange={(required) => onChange({ required, ...(value?.aliases ? { aliases: value.aliases } : {}) })}
          placeholder="DATABASE_URL"
        />
      </Field>
      <div>
        <div className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
          Managed-DB aliases
        </div>
        <p className="mb-2 text-[11px] text-slate-500">
          When a managed DB attaches, these aliases let the deploy pipeline
          expose its connection string under the key the app expects
          (e.g. <code className="font-mono">DATABASE_URL</code> →{' '}
          <code className="font-mono">POSTGRES_URL</code>).
        </p>
        <KeyValueEditor
          value={value?.aliases ?? {}}
          keyPlaceholder="env key the app reads"
          valuePlaceholder="managed-DB attach alias"
          addLabel="Add alias"
          validateKey={(k) => /^[A-Z_][A-Z0-9_]*$/.test(k)}
          onChange={(aliases) =>
            onChange({
              required: value?.required ?? [],
              ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
            })
          }
        />
      </div>
    </div>
  );
}
