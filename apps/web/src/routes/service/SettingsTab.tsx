import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, GitPullRequest, Layers, Server, Settings, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { dockerBuildTarget, formatDockerLabels, parseDockerLabels } from '@ninedeploy/schemas';
import type { Service, ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { toInt } from '../../lib/format.js';
import { fill, useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, cn, ErrorCard, Field, Input, Select, Skeleton, Switch, Textarea } from '../../components/ui.js';
import { ServiceTagsCard } from './ServiceTagsCard.js';
import { GithubCard } from './GithubCard.js';
import { BuildPlacementCard, OrchestratorCard } from './PlacementCards.js';
import { BuildArgsField, parseBuildArgNames } from './BuildArgsField.js';
import { ContainerOptionsCard } from './ContainerOptionsCard.js';
import { CanaryCard } from './CanaryCard.js';
import { AutoscaleCard } from './AutoscaleCard.js';
import { SizingCard } from './SizingCard.js';
import { PendingChangesTray } from './PendingChangesTray.js';
import { SleepCard } from './SleepCard.js';
import { StatusBadgeCard } from './StatusBadgeCard.js';
import { DeployHookCard } from './DeployHookCard.js';
import { PrimaryRecoveryCard } from './PrimaryRecoveryCard.js';
import { SwarmRecoveryCard } from './SwarmRecoveryCard.js';
import { FanoutRecoveryCard } from './FanoutRecoveryCard.js';

/** Service fields, build configuration, lifecycle hooks, PR previews, and resource limits. */
export function SettingsTab({ serviceId, svc }: { serviceId: number; svc: ServiceDetail }) {
  return (
    <div className="mt-5 space-y-5">
      {/* G5.2: staged edits, reviewed and applied together. */}
      <PendingChangesTray serviceId={serviceId} />
      <SettingsCard serviceId={serviceId} />
      <GithubCard svc={svc} />
      <TagsCard serviceId={serviceId} svc={svc} />
      <PreviewEnvironmentsCard svc={svc} />
      <TargetNodeCard svc={svc} />
      {svc.type === 'docker' && <PrimaryRecoveryCard serviceId={serviceId} />}
      {svc.type === 'docker' && <SwarmRecoveryCard serviceId={serviceId} />}
      {svc.type === 'docker' && <FanoutRecoveryCard serviceId={serviceId} />}
      {/* Multi-node: Build → placement and image transfers; Runtime → Swarm. Both hide on an older panel. */}
      <BuildPlacementCard svc={svc} />
      <OrchestratorCard svc={svc} />
      <LimitsCard svc={svc} />
      {/* G5.6: suggestions from the metric history, under the limits they are about. */}
      <SizingCard serviceId={serviceId} />
      <ContainerOptionsCard svc={svc} />
      {/* 0.16.9: docker services on a panel that reports the field. */}
      <CanaryCard svc={svc} />
      <StatusBadgeCard serviceId={serviceId} serviceName={svc.name} />
      <DeployHookCard serviceId={serviceId} />
      <ScalingCard svc={svc} />
      {/* 0.16.10: next to Scaling, whose replicas it manages while on. */}
      <AutoscaleCard svc={svc} />
      {/* 0.16.11 scale to zero: docker services on a panel that reports the field. */}
      <SleepCard svc={svc} />
    </div>
  );
}

/**
 * Project / workspace / label tags for a service. The same component used
 * by the top-bar filter chips, just anchored to a single service. Read-only
 * for non-operators (members can see which tags apply, but not change them).
 */
export function TagsCard({ serviceId }: { serviceId: number; svc: Service }) {
  const t = useT();
  // Fetch the resolved tag rows from the dedicated tags endpoint so the
  // editor sees the same names / slugs / colors the rest of the UI uses.
  // The service detail response is a leaner subset.
  const tagsQuery = useQuery({
    queryKey: ['service-tags', serviceId],
    queryFn: () => api.serviceTags.get(serviceId),
  });
  const tags = tagsQuery.data;
  const initial = {
    projects: (tags?.projects ?? []).map((p) => ({
      id: p.id,
      workspaceId: null as number | null,
      workspaceName: null as string | null,
      name: p.name,
      slug: p.slug,
      description: null as string | null,
      serviceCount: 0,
      databaseCount: 0,
      createdAt: '',
      updatedAt: '',
    })),
    workspaces: (tags?.workspaces ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      description: null as string | null,
      ownerId: 0,
      myRole: 'viewer' as const,
      serviceCount: 0,
      projectCount: 0,
      memberCount: 0,
      createdAt: '',
      updatedAt: '',
    })),
    labels: (tags?.labels ?? []).map((l) => ({
      id: l.id,
      workspaceId: null as number | null,
      name: l.name,
      color: l.color,
      serviceCount: 0,
      createdAt: '',
      updatedAt: '',
    })),
  };
  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-center gap-2">
          <Tag size={14} className="text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-200">{t('Tags')}</h2>
          <span className="text-xs text-slate-500">
            {t('Where this service appears in the workspace, which project groups it, and the labels that classify it.')}
          </span>
        </div>
        {/* r562: the editor PUTs the WHOLE tag set on every change. Mounted
            before the tags loaded, its seeded (empty) initial data made the
            service look untagged — and one toggle or "Create & add" then
            replaced every real project / workspace / label tag. */}
        {tags ? (
          <ServiceTagsCard serviceId={serviceId} initial={initial} />
        ) : tagsQuery.isError ? (
          <ErrorCard title={t('Could not load the service tags')} error={tagsQuery.error} onRetry={() => void tagsQuery.refetch()} />
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </CardBody>
    </Card>
  );
}

