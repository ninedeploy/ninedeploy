import type { Env } from '@ninedeploy/schemas';
import { ChipInput, Field, KeyValueEditor } from '../../../components/ui.js';
import { fill, useT } from '../../../lib/i18n.js';

export function EnvSection({
  value,
  onChange,
}: {
  value: Env | undefined;
  onChange: (next: Env | undefined) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-5">
      <Field
        label={t('Required env keys')}
        hint={t('The build warns if any of these are missing from the service env')}
      >
        <ChipInput
          value={value?.required ?? []}
          onChange={(required) => onChange({ required, ...(value?.aliases ? { aliases: value.aliases } : {}) })}
          placeholder="DATABASE_URL"
        />
      </Field>
      <div>
        <div className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t('Managed-DB aliases')}
        </div>
        <p className="mb-2 text-[11px] text-slate-500">
          {fill(
            t('When a managed DB attaches, these aliases let the deploy pipeline expose its connection string under the key the app expects (e.g. {from} → {to}).'),
            {
              from: <code className="font-mono">DATABASE_URL</code>,
              to: <code className="font-mono">POSTGRES_URL</code>,
            },
          )}
        </p>
        <KeyValueEditor
          value={value?.aliases ?? {}}
          keyPlaceholder={t('env key the app reads')}
          valuePlaceholder={t('managed-DB attach alias')}
          addLabel={t('Add alias')}
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
