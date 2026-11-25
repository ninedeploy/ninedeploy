import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { importPlan, type ImportPlan, type PlanIssue, type PlanService } from '@ninedeploy/schemas';
import { api, getApiSessionGeneration } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { checkImportTarget } from '../lib/importTarget.js';
import { matchesPreparedImportEntry, preparedImportTargets, prepareImportResources, readImportPreparation, type ImportOperator } from '../lib/prepareImportResources.js';
import { MigrationDomainCutover } from './MigrationDomainCutover.js';
import { MigrationEnvironment } from './MigrationEnvironment.js';
import { MigrationImportStatus } from './MigrationImportStatus.js';
import { MigrationReadiness } from './MigrationReadiness.js';
import { Button, Input, Modal } from './ui.js';

const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 25;

type Review = { status: 'empty' | 'loading' } | { status: 'ready'; plan: ImportPlan; selection: number } | { status: 'error'; message: string };

export function ImportPlanReview({ onClose, operator }: { onClose: () => void; operator: ImportOperator | null }) {
  const t = useT();
  const fileInput = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const running = useRef(false);
  const [review, setReview] = useState<Review>({ status: 'empty' });
  const [preparing, setPreparing] = useState(false);
  const setRunning = (value: boolean) => {
    running.current = value;
    setPreparing(value);
  };

  const readFile = async (file: File) => {
    const current = ++selection.current;
    if (file.size > MAX_PLAN_BYTES) {
      setReview({ status: 'error', message: t('Choose a migration plan file of 2 MiB or less.') });
      return;
    }
    setReview({ status: 'loading' });
    try {
      const result = importPlan.safeParse(JSON.parse(await file.text()));
      if (current !== selection.current) return;
      setReview(result.success ? { status: 'ready', plan: result.data, selection: current } : { status: 'error', message: t('Choose a version 1 migration plan.') });
    } catch {
      if (current === selection.current) setReview({ status: 'error', message: t('Could not read this file as a migration plan.') });
    }
  };

  return (
    <Modal title={t('Review migration plan')} onClose={() => { if (!running.current) onClose(); }} initialFocusRef={fileInput} wide>
      <div className="space-y-4">
        <p className="text-sm text-slate-400">{t('Open the JSON plan saved by the CLI. The file stays in this browser.')}</p>
        <label className="block space-y-1.5 text-sm text-slate-200">
          <span>{t('Migration plan JSON')}</span>
          <Input ref={fileInput} type="file" accept=".json,application/json" disabled={preparing} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file && !running.current) void readFile(file);
          }} />
        </label>
        {review.status === 'loading' && <p role="status" className="text-sm text-slate-400">{t('Reading migration plan…')}</p>}
        {review.status === 'error' && <p role="alert" className="text-sm text-red-300">{review.message}</p>}
        {review.status === 'ready' && <PlanPreview key={review.selection} plan={review.plan} operator={operator} onPreparing={setRunning} />}
      </div>
    </Modal>
  );
}