// ── Settings (service fields + build config + lifecycle hooks) ─────────────
function SettingsCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.isOperator === true;
  const service = useQuery({ queryKey: ['service', serviceId], queryFn: () => api.services.get(serviceId) });
  // Credential list is admin-only server-side; members see the attached name
  // read-only instead of a select that would 403 on load.
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.sources.list(),
    enabled: isAdmin,
  });
  const svc = service.data;

  // Auto-update is a standalone toggle (not part of the big form): flipping
  // it takes effect immediately, like the server's other watchdogs.
  const autoUpdateMutation = useMutation({
    mutationFn: (enabled: boolean) => api.services.update(serviceId, { autoUpdate: enabled }),
    onSuccess: (_res, enabled) => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      toast(enabled ? t('Auto-update enabled') : t('Auto-update disabled'), 'success');
    },
    onError: () => toast(t('Could not change auto-update'), 'error'),
  });

  // r347: deployment lane. The server has always accepted `environmentId`
  // on PATCH, but nothing in the panel sent it, so every lane counted 0
  // services. Saved immediately, like auto-update. The lane list is
  // readable by any seat (scoped server-side to the caller's workspaces).
  const lanes = useQuery({ queryKey: ['environments'], queryFn: () => api.environments.list() });
  const laneMutation = useMutation({
    mutationFn: (environmentId: number | null) => api.services.update(serviceId, { environmentId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['environments'] });
      toast(t('Deployment lane updated'), 'success');
    },
    onError: () => toast(t('Could not change the deployment lane'), 'error'),
  });

  const [form, setForm] = useState<{
    name: string; branch: string; repoUrl: string; image: string; port: string;
    healthPath: string; healthTimeout: string; healthCheck: string; healthCommand: string; dockerLabels: string; gitLfs: boolean; volumeMount: string; sourceId: string;
    buildPack: string; baseDir: string; installCmd: string; buildCmd: string; startCmd: string; dockerfilePath: string; outputDir: string;
    preDeployCmd: string; postDeployCmd: string; preStopCmd: string;
    restartPolicy: string; stopGraceSeconds: string; buildArgs: string; buildTarget: string;
  } | null>(null);
  useEffect(() => {
    if (!svc || form) return;
    setForm({
      name: svc.name,
      branch: svc.branch,
      repoUrl: svc.repoUrl ?? '',
      image: svc.image ?? '',
      port: svc.port ? String(svc.port) : '',
      healthPath: svc.healthPath ?? '',
      healthTimeout: svc.healthTimeoutSeconds != null ? String(svc.healthTimeoutSeconds) : '',
      healthCheck: svc.healthCheck ?? 'http',
      healthCommand: svc.healthCommand ?? '',
      dockerLabels: formatDockerLabels(svc.dockerLabels),
      gitLfs: svc.gitLfs === true,
      volumeMount: svc.volumeMount ?? '',
      sourceId: svc.sourceId ? String(svc.sourceId) : '',
      buildPack: svc.build?.buildPack ?? 'auto',
      baseDir: svc.build?.baseDir ?? '/',
      installCmd: svc.build?.installCmd ?? '',
      buildCmd: svc.build?.buildCmd ?? '',
      startCmd: svc.build?.startCmd ?? '',
      dockerfilePath: svc.build?.dockerfilePath ?? '',
      outputDir: svc.build?.outputDir ?? '',
      preDeployCmd: svc.build?.preDeployCmd ?? '',
      postDeployCmd: svc.build?.postDeployCmd ?? '',
      preStopCmd: svc.build?.preStopCmd ?? '',
      restartPolicy: svc.build?.restartPolicy ?? 'unless-stopped',
      stopGraceSeconds: String(svc.build?.stopGraceSeconds ?? 5),
      buildArgs: (svc.build?.buildArgs ?? []).join(', '),
      buildTarget: svc.build?.buildTarget ?? '',
    });
  }, [svc, form]);

  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      // Omit empty service fields the schema cannot take blank (repo URL,
      // port, health path).
      const orUndef = <T,>(v: T) => (v === '' ? undefined : v);
      // r341: image and volume mount accept '' as "unset" (every consumer
      // reads them truthily). A field emptied by the user is sent as '' so
      // the server actually drops the old value — omitting it kept the old
      // mount while Save reported success. A field that was never set stays
      // omitted.
      const clearable = (v: string, stored: string | null | undefined) => (v === '' && !stored ? undefined : v);
      return api.services.update(serviceId, {
        name: f.name,
        branch: f.branch,
        repoUrl: orUndef(f.repoUrl),
        image: clearable(f.image, svc?.image),
        port: orUndef(f.port) ? toInt(f.port) : undefined,
        healthPath: orUndef(f.healthPath),
        // 0.16.1: blank restores the 300 s default. Sent only once the panel
        // reported the field, so an older server never sees it.
        healthTimeoutSeconds:
          svc?.healthTimeoutSeconds !== undefined ? (f.healthTimeout.trim() ? toInt(f.healthTimeout, 300) : null) : undefined,
        // 0.16.1, docker services on a panel that reports it; sent only when changed.
        healthCheck: svc?.healthCheck !== undefined && f.healthCheck !== svc.healthCheck ? (f.healthCheck as 'http' | 'running' | 'command' | 'http-strict' | 'tcp') : undefined,
        // 0.16.3, same rule; blank clears it.
        healthCommand: svc?.healthCommand !== undefined && f.healthCommand.trim() !== (svc.healthCommand ?? '') ? f.healthCommand.trim() || null : undefined,
        gitLfs: svc?.gitLfs !== undefined && f.gitLfs !== svc.gitLfs ? f.gitLfs : undefined,
        // 0.16.3, same rule: sent only when the parsed labels changed.
        dockerLabels:
          svc?.dockerLabels !== undefined && formatDockerLabels(parseDockerLabels(f.dockerLabels).labels) !== formatDockerLabels(svc.dockerLabels)
            ? parseDockerLabels(f.dockerLabels).labels
            : undefined,
        volumeMount: clearable(f.volumeMount, svc?.volumeMount),
        // Admins may attach or clear the credential; members keep the current
        // one (an omitted key leaves it untouched server-side).
        sourceId: isAdmin ? (f.sourceId ? toInt(f.sourceId) : null) : undefined,
        build: {
          buildPack: f.buildPack as 'auto' | 'nixpacks' | 'dockerfile' | 'static',
          baseDir: f.baseDir,
          // r205: build fields are prefilled, so a blank one is a deliberate
          // clear — sent as '' (the server stores it as null). They used to
          // be omitted, so a start command or pre-deploy hook, once set, could
          // never be removed from the panel.
          installCmd: f.installCmd,
          buildCmd: f.buildCmd,
          startCmd: f.startCmd,
          dockerfilePath: f.dockerfilePath,
          outputDir: f.outputDir,
          // Non-admins never see these fields, so they must not send them
          // either: an omitted key leaves whatever an admin stored intact.
          preDeployCmd: isAdmin ? f.preDeployCmd : undefined,
          postDeployCmd: isAdmin ? f.postDeployCmd : undefined,
          preStopCmd: isAdmin ? f.preStopCmd : undefined,
          restartPolicy: f.restartPolicy,
          stopGraceSeconds: toInt(f.stopGraceSeconds, 5)!,
          // 0.16.1. Sent only once the panel reported the field, so saving
          // against an older server never sends a key it would ignore.
          buildArgs: svc?.build?.buildArgs !== undefined ? parseBuildArgNames(f.buildArgs).names : undefined,
          // 0.16.2, same rule; blank clears back to the last stage.
          buildTarget: svc?.build?.buildTarget !== undefined ? f.buildTarget.trim() : undefined,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(t('Settings saved — redeploy to apply'), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Could not save settings'), 'error'),
  });

  if (!svc || !form) return <Card><CardBody><Skeleton className="h-40 w-full" /></CardBody></Card>;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const buildTargetInvalid = form.buildTarget.trim() !== '' && !dockerBuildTarget.safeParse(form.buildTarget.trim()).success;
  const labelProblems = parseDockerLabels(form.dockerLabels).invalid;

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Settings size={15} className="text-slate-500" /> {t('Service settings')}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
        >
          <Field label={t('Name')}><Input value={form.name} onChange={set('name')} className="h-9" /></Field>
          <Field label={t('Branch')}><Input value={form.branch} onChange={set('branch')} className="h-9" /></Field>
          <Field label={t('Repo URL')}><Input value={form.repoUrl} onChange={set('repoUrl')} placeholder="https://github.com/…" className="h-9 font-mono text-xs" /></Field>
          {/* 0.16.3: shown once the panel reports the field, for repository services. */}
          {svc.gitLfs !== undefined && !!(svc.repoUrl || form.repoUrl) && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-inset ring-white/5 md:col-span-2">
              <div>
                <div className="text-xs font-medium text-slate-300">Git LFS</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {t("Fetch the repository's LFS files (models, media) after checkout, from its own HTTPS LFS server. The build runs on the panel host; on a node with no build placement set, the image is built there and shipped.")}
                </div>
              </div>
              <Switch checked={form.gitLfs} onChange={(v) => setForm({ ...form, gitLfs: v })} label="Git LFS" />
            </div>
          )}
          <Field label={t('Git credential (private repos)')} hint={t('Used for cloning, analysis and webhook deploys')}>
            {isAdmin ? (
              <Select value={form.sourceId} onChange={set('sourceId')} className="h-9">
                <option value="">{t('Public / none')}</option>
                {sources.data?.map((s) => (
                  <option key={s.id} value={String(s.id)}>{s.name} ({s.type})</option>
                ))}
              </Select>
            ) : (
              <Input value={svc.sourceName ?? t('public / none')} disabled className="h-9" title={t('Credentials are managed by admins under System → Sources')} />
            )}
          </Field>
          {lanes.data && (
            <Field label={t('Deployment lane')} hint={t('Saved immediately · manage lanes from Services → Lanes')}>
              <Select
                value={svc.environmentId != null ? String(svc.environmentId) : ''}
                onChange={(e) => laneMutation.mutate(e.target.value ? Number(e.target.value) : null)}
                disabled={laneMutation.isPending}
                className="h-9"
                aria-label={t('Deployment lane')}
              >
                <option value="">{t('None')}</option>
                {lanes.data
                  // Lanes live in a workspace: offer the ones of this
                  // service's workspace(s), plus whatever it is in now.
                  .filter(
                    (l) =>
                      (svc.workspaceIds ?? []).length === 0 ||
                      (svc.workspaceIds ?? []).includes(l.workspaceId) ||
                      l.id === svc.environmentId,
                  )
                  .map((l) => (
                    <option key={l.id} value={String(l.id)}>{l.name}</option>
                  ))}
              </Select>
            </Field>
          )}
          <Field label={t('Image (image deploys)')}><Input value={form.image} onChange={set('image')} placeholder="nginx:latest" className="h-9 font-mono text-xs" /></Field>
          {svc.image && svc.type === 'docker' && (
            <div className="col-span-full flex items-center justify-between gap-3 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
              <div>
                <div className="text-xs font-medium text-slate-300">{t('Auto-update (digest watch)')}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {svc.serverId != null
                    ? t("Every 30 minutes the registry is probed; when this image's tag moved, a normal deployment is queued through the usual health checks on its node. Enabling only sets a baseline — it never deploys by itself.")
                    : t("Every 30 minutes the registry is probed; when this image's tag moved, a normal deployment is queued through the usual health checks. Enabling only sets a baseline — it never deploys by itself.")}
                </div>
              </div>
              <Switch
                checked={svc.autoUpdate === true}
                onChange={(v) => autoUpdateMutation.mutate(v)}
                disabled={autoUpdateMutation.isPending}
                label={t('Auto-update')}
              />
            </div>
          )}
          <Field label={t('Container port (Traefik target)')}><Input value={form.port} onChange={set('port')} inputMode="numeric" autoComplete="off" placeholder="3000" className="h-9 font-mono text-xs" /></Field>
          <Field label={t('Health path')}><Input value={form.healthPath} onChange={set('healthPath')} placeholder="/" className="h-9 font-mono text-xs" /></Field>
          {svc.healthTimeoutSeconds !== undefined && (
            <Field label={t('Healthcheck timeout (seconds)')} hint={t('How long a deploy waits for the new container to answer, 10–3600. Blank = 300.')}>
              <Input value={form.healthTimeout} onChange={set('healthTimeout')} inputMode="numeric" placeholder="300" className="h-9 font-mono text-xs" />
            </Field>
          )}
          {svc.type === 'docker' && svc.healthCheck !== undefined && (
            <Field
              label={t('Healthcheck')}
              hint={t('Container running: the deploy only waits for the container to stay up 10 s, for services with no HTTP or TCP port (UDP game servers, VoIP, workers).')}
            >
              <Select value={form.healthCheck} onChange={set('healthCheck')} className="h-9" aria-label={t('Healthcheck')}>
                <option value="http">{t('Default healthcheck (legacy behaviour)')}</option>
                <option value="http-strict">{t('HTTP readiness (2xx / 3xx response)')}</option>
                <option value="tcp">{t('TCP readiness (port accepts connections)')}</option>
                <option value="running">{t('Container running (no port probe)')}</option>
                {/* 0.16.3, nodes and Swarm 0.16.4; shown once the panel reports the field. */}
                {svc.healthCommand !== undefined && (
                  <option value="command">{t('Command inside the container')}</option>
                )}
              </Select>
            </Field>
          )}
          {svc.type === 'docker' && svc.dockerLabels !== undefined && (
            <Field
              label={t('Docker labels')}
              hint={
                labelProblems.length > 0
                  ? t('Not a label: {labels} (key=value; ninedeploy.*, com.docker.* and traefik.* are reserved)', { labels: labelProblems.join(', ') })
                  : t('key=value per line, for tools on the host that read container labels. Routing is not affected. Applies on the next deploy.')
              }
            >
              <Textarea value={form.dockerLabels} onChange={set('dockerLabels')} rows={3} placeholder="com.example.team=payments" spellCheck={false} className="font-mono text-xs" />
            </Field>
          )}
          {svc.type === 'docker' && form.healthCheck === 'command' && (
            <Field
              label={t('Healthcheck command')}
              hint={
                svc.serverId != null
                  ? t("Runs as the container's Docker healthcheck (sh -c, every 5 s); the deploy waits until it reports healthy. Needs node agent 0.16.4+ and a shell in the image.")
                  : t('Run with sh -c inside the container until it exits 0, e.g. pg_isready -U app or curl -fsS localhost:3000/up. The image needs a shell.')
              }
            >
              <Input value={form.healthCommand} onChange={set('healthCommand')} placeholder="curl -fsS localhost:3000/up" className="h-9 font-mono text-xs" maxLength={1000} />
            </Field>
          )}
          <Field label={t('Volume mount')}><Input value={form.volumeMount} onChange={set('volumeMount')} placeholder="/app/data" className="h-9 font-mono text-xs" /></Field>

          <div className="col-span-full mt-2 border-t border-white/5 pt-4 text-xs font-medium uppercase tracking-wide text-slate-500">
            {t('Build configuration')}
          </div>
          <Field label={t('Build pack')}>
            <Select value={form.buildPack} onChange={set('buildPack')} className="h-9">
              <option value="auto">auto</option>
              <option value="nixpacks">nixpacks</option>
              <option value="dockerfile">dockerfile</option>
              {/* The static pack runs its build commands on the HOST, so the
                  API gates it behind operator — hide it from members rather
                  than offering a 403 on save. */}
              <option value="static" disabled={!isAdmin}>{isAdmin ? 'static' : t('static (admin only — runs on the host)')}</option>
              <option value="railpack">railpack</option>
              <option value="paketo">paketo (buildpacks)</option>
              <option value="heroku">heroku (buildpacks)</option>
            </Select>
          </Field>
          <Field label={t('Base directory')}><Input value={form.baseDir} onChange={set('baseDir')} className="h-9 font-mono text-xs" /></Field>
          {form.buildPack === 'static' && (
            <Field label={t('Output directory')} hint={t('Relative to base directory; served by nginx')}>
              <Input value={form.outputDir} onChange={set('outputDir')} placeholder="dist" className="h-9 font-mono text-xs" />
            </Field>
          )}
          <Field label={t('Install command')}><Input value={form.installCmd} onChange={set('installCmd')} placeholder="npm ci" className="h-9 font-mono text-xs" /></Field>
          <Field label={t('Build command')}><Input value={form.buildCmd} onChange={set('buildCmd')} placeholder="npm run build" className="h-9 font-mono text-xs" /></Field>
          <Field label={t('Start command')}><Input value={form.startCmd} onChange={set('startCmd')} placeholder="npm start" className="h-9 font-mono text-xs" /></Field>
          {/* The same column names the compose file for a git-repo compose
              service. An inline stack ignores it — it always deploys the YAML
              stored on the service (Compose File tab). */}
          <Field label={t('Dockerfile / compose file path')}><Input value={form.dockerfilePath} onChange={set('dockerfilePath')} placeholder="./Dockerfile" className="h-9 font-mono text-xs" /></Field>
          {/* Build arguments reach Dockerfile builds only; auto may resolve to one. */}
          {svc.type === 'docker' && (form.buildPack === 'auto' || form.buildPack === 'dockerfile') && svc.build?.buildArgs !== undefined && (
            <BuildArgsField serviceId={serviceId} value={form.buildArgs} onChange={(next) => setForm({ ...form, buildArgs: next })} />
          )}
          {svc.type === 'docker' && (form.buildPack === 'auto' || form.buildPack === 'dockerfile') && svc.build?.buildTarget !== undefined && (
            <Field
              label={t('Build stage')}
              hint={
                buildTargetInvalid
                  ? t('A stage name starts with a letter and holds letters, digits, _ . or -')
                  : t('For a multi-stage Dockerfile: the stage to build (docker build --target). Empty builds the last stage.')
              }
            >
              <Input value={form.buildTarget} onChange={set('buildTarget')} placeholder="runtime" aria-label={t('Build stage')} aria-invalid={buildTargetInvalid} className="h-9 font-mono text-xs" />
            </Field>
          )}

          {/* Lifecycle hooks execute binaries on the HOST (engine/pipeline.ts),
              so the API restricts them to admins. Showing them to a member
              would only produce a 403 on save. */}
          {isAdmin && (
            <>
              <div className="col-span-full mt-2 border-t border-white/5 pt-4 text-xs font-medium uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                <Layers size={13} className="text-indigo-400" /> {t('CI/CD Lifecycle Hooks')}
              </div>
              <div className="col-span-full rounded-lg border border-white/[0.05] bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-500 space-y-1">
                <p>
                  {fill(t('{order} pre-deploy runs right after the code checkout (before build) · post-deploy runs once the healthcheck passes and the new container is live · pre-stop during old-container shutdown.'), {
                    order: <span className="font-medium text-slate-300">{t('Order:')}</span>,
                  })}
                </p>
                <p>
                  {fill(t("Commands run on the HOST inside this service's repo directory and receive the full runtime env — including managed-database keys ({databaseUrl}, {wordpressDb}, …). That makes volume/repair one-liners possible, e.g. regenerating a baked config:"), {
                    databaseUrl: <code className="font-mono text-[10px] text-indigo-200">DATABASE_URL</code>,
                    wordpressDb: <code className="font-mono text-[10px] text-indigo-200">WORDPRESS_DB_*</code>,
                  })}
                </p>
                <code className="block overflow-x-auto rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-indigo-200">
                  docker run --rm -v nd-svc-web-html:/data alpine sh -c &quot;rm -f /data/wp-config.php&quot;
                </code>
                <p>
                  {fill(t('Pre-deploy failure {fails}; post-deploy failure is logged but non-fatal. Everything streams into the deployment log.'), {
                    fails: <span className="text-slate-300">{t('fails the deploy')}</span>,
                  })}
                </p>
                <p>
                  {fill(t('Fields take ONE command (argv-style) — wrap compound logic yourself, e.g. {example}.'), {
                    example: <code className="font-mono text-[10px] text-indigo-200">sh -c &quot;a &amp;&amp; b&quot;</code>,
                  })}
                </p>
              </div>
              <Field label={t('Pre-deploy command (e.g. DB migrations)')}>
                <Input value={form.preDeployCmd} onChange={set('preDeployCmd')} placeholder="npm run db:migrate" className="h-9 font-mono text-xs" />
              </Field>
              <Field label={t('Post-deploy command (e.g. cache warm-up)')}>
                <Input value={form.postDeployCmd} onChange={set('postDeployCmd')} placeholder="curl -sSL http://localhost:3000/api/warmup" className="h-9 font-mono text-xs" />
              </Field>
              <Field label={t('Pre-stop command')}>
                <Input value={form.preStopCmd} onChange={set('preStopCmd')} placeholder="npm run cleanup" className="h-9 font-mono text-xs" />
              </Field>
            </>
          )}
          <Field label={t('Restart policy')}>
            <Select value={form.restartPolicy} onChange={set('restartPolicy')} className="h-9">
              <option value="unless-stopped">unless-stopped</option>
              <option value="always">always</option>
              <option value="on-failure">on-failure</option>
              <option value="on-failure:5">{t('on-failure:5 (loop cap)')}</option>
              <option value="no">no</option>
            </Select>
          </Field>
          <Field label={t('Stop grace (seconds)')}>
            <Input value={form.stopGraceSeconds} onChange={set('stopGraceSeconds')} inputMode="numeric" placeholder="5" className="h-9 font-mono text-xs" />
          </Field>

          <div className="col-span-full">
            <Button type="submit" size="sm" disabled={save.isPending || parseBuildArgNames(form.buildArgs).invalid.length > 0 || buildTargetInvalid || labelProblems.length > 0 || (form.healthCheck === 'command' && !form.healthCommand.trim())}>
              {save.isPending ? t('Saving…') : t('Save settings')}
            </Button>
            <span className="ml-3 text-xs text-slate-500">{t('Build + runtime changes apply on the next deploy.')}</span>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

// ── Ephemeral PR / MR Preview Environments ─────────────────────────────────
function PreviewEnvironmentsCard({ svc }: { svc: Service }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [enabled, setEnabled] = useState(svc.previewDeploymentsEnabled ?? false);
  const [autoDestroy, setAutoDestroy] = useState(svc.previewAutoDestroyOnClose ?? true);
  // 0.16.12: each preview gets its own copies of the attached databases.
  const [dbCopy, setDbCopy] = useState(svc.previewDatabaseCopy ?? false);
  // 0.16.14: previews of PRs from forks (each deploy waits for approval).
  const [forks, setForks] = useState(svc.previewForks ?? false);
  const [pattern, setPattern] = useState(svc.previewDomainPattern ?? 'pr-{{pr}}-{{slug}}.{{domain}}');
  const [maxActive, setMaxActive] = useState(String(svc.previewMaxActive ?? 5));

  const save = useMutation({
    mutationFn: () =>
      api.services.update(svc.id, {
        previewDeploymentsEnabled: enabled,
        previewAutoDestroyOnClose: autoDestroy,
        previewDatabaseCopy: dbCopy,
        // Sent only to a panel that reports the setting (0.16.14 or later).
        ...(svc.previewForks !== undefined ? { previewForks: forks } : {}),
        // r205: an emptied pattern clears it (null) instead of being dropped.
        previewDomainPattern: pattern || null,
        previewMaxActive: parseInt(maxActive, 10) || 5,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(t('PR Preview settings saved'), 'success');
    },
    onError: () => toast(t('Could not save PR preview settings'), 'error'),
  });

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <GitPullRequest size={16} className="text-indigo-400" /> {t('Ephemeral PR / MR Preview Deployments')}
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-slate-700 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-indigo-600 peer-checked:after:translate-x-full peer-focus:outline-none" />
          </label>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          {t('Automatically provision isolated preview environments on Pull Request / Merge Request webhooks (GitHub, GitLab, Gitea), and destroy them upon merge or close.')}
        </p>

        {enabled && (
          <div className="grid grid-cols-1 gap-4 pt-2 md:grid-cols-2">
            <Field label={t('Preview Domain Pattern')} hint={t('Variables: {{pr}}, {{slug}}, {{domain}}')}>
              <Input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="pr-{{pr}}-{{slug}}.{{domain}}"
                className="h-9 font-mono text-xs"
              />
            </Field>
            <Field label={t('Max Active Previews')}>
              <Input
                value={maxActive}
                onChange={(e) => setMaxActive(e.target.value)}
                inputMode="numeric"
                placeholder="5"
                className="h-9 font-mono text-xs"
              />
            </Field>
            <div className="col-span-full">
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoDestroy}
                  onChange={(e) => setAutoDestroy(e.target.checked)}
                  className="rounded border-white/20 bg-slate-800 text-indigo-500 focus:ring-0"
                />
                {t('Auto-destroy ephemeral preview container and URL when PR is closed / merged')}
              </label>
            </div>
            <div className="col-span-full flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-slate-300">{t('Give each preview its own database copies')}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  {t('Each PR preview gets a copy of the attached PostgreSQL and Redis-family databases, made from the latest backup, and the copies are removed with the preview. MySQL, MariaDB and MongoDB are not copied yet.')}
                </p>
              </div>
              <Switch checked={dbCopy} onChange={setDbCopy} label={t('Give each preview its own database copies')} />
            </div>
            {svc.previewForks !== undefined && (
              <div className="col-span-full flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-slate-300">{t('Build pull requests from forks')}</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                    {t("A fork's pull request gets a preview too, but every one of its deploys waits for an admin to approve it, after reading the code. It is cloned without this service's Git credential, so only a public fork builds, and it gets no database copies and none of the secret preview-only values. Docker services only.")}
                  </p>
                </div>
                <Switch checked={forks} onChange={setForks} label={t('Build pull requests from forks')} />
              </div>
            )}
          </div>
        )}

        <div className="pt-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t('Saving…') : t('Save PR preview settings')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Target node ────────────────────────────────────────────────────────────
/**
 * Where this service runs: the panel host, or one of the registered nodes.
 *
 * The API has accepted `serverId` on create and update since the fleet feature
 * shipped and the panel offered no way to set it, so multi-node was reachable
 * only from the CLI or a raw API call. Now that a docker service pinned to a
 * node is genuinely built and started there, the field needs a home in the UI.
 *
 * Docker and Compose services can target a node; PM2 cannot, because it is a
 * host process the agent has no operation for. For PM2 the card explains the
 * limit instead of offering a choice that would only fail at deploy time.
 */
function TargetNodeCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  // Docker and Compose both run on a node. PM2 is a host process the agent has
  // no operation for, so offering the choice would only fail at deploy time.
  const swarm = svc.orchestrator === 'swarm' || svc.placement?.orchestrator === 'swarm';
  const remotable = !swarm && (svc.type === 'docker' || svc.type === 'compose');

  // Nodes are an operator-only listing; a member sees the current target as
  // read-only text rather than a select that would 403 on load.
  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.servers.list(),
    enabled: isOperator && remotable,
  });

  // Initialised once from the service row so a background refetch never fights
  // an edit in progress.
  const [target, setTarget] = useState(svc.serverId == null ? '' : String(svc.serverId));

  const save = useMutation({
    mutationFn: () => api.services.update(svc.id, { serverId: target === '' ? null : Number(target) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(t('Target saved — applied on the next deploy'), 'success');
    },
    onError: () => toast(t('Could not save the target node'), 'error'),
  });

  const currentName =
    svc.serverId == null
      ? t('this panel host')
      : (servers.data?.find((s) => s.id === svc.serverId)?.name ?? t('node #{id}', { id: svc.serverId }));

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Server size={15} className="text-slate-500" /> {t('Target node')}
        </div>

        {swarm ? (
          <p className="text-xs text-slate-500">
            {t('Swarm schedules replicas across its eligible nodes. Change the runtime in the Swarm card; a separate target host or additional-node fan-out does not apply to this service.')}
          </p>
        ) : !remotable ? (
          <p className="text-xs text-slate-500">
            {fill(t('PM2 services run on this panel host. They are host processes and the node agent has no operation for them, so a deploy pinned to a node would be refused. Remote nodes run {docker} and {compose} services.'), {
              docker: <code className="font-mono">docker</code>,
              compose: <code className="font-mono">compose</code>,
            })}
          </p>
        ) : !isOperator ? (
          <p className="text-xs text-slate-500">
            {fill(t('Runs on {host}. Only an instance operator can move a service between hosts.'), {
              host: <span className="text-slate-300">{currentName}</span>,
            })}
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            className="flex flex-wrap items-end gap-4"
          >
            <Field label={t('Runs on')}>
              <Select
                // `Field` renders its label as a span, not a <label>, so the
                // control carries its own accessible name.
                aria-label={t('Runs on')}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-9 w-64"
                disabled={servers.isLoading}
              >
                <option value="">{t('This panel host')}</option>
                {(servers.data ?? []).map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name} ({s.host}) {s.status === 'online' ? '' : `— ${s.status}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>
              {save.isPending ? t('Saving…') : t('Save target')}
            </Button>
          </form>
        )}

        {remotable && isOperator ? (
          <p className="mt-2 text-xs text-slate-500">
            {t('A node builds and runs the service itself and terminates TLS for its own domains, so point the DNS record at the node — not at this panel. Applied on the next deploy; the container on the previous host is not moved for you.')}
          </p>
        ) : null}

        {isOperator && !swarm && svc.type === 'docker' && (svc.image || svc.repoUrl) ? (
          <FanoutTargetsCard svc={svc} />
        ) : null}
      </CardBody>
    </Card>
  );
}

// ── Multi-server fan-out ───────────────────────────────────────────────────
export function FanoutTargetsCard({ svc }: { svc: Service }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api.servers.list() });
  const targets = useQuery({ queryKey: ['fanout-targets', svc.id], queryFn: () => api.fanout.get(svc.id) });
  const [selected, setSelected] = useState<number[] | null>(null);

  const save = useMutation({
    // r562: `set` REPLACES the target list — never send one built on top of a
    // list that failed to load (it would drop every existing target).
    mutationFn: () => {
      if (!targets.data) throw new Error('The current fan-out targets could not be loaded');
      return api.fanout.set(svc.id, selected ?? targets.data.map((ft) => ft.serverId));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fanout-targets', svc.id] });
      toast(t('Fan-out targets saved — applied on the next deploy'), 'success');
    },
    onError: () => toast(t('Could not save the fan-out targets'), 'error'),
  });

  const current = selected ?? targets.data?.map((ft) => ft.serverId) ?? [];
  const candidates = (servers.data ?? []).filter((s) => s.id !== svc.serverId);
  const dirty =
    selected != null &&
    (selected.length !== (targets.data?.length ?? 0) ||
      selected.some((id) => !targets.data?.some((ft) => ft.serverId === id)));

  const toggle = (id: number) =>
    setSelected(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);

  if ((servers.data ?? []).filter((s) => s.id !== svc.serverId).length === 0 && (targets.data ?? []).length === 0) {
    return null;
  }

  return (
    <div className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
        <Layers size={15} className="text-slate-500" /> {t('Run on additional nodes')}
      </div>
      <p className="mb-3 text-xs text-slate-500">
        {t("Each target node runs its own container of this release — the image is pulled there, or a Dockerfile repository is built from the same pinned commit. Point the domain's DNS at every node you select.")}
      </p>
      {targets.isLoading || servers.isLoading ? (
        <p className="text-xs text-slate-600">{t('Loading nodes…')}</p>
      ) : targets.isError && !targets.data ? (
        // r562: unloaded targets used to render as "all unchecked"; ticking one
        // node and saving then replaced every real target with just that one.
        <ErrorCard title={t('Could not load the fan-out targets')} error={targets.error} onRetry={() => void targets.refetch()} />
      ) : (
        <div className="space-y-1.5">
          {candidates.map((node) => {
            const active = current.includes(node.id);
            const target = targets.data?.find((ft) => ft.serverId === node.id);
            return (
              <label key={node.id} className="flex items-center gap-2 rounded-lg border border-white/[0.05] px-3 py-1.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggle(node.id)}
                  className="accent-indigo-500"
                  aria-label={t('Fan out to {name}', { name: node.name })}
                />
                {node.name}
                {target && (
                  <span className={cn('ml-auto font-mono text-[10px]', target.status === 'running' ? 'text-emerald-400' : 'text-rose-400')}>
                    {target.status}
                  </span>
                )}
              </label>
            );
          })}
          {candidates.length === 0 && <p className="text-xs text-slate-600">{t('No additional nodes registered.')}</p>}
        </div>
      )}
      {selected != null && dirty && (
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('Saving…') : t('Save fan-out targets')}
        </Button>
      )}
    </div>
  );
}

// ── Resource limits ────────────────────────────────────────────────────────
function LimitsCard({ svc }: { svc: Service }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  // Limits only reach a container on the docker run path. PM2 services are
  // host processes (memory maps to a restart threshold, CPU not enforceable);
  // compose services take their limits from the stack's own YAML.
  const isDocker = svc.type === 'docker';
  // Initialized once from the service row — later refetches never fight user edits.
  const [cpu, setCpu] = useState(String(svc.cpuShares || ''));
  // Stored in millicores (500 = 0.5 cores); the field takes decimal cores.
  const [cpuCap, setCpuCap] = useState(svc.cpuLimitMilli ? String(svc.cpuLimitMilli / 1000) : '');
  const [mem, setMem] = useState(String(svc.memLimitMb || ''));

  const save = useMutation({
    mutationFn: () => {
      const capCores = cpuCap.trim() ? Number(cpuCap.replace(',', '.')) : null;
      return api.limits.setService(svc.id, {
        cpuShares: isDocker && cpu.trim() ? toInt(cpu, 0) : null,
        cpuLimitMilli: isDocker && capCores != null && Number.isFinite(capCores) && capCores > 0 ? Math.round(capCores * 1000) : null,
        memLimitMb: mem.trim() ? toInt(mem, 0) : null,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['live-stats-snapshot'] });
      toast(res.liveApplied ? t('Limits saved and applied to the running container') : t('Limits saved — applied on next deploy'), 'success');
    },
    onError: () => toast(t('Could not save limits'), 'error'),
  });

  if (svc.type === 'compose') {
    return (
      <Card>
        <CardBody>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
            <Cpu size={15} className="text-slate-500" /> {t('Resource limits')}
          </div>
          <p className="text-xs text-slate-500">
            {fill(t("A compose stack manages its own containers — set resource limits under the service's {block} block in the stack YAML."), {
              block: <code className="font-mono">deploy.resources.limits</code>,
            })}
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Cpu size={15} className="text-slate-500" /> {t('Resource limits')}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="flex flex-wrap items-end gap-4"
        >
          {isDocker && (
            <>
              <Field label={t('CPU limit cores (0 = no cap)')}>
                <Input value={cpuCap} onChange={(e) => setCpuCap(e.target.value)} inputMode="decimal" placeholder={t('e.g. 0.5')} className="h-9 w-44 font-mono text-xs" />
              </Field>
              <Field label={t('CPU shares (weight under contention)')}>
                <Input value={cpu} onChange={(e) => setCpu(e.target.value)} inputMode="numeric" className="h-9 w-44 font-mono text-xs" />
              </Field>
            </>
          )}
          <Field label={t('Memory limit MiB (0 = unlimited)')}>
            <Input value={mem} onChange={(e) => setMem(e.target.value)} inputMode="numeric" className="h-9 w-44 font-mono text-xs" />
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={save.isPending}>
            {save.isPending ? t('Saving…') : t('Save limits')}
          </Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          {isDocker
            ? fill(
                t("CPU limit maps to Docker's {cpus} (a hard cap, e.g. 0.5 = half a core); shares map to {shares} (a relative weight, default 1024 — they matter only when the host is contended); memory to {memory} with swap pinned to the same value. Running containers get the new limits live where Docker allows it."),
                {
                  cpus: <code className="font-mono">--cpus</code>,
                  shares: <code className="font-mono">--cpu-shares</code>,
                  memory: <code className="font-mono">--memory</code>,
                },
              )
            : fill(
                t("PM2 processes run on the host — the memory limit maps to pm2's {key} (the process restarts gracefully above it, Docker-style hard caps do not apply). Applied on the next deploy."),
                { key: <code className="font-mono">max_memory_restart</code> },
              )}
        </p>
      </CardBody>
    </Card>
  );
}

// ── Horizontal scaling ─────────────────────────────────────────────────────
function ScalingCard({ svc }: { svc: Service }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [replicas, setReplicas] = useState(String(svc.replicas ?? 1));

  const save = useMutation({
    mutationFn: (count: number) => api.services.update(svc.id, { replicas: count }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(t('Replicas saved — applied on next deploy'), 'success');
    },
    onError: () => toast(t('Could not save replicas'), 'error'),
  });

  if (svc.type !== 'docker') {
    return null;
  }

  const desired = Math.max(1, Math.min(Math.floor(Number(replicas)) || 1, 10));
  // 0.16.10: with autoscaling saved, it sets the count; replicas applies again once it is off.
  const autoscale = svc.autoscale ?? null;

  return (
    <Card>
      <CardBody>
        <div className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
          <Layers size={15} className="text-slate-500" /> {t('Scaling')}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(desired);
          }}
          className="flex flex-wrap items-end gap-4"
        >
          <Field label={t('Replicas (1-10)')}>
            <Input
              value={replicas}
              onChange={(e) => setReplicas(e.target.value)}
              inputMode="numeric"
              disabled={autoscale != null}
              className="h-9 w-44 font-mono text-xs"
            />
          </Field>
          <Button type="submit" size="sm" variant="secondary" disabled={autoscale != null || save.isPending || desired === (svc.replicas ?? 1)}>
            {save.isPending ? t('Saving…') : t('Save replicas')}
          </Button>
        </form>
        {autoscale && (
          <p className="mt-2 text-xs text-indigo-200">
            {t('Managed by autoscaling: {min}–{max} containers, set in the Autoscaling card below. Replicas applies again from the next deploy after autoscaling is turned off.', {
              min: autoscale.minReplicas,
              max: autoscale.maxReplicas,
            })}
          </p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          {t('Each replica is a full container of the deployed release on the service bridge; Traefik round-robins across them and health-checks each one (a dead replica stops receiving traffic instead of erroring). New replicas start on the next deploy; crashed ones are revived automatically.')}
        </p>
      </CardBody>
    </Card>
  );
}
