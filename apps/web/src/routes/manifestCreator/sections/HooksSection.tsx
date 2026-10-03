import type { Hooks } from '@ninedeploy/schemas';
import { Field, Input } from '../../../components/ui.js';

export function HooksSection({
  value,
  onChange,
}: {
  value: Hooks | undefined;
  onChange: (next: Hooks | undefined) => void;
}) {
  const update = (patch: Partial<Hooks>) => onChange({ ...(value ?? {}), ...patch });
  return (
    <div className="space-y-4">
      <Field label="preBuild" hint="Run before the image is built; for codegen, type generation, etc.">
        <Input
          value={value?.preBuild ?? ''}
          placeholder="./scripts/gen-types.sh"
          onChange={(e) => update({ preBuild: e.target.value || undefined })}
        />
      </Field>
      <Field label="postBuild" hint="Run after the image is built; for asset uploads, smoke tests, etc.">
        <Input
          value={value?.postBuild ?? ''}
          placeholder="./scripts/smoke.sh"
          onChange={(e) => update({ postBuild: e.target.value || undefined })}
        />
      </Field>
      <Field label="preStop" hint="Run before the container is stopped; for graceful drain">
        <Input
          value={value?.preStop ?? ''}
          placeholder="./scripts/drain.sh"
          onChange={(e) => update({ preStop: e.target.value || undefined })}
        />
      </Field>
    </div>
  );
}
