import type { Network } from '@ninedeploy/schemas';
import { ChipInput, Field, Input } from '../../../components/ui.js';

export function NetworkSection({
  value,
  onChange,
}: {
  value: Network | undefined;
  onChange: (next: Network | undefined) => void;
}) {
  return (
    <div className="space-y-4">
      <Field
        label="Publish port"
        hint="Direct host port mapping (for domain-less external access). Leave empty when only Traefik routes."
      >
        <Input
          type="number"
          min={1}
          max={65535}
          value={value?.publishPort ?? ''}
          placeholder="8080"
          onChange={(e) => {
            const n = e.target.value ? Number.parseInt(e.target.value, 10) : undefined;
            onChange({
              ...(value ?? { aliases: [] }),
              publishPort: Number.isFinite(n) ? n : undefined,
            });
          }}
        />
      </Field>
      <Field label="Network aliases" hint="Internal network names this service joins">
        <ChipInput
          value={value?.aliases ?? []}
          onChange={(aliases) => onChange({ ...(value ?? {}), aliases })}
          placeholder="internal-mesh"
        />
      </Field>
    </div>
  );
}
