import type { StaticConfig } from '@ninedeploy/schemas';
import { Field, Input, Switch } from '../../../components/ui.js';

/** Mirror of the schema's root validation: relative, no `.`/`..` segments. */
function rootError(root: string): string | undefined {
  if (root === '') return undefined;
  if (root.startsWith('/')) return 'Must be a relative path — no leading slash.';
  if (root.split('/').some((segment) => segment === '..' || segment === '.')) {
    return 'Must not contain "." or ".." segments.';
  }
  return undefined;
}

export function StaticSection({
  value,
  onChange,
}: {
  value: StaticConfig | undefined;
  onChange: (next: StaticConfig | undefined) => void;
}) {
  const root = value?.root ?? '';
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
        <div>
          <div className="text-sm font-medium text-slate-100">SPA fallback</div>
          <div className="text-xs text-slate-500">
            Serve <code className="font-mono text-[11px]">/index.html</code> for unknown routes (React, Vue, Svelte SPA).
          </div>
        </div>
        <Switch
          checked={value?.spa ?? false}
          onChange={(spa) => onChange({ spa, ...(value?.root ? { root: value.root } : {}) })}
        />
      </div>
      <Field
        label="Build output root"
        hint="Path inside the container where static files are served from"
        error={rootError(root)}
      >
        <Input
          value={root}
          placeholder="dist  /  build  /  public"
          disabled={!(value?.spa)}
          onChange={(e) =>
            onChange({ spa: value?.spa ?? false, root: e.target.value || undefined })
          }
        />
      </Field>
    </div>
  );
}
