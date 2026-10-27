import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Layers } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { Card, CardBody, cn } from '../../components/ui.js';

/**
 * 0.16.1: the shared variables this service inherits from its projects, read
 * only. They reach the container at deploy time with the lowest precedence:
 * the service's own variable of the same name wins (marked "overridden").
 * Edited on the project (Projects → Shared variables, `/projects?env=<id>`).
 * Renders nothing for a service in no project.
 */
export function InheritedEnvCard({
  serviceId,
  projects,
}: {
  serviceId: number;
  projects: Array<{ id: number; name: string }>;
}) {
  const t = useT();
  const shared = useQueries({
    queries: projects.map((p) => ({
      queryKey: ['project-env', p.id],
      queryFn: () => api.projectEnv.list(p.id),
    })),
  });
  // Same key as the Environment editor above: one fetch, kept in sync.
  const own = useQuery({ queryKey: ['env', serviceId], queryFn: () => api.env.list(serviceId) });
  if (projects.length === 0) return null;

  const ownKeys = new Set((own.data ?? []).map((v) => v.key));
  const rows = projects.flatMap((p, i) => (shared[i]?.data ?? []).map((v) => ({ ...v, project: p })));
  const loading = shared.some((q) => q.isLoading);

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Layers size={15} className="text-slate-500" /> {t('From projects')}
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          {t('Shared variables of {projects}. This service receives them on every deploy; its own variable with the same name wins.', {
            projects: projects.map((p) => p.name).join(', '),
          })}
        </p>
        {rows.length === 0 ? (
          <p className="py-1 text-xs text-slate-600">
            {loading ? t('Loading…') : t('None yet.')}{' '}
            {!loading && (
              <Link to={`/projects?env=${projects[0]!.id}`} className="text-indigo-300 hover:underline">
                {t('Add shared variables')}
              </Link>
            )}
          </p>
        ) : (
          <div className="space-y-1">
            {rows.map((v) => {
              const overridden = ownKeys.has(v.key);
              return (
                <div
                  key={`${v.project.id}-${v.id}`}
                  className="flex items-center gap-2 rounded-lg bg-white/[0.02] px-2 py-1.5 ring-1 ring-inset ring-white/5"
                >
                  <span
                    className={cn('w-32 shrink-0 truncate font-mono text-[11px] sm:w-48', overridden ? 'text-slate-500 line-through' : 'text-slate-200')}
                    title={v.key}
                  >
                    {v.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400" title={v.isSecret ? undefined : v.value}>
                    {v.isSecret ? t('•••• secret') : v.value}
                  </span>
                  {overridden && (
                    <span className="shrink-0 rounded bg-amber-500/10 px-1.5 text-[10px] text-amber-300" title={t('This service sets its own value')}>
                      {t('overridden')}
                    </span>
                  )}
                  <Link
                    to={`/projects?env=${v.project.id}`}
                    className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-slate-500 hover:text-indigo-300"
                    title={t('Edit in {project}', { project: v.project.name })}
                  >
                    {v.project.name} <ArrowUpRight size={10} />
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
