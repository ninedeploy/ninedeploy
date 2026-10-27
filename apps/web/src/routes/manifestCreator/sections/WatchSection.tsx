import type { Watch } from '@ninedeploy/schemas';
import { ChipInput, Field } from '../../../components/ui.js';
import { useT } from '../../../lib/i18n.js';

export function WatchSection({
  value,
  onChange,
}: {
  value: Watch | undefined;
  onChange: (next: Watch | undefined) => void;
}) {
  const t = useT();
  return (
    <Field
      label={t('Watch paths')}
      hint={t('Monorepo sub-paths; auto-deploy only triggers when a changed file matches')}
    >
      <ChipInput
        value={value?.paths ?? []}
        onChange={(paths) => onChange({ paths })}
        placeholder="apps/web/**"
      />
    </Field>
  );
}
