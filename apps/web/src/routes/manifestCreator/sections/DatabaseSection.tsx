import { useQuery } from '@tanstack/react-query';
import type { Database } from '@ninedeploy/schemas';
import { api } from '../../../lib/api.js';
import { cn, Field, Input } from '../../../components/ui.js';

export function DatabaseSection({
  value,
  onChange,
}: {
  value: Database | undefined;
  onChange: (next: Database | undefined) => void;
}) {
  // Managed-DB slugs are the attach key, so offer the live list instead of
  // making the operator type a slug from memory. The query failing (no
  // permission, offline) just means no suggestions — manual entry keeps
  // working either way.
  const databases = useQuery({
    queryKey: ['databases-for-manifest'],
    queryFn: () => api.databases.list(),
    staleTime: 30_000,
  });
  const suggestions = databases.data ?? [];
  const ref = value?.ref ?? '';
  return (
    <div className="space-y-4">
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500">Managed databases:</span>
          {suggestions.map((db) => {
            const active = ref === db.slug;
            return (
              <button
                key={db.slug}
                type="button"
                aria-label={`Use ${db.slug} (${db.engine})`}
                aria-pressed={active}
                onClick={() => onChange({ ref: db.slug, env: value?.env ?? 'DATABASE_URL' })}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ring-1 ring-inset transition',
                  active
                    ? 'bg-indigo-500/15 text-indigo-200 ring-indigo-500/30'
                    : 'bg-white/[0.03] text-slate-400 ring-white/[0.08] hover:bg-white/[0.06] hover:text-slate-200',
                )}
              >
                {db.slug}
                <span className="font-mono text-[10px] text-slate-500">{db.engine}</span>
              </button>
            );
          })}
        </div>
      )}
      <Field
        label="Managed DB slug"
        hint="The slug of a managed database in this instance (run `ninedeploy databases list` to find one)"
      >
        <Input
          value={ref}
          placeholder="app-db"
          onChange={(e) => {
            const v = e.target.value.trim();
            if (!v) {
              onChange(undefined);
              return;
            }
            onChange({ ref: v, env: value?.env ?? 'DATABASE_URL' });
          }}
        />
      </Field>
      <Field
        label="Connection-string env key"
        hint="The key the app reads for the connection (default: DATABASE_URL)"
      >
        <Input
          value={value?.env ?? ''}
          placeholder="DATABASE_URL"
          disabled={!value?.ref}
          onChange={(e) => onChange({ ref: value?.ref ?? '', env: e.target.value || 'DATABASE_URL' })}
        />
      </Field>
    </div>
  );
}
