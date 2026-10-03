import type { Phases } from '@ninedeploy/schemas';
import { ChipInput, Field } from '../../../components/ui.js';

export function PhasesSection({
  value,
  onChange,
}: {
  value: Phases | undefined;
  onChange: (next: Phases | undefined) => void;
}) {
  return (
    <div className="space-y-5">
      <Field
        label="Setup-phase packages (nixpkgs)"
        hint="Extra tools Nixpacks installs in the build image (e.g. python310, imagemagick)"
      >
        <ChipInput
          value={value?.setup?.pkgs ?? []}
          onChange={(pkgs) => onChange({ ...(value ?? {}), setup: { pkgs } })}
          placeholder="python310"
        />
      </Field>
      <Field
        label="Build-phase extra commands"
        hint="Run after the default install + build; for generated assets, codegen, etc."
      >
        <ChipInput
          value={value?.build?.cmds ?? []}
          onChange={(cmds) => onChange({ ...(value ?? {}), build: { cmds } })}
          placeholder="npm run build:assets"
        />
      </Field>
    </div>
  );
}
