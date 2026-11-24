import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import type { PreparedImportService } from '../lib/prepareImportResources.js';
import { Button } from './ui.js';

export function MigrationReadiness({ target }: { target: PreparedImportService }) {
  const t = useT();
  const check = useMutation({ mutationFn: () => api.deploys.migrationReadiness(target.id) });
  const live = check.data;
  const problems: Array<{ label: string; keys?: string[] }> = [];
  const plannedAliases = new Set(target.bindings.map(({ alias }) => alias));
  const plannedKeys = new Set(target.service.env.map(({ key }) => key));

  if (live) {
    if (live.id !== target.id || live.slug !== target.slug || live.type !== target.service.create.type || live.status === 'deleting') {
      problems.push({ label: t('Previously prepared resource changed or was removed. Review the target.') });
    } else {
      if (!live.hasSource) problems.push({ label: t('Configure a repository or image for this service.') });
      const configured = new Set(live.environmentKeys);
      const missing = [...plannedKeys].filter((key) => !plannedAliases.has(key) && !configured.has(key));
      if (missing.length) problems.push({ label: t('Planned environment keys missing on the target'), keys: missing });
      const managed = new Set(live.managedDatabaseKeys);
      const unready = target.bindings.filter(({ alias, database }) => {
        const matches = live.bindings.filter((item) => item.alias === alias);
        const [binding] = matches;
        return !database || matches.length !== 1 || !binding?.running || binding.databaseId !== database.id ||
          binding.slug !== database.slug || binding.engine !== database.engine || !managed.has(alias);
      });
      if (unready.length) problems.push({ label: t('Planned database connections to review'), keys: [...new Set(unready.map(({ alias }) => alias))] });
      if (live.volumeImportsPending || live.databaseImportsPending) problems.push({ label: t('Finish or cancel pending data imports before deploying.') });
      if (live.deploymentPending || live.status === 'deploying') problems.push({ label: t('A deployment is already queued, waiting or running.') });
    }
  }
  const references = live?.secretReferenceKeys.some((key) => plannedKeys.has(key)) ?? false;

  return (
    <section aria-label={t('Deployment readiness for {service}', { service: target.name })} className="space-y-2">
      <Button type="button" size="sm" variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? t('Checking deployment readiness…') : t('Check deployment readiness')}
      </Button>
      {check.isError && <p role="alert" className="text-red-300">{t('Could not check deployment readiness. Try again.')}</p>}
      {live && (problems.length ? (
        <ul role="status" className="list-disc space-y-1 pl-4 text-amber-300">
          {problems.map(({ label, keys }) => <li key={label}>{label}{keys && <div><code>{keys.join(', ')}</code></div>}</li>)}
        </ul>
      ) : (
        <div className="space-y-1">
          <p role="status" className="text-slate-200">{t('Planned configuration is ready for deployment.')}</p>
          <Link to={`/services/${target.id}?tab=deploys`} className="text-indigo-300 underline">{t('Open deployments')}</Link>
        </div>
      ))}
      {references && <p className="text-slate-400">{t('Secret references are resolved during deployment.')}</p>}
    </section>
  );
}
