import type { StaticConfig } from '@ninedeploy/schemas';
import { Field, Input, Switch } from '../../../components/ui.js';
import { type Translate, fill, useT } from '../../../lib/i18n.js';

/** Mirror of the schema's root validation: relative, no `.`/`..` segments. */
function rootError(t: Translate, root: string): string | undefined {
  if (root === '') return undefined;
  if (root.startsWith('/')) return t('Must be a relative path — no leading slash.');
  if (root.split('/').some((segment) => segment === '..' || segment === '.')) {
    return t('Must not contain "." or ".." segments.');
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
  const t = useT();
  const root = value?.root ?? '';
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
        <div>
          <div className="text-sm font-medium text-slate-100">{t('SPA fallback')}</div>
          <div className="text-xs text-slate-500">
            {fill(t('Serve {file} for unknown routes (React, Vue, Svelte SPA).'), {
              file: <code className="font-mono text-[11px]">/index.html</code>,
            })}
          </div>
        </div>
        <Switch
          checked={value?.spa ?? false}
          onChange={(spa) => onChange({ spa, ...(value?.root ? { root: value.root } : {}) })}
        />
      </div>
      <Field
        label={t('Build output root')}
        hint={t('Path inside the container where static files are served from')}
        error={rootError(t, root)}
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
