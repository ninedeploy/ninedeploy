import type { Watch } from '@ninedeploy/schemas';
import { ChipInput, Field } from '../../../components/ui.js';

export function WatchSection({
  value,
  onChange,
}: {
  value: Watch | undefined;
  onChange: (next: Watch | undefined) => void;
}) {
  return (
    <Field
      label="Watch paths"
      hint="Monorepo sub-paths; auto-deploy only triggers when a changed file matches"
    >
      <ChipInput
        value={value?.paths ?? []}
        onChange={(paths) => onChange({ paths })}
        placeholder="apps/web/**"
      />
    </Field>
  );
}
