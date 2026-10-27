import type { Phases } from '@ninedeploy/schemas';
import { ChipInput, Field } from '../../../components/ui.js';
import { useT } from '../../../lib/i18n.js';

export function PhasesSection({
  value,
  onChange,
}: {
  value: Phases | undefined;
  onChange: (next: Phases | undefined) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-5">
      <Field
        label={t('Setup-phase packages (nixpkgs)')}
        hint={t('Extra tools Nixpacks installs in the build image (e.g. python310, imagemagick)')}
      >
        <ChipInput
          value={value?.setup?.pkgs ?? []}
          onChange={(pkgs) => onChange({ ...(value ?? {}), setup: { pkgs } })}
          placeholder="python310"
        />
      </Field>
      <Field
        label={t('Build-phase extra commands')}
        hint={t('Run after the default install + build; for generated assets, codegen, etc.')}
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
