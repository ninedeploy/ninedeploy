import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Field, Input } from '../../components/ui.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** "A, B\nC" → the names in order, once each, and the entries that are not env-var names. */
export function parseBuildArgNames(text: string): { names: string[]; invalid: string[] } {
  const names: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const name = raw.trim();
    if (!name) continue;
    if (!ENV_NAME.test(name)) invalid.push(name);
    else if (!names.includes(name)) names.push(name);
  }
  return { names, invalid };
}

/**
 * 0.16.1: which of the service's environment variables a Dockerfile build
 * receives as `--build-arg` (Coolify's "build variable"). Opt-in by name; the
 * service's variables are offered as one-click chips.
 */
export function BuildArgsField({
  serviceId,
  value,
  onChange,
}: {
  serviceId: number;
  value: string;
  onChange: (next: string) => void;
}) {
  // Same query key as the Environment tab's editor: one fetch, kept in sync.
  const env = useQuery({ queryKey: ['env', serviceId], queryFn: () => api.env.list(serviceId) });
  const { names, invalid } = parseBuildArgNames(value);
  const offered = (env.data ?? []).map((v) => v.key).filter((key) => !names.includes(key));
  const secretListed = (env.data ?? []).filter((v) => v.isSecret && names.includes(v.key)).map((v) => v.key);

  return (
    <div className="col-span-full">
      <Field
        label="Build arguments"
        hint="Variables a Dockerfile build receives as --build-arg (read them with ARG). Nixpacks, Railpack and buildpacks builds already see every variable."
        error={invalid.length > 0 ? `Not a variable name: ${invalid.join(', ')}` : undefined}
      >
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="NEXT_PUBLIC_API_URL, NODE_VERSION"
          aria-label="Build arguments"
          className="h-9 font-mono text-xs"
        />
        {offered.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {offered.slice(0, 24).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => onChange([...names, key].join(', '))}
                className="inline-flex items-center gap-1 rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-400 ring-1 ring-inset ring-white/10 transition hover:bg-indigo-500/10 hover:text-indigo-200"
                title={`Pass ${key} to the build`}
              >
                <Plus size={9} /> {key}
              </button>
            ))}
          </div>
        )}
        {secretListed.length > 0 && (
          <p className="mt-1 text-[11px] text-amber-300/90">
            {secretListed.join(', ')} {secretListed.length === 1 ? 'is a secret' : 'are secrets'}: build arguments stay readable in the
            image history. Use a BuildKit secret mount for credentials.
          </p>
        )}
      </Field>
    </div>
  );
}