function displayLocation(value: string, hostOnly = false): string | null {
  try {
    const url = new URL(value);
    if (url.host) return hostOnly ? url.host : `${url.host}${url.pathname}`;
  } catch {
    // The source CLI also supports SCP-style Git locations.
  }
  const scp = /^(?:[^@/\s]+@)?([a-z\d.-]+):([^\s?#]+)$/i.exec(value);
  if (!scp) return null;
  return hostOnly ? scp[1]! : `${scp[1]}/${scp[2]}`;
}

function PlanPreview({ plan, operator, onPreparing }: { plan: ImportPlan; operator: ImportOperator | null; onPreparing: (value: boolean) => void }) {
  const t = useT();
  return (
    <div className="space-y-4 border-t border-white/10 pt-4 text-sm [overflow-wrap:anywhere]">
      <dl className="space-y-1">
        <PlanField title={t('Source')} value={displayLocation(plan.source.url, true) ?? plan.source.kind} />
        <PlanField title={t('Scope')} value={plan.source.scope} />
        {plan.source.version && <PlanField title={t('Version')} value={plan.source.version} />}
      </dl>
      {operator && <TargetCheck key={`target:${operator.id}:${operator.createdAt}`} plan={plan} operator={operator} />}
      {operator && plan.services.length + plan.databases.length > 0 && (
        <PrepareResources key={`${operator.id}:${operator.createdAt}`} plan={plan} operator={operator} onPreparing={onPreparing} />
      )}
      <PlanItems title={t('Services ({count})', { count: plan.services.length })} items={plan.services} render={(service) => <ServicePlan service={service} />} />
      <PlanItems title={t('Databases ({count})', { count: plan.databases.length })} items={plan.databases} render={(database) => (
        <>
          <dl className="space-y-1">
            <PlanField title={t('Engine')} value={database.engine ?? t('Manual replacement required')} />
            {database.image && <PlanField title={t('Image')} value={database.image} />}
          </dl>
          <PlanIssues issues={database.issues} />
        </>
      )} />
      {plan.notes.length > 0 && <ul className="list-disc space-y-1 pl-4 text-slate-400">{plan.notes.map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}</ul>}
    </div>
  );
}

function TargetCheck({ plan, operator }: { plan: ImportPlan; operator: ImportOperator }) {
  const t = useT();
  const check = useMutation({
    mutationFn: async () => {
      const [services, databases] = await Promise.all([api.services.list(), api.databases.list()]);
      const serviceById = new Map(services.map((service) => [service.id, service]));
      const databaseById = new Map(databases.map((db) => [db.id, db]));
      const owned = new Set<string>();
      for (const entry of readImportPreparation(plan, operator)) {
        if (!entry.checkpoint) continue;
        const live = (entry.kind === 'service' ? serviceById : databaseById).get(entry.checkpoint.id);
        if (matchesPreparedImportEntry(entry, live)) owned.add(`${entry.kind}:${entry.ref}`);
      }
      return checkImportTarget(plan, { services, databases }, (kind, ref) => owned.has(`${kind}:${ref}`));
    },
  });
  const labels = {
    existingName: t('Target name already in use.'),
    repeatedName: t('Repeated target name in plan.'),
    repeatedRef: t('Repeated reference in plan.'),
    missingSource: t('Add an image or repository before applying.'),
    unsupportedEngine: t('Select a supported database engine before applying.'),
    invalidSettings: t('Review proposed settings.'),
  };

  return (
    <section aria-label={t('Target checks')} className="space-y-2 rounded-lg border border-white/10 p-3">
      <Button type="button" size="sm" variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>
        {check.isPending ? t('Checking target…') : t('Check target')}
      </Button>
      {check.isError && <p role="alert" className="text-red-300">{t('Could not read the target inventory. Try again.')}</p>}
      {check.isSuccess && (
        check.data.length === 0
          ? <p role="status" className="text-slate-300">{t('No naming or input problems found in this check.')}</p>
          : <PlanItems title={t('Review {count} planned resources', { count: check.data.length })} items={check.data} expanded render={(item) => (
            <>
              <p className="text-slate-400">{item.kind === 'service' ? t('Service') : t('Database')} · <code>{item.slug}</code></p>
              <ul className="list-disc space-y-1 pl-4 text-slate-300">
                {item.problems.map((problem) => <li key={problem}>{labels[problem]}</li>)}
              </ul>
              {!!item.fields?.length && <p className="font-mono text-xs text-slate-400">{[...new Set(item.fields)].join(', ')}</p>}
            </>
          )} />
      )}
      <p className="text-xs text-slate-500">{t('This checks names and settings. Review any matching resources before applying the plan.')}</p>
    </section>
  );
}

function PrepareResources({ plan, operator, onPreparing }: { plan: ImportPlan; operator: ImportOperator; onPreparing: (value: boolean) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const live = useRef(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const prepare = useMutation({
    mutationFn: (generation: number) => prepareImportResources(plan, operator, api, () => (
      live.current && getApiSessionGeneration() === generation
    )),
    onSettled: () => {
      onPreparing(false);
      for (const key of ['services', 'databases', 'dashboard']) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
  const labels = {
    prepared: t('Prepared'),
    occupied: t('Name in use. Review the existing resource.'),
    changed: t('Previously prepared resource changed or was removed. Review the target.'),
    skipped: t('Skipped. See Check target for details.'),
    failed: t('Request failed. Check the target before retrying.'),
    retainedVolume: t('A retained database volume uses this name. Review the volume before proceeding.'),
  };
  const outcomes = prepare.data?.duplicate === false ? prepare.data.outcomes : undefined;

  return (
    <section aria-label={t('Resource preparation')} className="space-y-2 rounded-lg border border-white/10 p-3">
      {confirming ? (
        <>
          <p className="text-slate-300">{t('Create service definitions and start empty databases on this panel as {email}.', { email: operator.email })}</p>
          <p className="text-slate-400">{t('Deployments, environment values, data transfer and domains are separate steps.')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => {
              onPreparing(true);
              setConfirming(false);
              prepare.mutate(getApiSessionGeneration());
            }}>{t('Create resources')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t('Cancel')}</Button>
          </div>
        </>
      ) : (
        <Button type="button" size="sm" variant="secondary" disabled={prepare.isPending} onClick={() => setConfirming(true)}>
          {prepare.isPending ? t('Preparing resources…') : t('Prepare resources')}
        </Button>
      )}
      {prepare.isError && <p role="alert" className="text-red-300">{t('Could not finish preparation. Check the target before retrying.')}</p>}
      {prepare.data?.duplicate && <p role="alert" className="text-red-300">{t('Resolve repeated names or references before preparing this plan.')}</p>}
      {outcomes && (
        <PlanItems title={t('Prepared {count} resources', { count: outcomes.filter(({ status }) => status === 'prepared').length })} items={outcomes} expanded render={(item) => (
          <p className={item.status === 'prepared' ? 'text-slate-300' : 'text-amber-300'}>
            {item.kind === 'service' ? t('Service') : t('Database')} · {labels[item.status]}
          </p>
        )} />
      )}
      {!prepare.isPending && <PreparedMigrationActions plan={plan} operator={operator} />}
    </section>
  );
}

function PreparedMigrationActions({ plan, operator }: { plan: ImportPlan; operator: ImportOperator }) {
  const t = useT();
  const candidates = preparedImportTargets(plan, operator);
  const databases = useQuery({
    queryKey: ['databases', 'migration-dump-targets', operator.id, operator.createdAt],
    queryFn: async () => (await api.databases.list()).map(({ id, slug, engine }) => ({ id, slug, engine })),
    enabled: candidates.entries.some(({ kind }) => kind === 'database'),
    staleTime: 0,
  });
  const services = useQuery({
    queryKey: ['services', 'migration-service-targets', operator.id, operator.createdAt],
    queryFn: () => api.services.list(),
    enabled: candidates.entries.some(({ kind }) => kind === 'service'),
    staleTime: 0,
  });
  if (!candidates.entries.length) return null;

  const databasesChecked = databases.isSuccess && !databases.isFetching;
  const servicesChecked = services.isSuccess && !services.isFetching;
  const databaseById = new Map((databasesChecked ? databases.data : []).map((db) => [db.id, db]));
  const serviceById = new Map((servicesChecked ? services.data : []).map((service) => [service.id, service]));
  const verifiedServices = new Set<number>();
  const verifiedDatabases = new Set<number>();
  const verified = [];
  const review = [];
  for (const entry of candidates.entries) {
    const { kind, checkpoint } = entry;
    if (!(kind === 'service' ? servicesChecked : databasesChecked)) continue;
    if (!checkpoint) {
      review.push({ ...entry, message: t('Creation could not be confirmed. Check the target before retrying.') });
      continue;
    }
    const live = (kind === 'service' ? serviceById : databaseById).get(checkpoint.id);
    if (!matchesPreparedImportEntry(entry, live)) {
      review.push({ ...entry, message: t('Previously prepared resource changed or was removed. Review the target.') });
      continue;
    }
    if (!checkpoint.done) {
      review.push({ ...entry, message: t('Preparation settings are incomplete. Review the target before retrying.') });
      continue;
    }
    verified.push(entry);
    (kind === 'service' ? verifiedServices : verifiedDatabases).add(checkpoint.id);
  }
  const unrecorded = plan.services.length + plan.databases.length - candidates.entries.length;
  const kindLabel = (kind: 'service' | 'database') => kind === 'service' ? t('Service') : t('Database');
  const isLocal = (service: NonNullable<ReturnType<typeof serviceById.get>>) => service.serverId == null && service.orchestrator !== 'swarm';
  const dumpTargets = candidates.databases.filter(({ id, slug, engine }) => {
    const db = databaseById.get(id);
    return verifiedDatabases.has(id) && db?.slug === slug && db.engine === engine;
  });
  const serviceTargets = candidates.services.filter(({ id, slug, service }) => {
    const svc = serviceById.get(id);
    return verifiedServices.has(id) && svc?.slug === slug && svc.type === service.create.type;
  });
  const verifiedVolumes = candidates.volumes.filter(({ id }) => verifiedServices.has(id));
  const verifiedDomains = candidates.domains.filter(({ id }) => verifiedServices.has(id));
  const volumeTargets = verifiedVolumes.filter(({ id, slug, volumeMount }) => {
    const svc = serviceById.get(id);
    return svc?.slug === slug && isLocal(svc) && svc.type === 'docker' && svc.volumeMount === volumeMount;
  });
  const domainTargets = verifiedDomains.filter(({ id, slug }) => {
    const svc = serviceById.get(id);
    return svc?.slug === slug && isLocal(svc);
  });
  const environmentTargets = serviceTargets.filter(({ service, bindings }) => service.env.length > 0 || bindings.length > 0);
  const actionsUnavailable = volumeTargets.length < verifiedVolumes.length || domainTargets.length < verifiedDomains.length;

  return (
    <div className="space-y-2 border-t border-white/10 pt-2">
      {(databases.isFetching || services.isFetching) && <p role="status" className="text-slate-400">{t('Checking prepared resources…')}</p>}
      {(databases.isError || services.isError) && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-red-300">{t('Could not read the target inventory. Try again.')}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => {
            if (databases.isError) void databases.refetch();
            if (services.isError) void services.refetch();
          }}>{t('Retry')}</Button>
        </div>
      )}
      {verified.length > 0 && <PlanItems title={t('Verified preparation ({count})', { count: verified.length })} items={verified} expanded
        render={({ kind }) => <p className="text-slate-400">{kindLabel(kind)}</p>} />}
      {review.length > 0 && <PlanItems title={t('Preparation needs review ({count})', { count: review.length })} items={review} expanded
        render={({ kind, message }) => <p className="text-amber-300">{kindLabel(kind)} · {message}</p>} />}
      {unrecorded > 0 && <p className="text-slate-400">{t('Resources without a preparation record ({count})', { count: unrecorded })}</p>}
      {environmentTargets.length > 0 && <PlanItems title={t('Migrate environment and connections')} items={environmentTargets.map((target) => ({ ...target, ref: target.service.ref }))} expanded
        render={(target) => <MigrationEnvironment plan={plan} target={target} />} />}
      {dumpTargets.length > 0 && <PlanItems title={t('Import database dumps')} items={dumpTargets.map((target) => ({ ...target, ref: String(target.id) }))} expanded render={({ id, name }) => (
        <MigrationImportStatus kind="database" id={id} name={name} />
      )} />}
      {volumeTargets.length > 0 && <PlanItems title={t('Import volume archives')} items={volumeTargets.map((target) => ({ ...target, ref: String(target.id) }))} expanded render={({ id, name }) => (
        <MigrationImportStatus kind="volume" id={id} name={name} />
      )} />}
      {serviceTargets.length > 0 && <PlanItems title={t('Review deployment readiness')} items={serviceTargets.map((target) => ({ ...target, ref: target.service.ref }))} expanded
        render={(target) => <MigrationReadiness target={target} />} />}
      {domainTargets.length > 0 && <PlanItems title={t('Cut over domains')} items={domainTargets.map((target) => ({ ...target, serviceName: target.name, name: target.host, ref: `${target.id}:${target.host}` }))} expanded
        render={({ id, serviceName, host, https, manual }) => manual ? <p className="text-slate-400">{t('This hostname needs manual routing review.')}</p> : (
          <MigrationDomainCutover serviceId={id} serviceName={serviceName} host={host} https={https} />
        )} />}
      {actionsUnavailable && <p className="text-amber-300">{t('Some prepared resources need routing or volume settings reviewed on the target.')}</p>}
    </div>
  );
}

function PlanItems<T extends { ref: string; name: string }>({ title, items, render, expanded }: { title: string; items: T[]; render: (item: T) => ReactNode; expanded?: boolean }) {
  const t = useT();
  const [shown, setShown] = useState(PAGE_SIZE);
  const nextCount = Math.min(items.length - shown, PAGE_SIZE);
  return (
    <section className="space-y-2">
      <h3 className="font-medium text-white">{title}</h3>
      {items.slice(0, shown).map((item, index) => (
        <details key={`${item.ref}:${index}`} open={expanded} className="rounded-lg border border-white/10 px-3 py-2">
          <summary className="cursor-pointer font-medium text-slate-200">{item.name}</summary>
          <div className="space-y-3 pt-2">{render(item)}</div>
        </details>
      ))}
      {nextCount > 0 && <Button type="button" size="sm" variant="ghost" onClick={() => setShown(shown + nextCount)}>{t('Show {count} more', { count: nextCount })}</Button>}
    </section>
  );
}

function ServicePlan({ service }: { service: PlanService }) {
  const t = useT();
  const { create } = service;
  const location = create.repoUrl && displayLocation(create.repoUrl);
  return (
    <>
      <dl className="space-y-1">
        <PlanField title={t('Type')} value={create.type} />
        {location && <PlanField title={t('Repository')} value={location} />}
        {create.branch && <PlanField title={t('Branch')} value={create.branch} />}
        {create.image && <PlanField title={t('Image')} value={create.image} />}
        {create.build?.buildPack && <PlanField title={t('Build pack')} value={create.build.buildPack} />}
        {create.build?.baseDir && <PlanField title={t('Base directory')} value={create.build.baseDir} />}
        {create.port != null && <PlanField title={t('Port')} value={create.port} />}
        {create.publishedPort != null && <PlanField title={t('Host Port')} value={create.publishedPort} />}
        {create.replicas != null && <PlanField title={t('Replicas')} value={create.replicas} />}
        {create.healthPath && <PlanField title={t('Healthcheck')} value={create.healthPath} />}
        {service.env.length > 0 && <PlanField title={t('Environment variable names')} value={service.env.map(({ key }) => key).join(', ')} />}
        {!!service.attachments?.length && (
          <PlanField title={t('Database attachments')} value={service.attachments.map(({ database, envAlias }) => `${envAlias} → ${database}`).join(', ')} />
        )}
      </dl>
      {service.domains.length > 0 && (
        <div>
          <h4 className="font-medium text-slate-300">{t('Domains')}</h4>
          <ul className="space-y-1 text-slate-400">{service.domains.map((domain, index) => (
            <li key={`${domain.host}:${index}`}><span>{domain.host}</span> · {domain.https ? 'HTTPS' : 'HTTP'}{domain.sourceDefault && <> · {t('Stays on the source')}</>}</li>
          ))}</ul>
        </div>
      )}
      {service.volumes.length > 0 && (
        <div>
          <h4 className="font-medium text-slate-300">{t('Volumes')}</h4>
          <ul className="space-y-1 text-slate-400">{service.volumes.map((volume, index) => (
            <li key={`${volume.mountPath}:${index}`}><span>{volume.mountPath}</span> · {volume.source}{volume.name && <> · {volume.name}</>}</li>
          ))}</ul>
        </div>
      )}
      <PlanIssues issues={service.issues} />
    </>
  );
}

function PlanIssues({ issues }: { issues: PlanIssue[] }) {
  const t = useT();
  const labels = { manual: t('Manual step'), unsupported: t('Unsupported'), info: t('Information') };
  if (!issues.length) return null;
  return (
    <ul className="space-y-2">
      {issues.map(({ detail, level, option }, index) => (
        <li key={`${option}:${index}`} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5">
          <strong className="block text-xs text-slate-300">{labels[level]} · {option}</strong>
          <span className="text-slate-400">{detail}</span>
        </li>
      ))}
    </ul>
  );
}

function PlanField({ title, value }: { title: string; value: ReactNode }) {
  return <div className="flex flex-wrap gap-x-2"><dt className="text-slate-400">{title}</dt><dd className="text-slate-200">{value}</dd></div>;
}
