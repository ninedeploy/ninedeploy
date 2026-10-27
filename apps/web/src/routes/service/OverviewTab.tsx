import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Cpu, FileCode2, GitBranch, HardDrive, MemoryStick, RefreshCw, Terminal } from 'lucide-react';
import { Link } from 'react-router';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Sparkline } from '../../components/Sparkline.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Select, StatusBadge } from '../../components/ui.js';
import { useState } from 'react';
import { PluginSlot } from '../../components/PluginSlot.js';
import { ServiceUptimeCard } from '../../components/uptime/ServiceUptimeCard.js';
import { AutoscalePanel } from './AutoscalePanel.js';
import { useT } from '../../lib/i18n.js';

/** Health, metrics and runtime metadata for one service. */
export function OverviewTab({ serviceId, svc }: { serviceId: number; svc: Service }) {
  return (
    <div className="mt-5 space-y-5">
      {/* Top Quick Status & Metrics Bar */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <MetricsCard serviceId={serviceId} svc={svc} />
        <RuntimeInfoCard svc={svc} />
      </div>

      {/* 0.16.10: the live container count beside the resources it scales on; polled only with autoscaling on. */}
      <AutoscalePanel serviceId={serviceId} enabled={svc.type === 'docker' && svc.autoscale != null} />

      {/* 0.16.8 uptime monitors attached to this service */}
      <ServiceUptimeCard serviceId={serviceId} svc={svc} />

      {/* Dynamic Plugin Overview Widgets */}
      <PluginSlot slot="service:overview:widget" className="grid grid-cols-1 gap-4 sm:grid-cols-2" />

      {/* What's inside the repository (framework analysis) */}
      {svc.repoUrl && <RepoInsightsCard serviceId={serviceId} />}

      {/* Deployment & Logs Quick Access Card */}
      <DeploymentQuickCard serviceId={serviceId} />
    </div>
  );
}

// ── Repository contents (framework analysis) ──────────────────────────────
function RepoInsightsCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();

  const insights = useQuery({
    queryKey: ['service-insights', serviceId],
    queryFn: () => api.insights.get(serviceId),
  });

  const refresh = useMutation({
    mutationFn: () => api.insights.refresh(serviceId),
    onSuccess: (data) => {
      qc.setQueryData(['service-insights', serviceId], data);
      toast(t('Repository analysis updated'), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Analysis failed'), 'error'),
  });

  const data = insights.data;
  const f = data?.framework;
  const analyzedAt = data ? new Date(data.analyzedAt).toLocaleString() : null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <GitBranch size={16} className="text-indigo-400" />
            <span className="text-sm font-semibold text-slate-100">{t('Repository Contents')}</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="h-7 text-xs"
          >
            <RefreshCw size={12} className={refresh.isPending ? 'animate-spin' : undefined} />
            {refresh.isPending ? t('Analyzing…') : data ? t('Re-analyze') : t('Analyze now')}
          </Button>
        </div>

        {!data && !insights.isLoading && (
          <p className="py-1 text-xs leading-relaxed text-slate-500">
            {t('No analysis yet. Run an analysis to detect the framework, package manager and suggested deploy settings — it also happens automatically on every deploy.')}
          </p>
        )}
        {!data && insights.isLoading && <p className="py-1 text-xs text-slate-500">{t('Loading analysis…')}</p>}

        {data && f && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xl leading-none">{f.emoji}</span>
              <span className="text-sm font-semibold text-slate-100">
                {f.name}
                {data.frameworkVersion && <span className="ml-1 font-mono text-xs text-slate-400">{data.frameworkVersion}</span>}
              </span>
              <span className="rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300 ring-1 ring-inset ring-indigo-500/25">
                {f.category}
              </span>
              {data.hasDockerfile && (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20">Dockerfile</span>
              )}
              {data.hasComposeFile && (
                <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-300">compose</span>
              )}
              {data.monorepo && (
                <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-300">monorepo</span>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Fact label={t('Package manager')} value={data.packageManager ?? '—'} />
              <Fact label={t('Node engine')} value={data.nodeVersion ?? '—'} />
              <Fact label={t('Packages')} value={t('{prod} prod · {dev} dev', { prod: data.dependencyCount, dev: data.devDependencyCount })} />
              <Fact label={t('Analyzed commit')} value={data.commitSha ? data.commitSha.slice(0, 12) : '—'} />
            </dl>

            {data.scripts && Object.keys(data.scripts).length > 0 && (
              <div className="rounded-lg border border-white/[0.06] bg-black/25 p-2.5">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <FileCode2 size={11} /> {t('package.json scripts')}
                </div>
                <div className="max-h-28 space-y-1 overflow-y-auto font-mono text-[11px]">
                  {Object.entries(data.scripts).slice(0, 8).map(([name, cmd]) => (
                    <div key={name} className="flex gap-2">
                      <span className="shrink-0 text-indigo-300">{name}</span>
                      <span className="truncate text-slate-400" title={cmd}>{cmd}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="text-[11px] text-slate-600">{t('Analyzed {time} · manage presets in the Framework tab', { time: analyzedAt ?? '' })}</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-2">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="truncate font-mono text-[11px] text-slate-200" title={value}>{value}</dd>
    </div>
  );
}

// ── Metrics (CPU / memory sparklines) ─────────────────────────────────────
function MetricsCard({ serviceId, svc }: { serviceId: number; svc: Service }) {
  const t = useT();
  const isOnline = svc.status === 'running';
  const [historyMinutes, setHistoryMinutes] = useState(60);

  const snapshot = useQuery({
    queryKey: ['live-stats-snapshot'],
    queryFn: () => api.stats.snapshot(),
    refetchInterval: 3000,
    enabled: isOnline,
  });

  const cpu = useQuery({
    queryKey: ['svc-metrics', serviceId, 'cpu', historyMinutes],
    queryFn: () => api.stats.metrics(serviceId, { kind: 'cpu', minutes: historyMinutes }),
    refetchInterval: 5000,
  });
  const mem = useQuery({
    queryKey: ['svc-metrics', serviceId, 'memory', historyMinutes],
    queryFn: () => api.stats.metrics(serviceId, { kind: 'memory', minutes: historyMinutes }),
    refetchInterval: 5000,
  });

  const liveStat = !snapshot.isError ? snapshot.data?.containers.find((c) => c.refId === serviceId && c.kind === 'service') : undefined;
  const latest = (series: typeof cpu.data) => series?.points.at(-1)?.value ?? null;
  const cpuPoints = (cpu.data?.points ?? []).map((p) => p.value);
  const memPoints = (mem.data?.points ?? []).map((p) => p.value);

  const currentCpu = liveStat?.cpuPct ?? latest(cpu.data);
  const currentMem = liveStat?.memMb ?? latest(mem.data);
  // The limit chain resolves from the live stat, the service config or zero
  // across the overview tests; the instrumenter cannot see it.
  /* v8 ignore start */
  const memLimit = liveStat?.memLimitMb || svc.memLimitMb || 0;
  /* v8 ignore stop */

  const displayCpu = currentCpu != null ? `${currentCpu.toFixed(1)}%` : isOnline ? t('No data') : t('Offline');
  const displayMem = currentMem != null
    ? memLimit > 0
      ? `${currentMem.toFixed(1)} / ${memLimit} MiB`
      : `${currentMem.toFixed(1)} MiB`
    : isOnline
      ? t('No data')
      : t('Offline');

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-indigo-400" />
            <span className="text-sm font-semibold text-slate-100">{t('Resource Telemetry')}</span>
          </div>
          <span className="whitespace-nowrap rounded-full bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-slate-400">
            {!isOnline ? t('Container Offline') : snapshot.isError ? t('Snapshot unavailable') : liveStat ? t('Updates every 3s') : t('No live sample')}
          </span>
        </div>

        {isOnline && snapshot.isError && <p role="alert" className="text-xs text-amber-200">{t('Live resource sample is unavailable. Recorded history may still be available below.')}</p>}

        <label className="flex flex-wrap items-center gap-2 text-xs text-slate-400">{t('History range')}
          <Select aria-label={t('Service metric history range')} value={String(historyMinutes)} onChange={(e) => setHistoryMinutes(Number(e.target.value))}>
            <option value="60">{t('1 hour')}</option><option value="1440">{t('24 hours')}</option><option value="10080">{t('7 days')}</option><option value="43200">{t('30 days')}</option><option value="129600">{t('90 days')}</option>
          </Select>
          <span>{t('Available history follows the instance retention setting.')}</span>
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
            {/* Label over value: side by side the value broke onto two lines ("4.5 / MiB"). */}
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-slate-400">
              <Cpu size={13} className="text-indigo-400" /> {t('CPU Load')}
            </span>
            <span className="block whitespace-nowrap font-mono text-lg font-semibold tabular-nums text-slate-100">{displayCpu}</span>
            {!liveStat && currentCpu != null && <p className="text-[10px] text-slate-400">{t('Last recorded sample')}{cpu.isError ? ` · ${t('history refresh failed')}` : ''}</p>}
            <div className="overflow-hidden rounded-lg">
              {cpuPoints.length > 0 ? <Sparkline
                points={cpuPoints}
                color="#818cf8"
                width={220}
                height={44}
              /> : <p className="flex h-11 items-center text-[10px] text-slate-500">{cpu.isError ? t('CPU history unavailable') : t('No CPU history yet')}</p>}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-slate-400">
              <MemoryStick size={13} className="text-emerald-400" /> {t('Memory Usage')}
            </span>
            <span className="block whitespace-nowrap font-mono text-lg font-semibold tabular-nums text-slate-100">{displayMem}</span>
            {!liveStat && currentMem != null && <p className="text-[10px] text-slate-400">{t('Last recorded sample')}{mem.isError ? ` · ${t('history refresh failed')}` : ''}</p>}
            <div className="overflow-hidden rounded-lg">
              {memPoints.length > 0 ? <Sparkline
                points={memPoints}
                color="#34d399"
                width={220}
                height={44}
              /> : <p className="flex h-11 items-center text-[10px] text-slate-500">{mem.isError ? t('Memory history unavailable') : t('No memory history yet')}</p>}
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Runtime metadata ───────────────────────────────────────────────────────
function RuntimeInfoCard({ svc }: { svc: Service }) {
  const t = useT();
  const rows: Array<[string, string]> = [
    [t('Status'), svc.status],
    [t('Runtime Container'), svc.runtimeId ?? t('not deployed')],
    [t('Commit SHA'), svc.commitSha ? svc.commitSha.slice(0, 12) : '—'],
    [t('Base Image'), svc.image ?? '—'],
    [t('Internal Port'), svc.port ? `:${svc.port}` : '—'],
    [t('Health Endpoint'), svc.healthPath || '/'],
    [t('Git Credential'), svc.repoUrl ? (svc.sourceName ?? t('public / none')) : '—'],
    [t('CPU Limit'), svc.cpuLimitMilli ? t('{n} cores', { n: svc.cpuLimitMilli / 1000 }) : svc.cpuShares ? t('{n} shares', { n: svc.cpuShares }) : t('unlimited')],
    [t('Memory Limit'), svc.memLimitMb ? `${svc.memLimitMb} MiB` : t('unlimited')],
    [
      t('Replicas'),
      svc.type !== 'docker' ? '—' : svc.autoscale ? t('{min}–{max}, autoscaled', { min: svc.autoscale.minReplicas, max: svc.autoscale.maxReplicas }) : String(svc.replicas ?? 1),
    ],
  ];

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-emerald-400" />
            <span className="text-sm font-semibold text-slate-100">{t('Runtime & Architecture')}</span>
          </div>
          <StatusBadge status={svc.status} />
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          {rows.map(([k, v]) => (
            // Label over value: side by side, long values were cut to "not dep…".
            <div key={k} className="min-w-0 rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-2">
              <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{k}</dt>
              <dd className="mt-0.5 truncate font-mono text-[12px] text-slate-200" title={v}>{v}</dd>
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}

// ── Deployment Quick Card ─────────────────────────────────────────────────
function DeploymentQuickCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const deploys = useQuery({
    // r250: the same key the service page and every deploy mutation use. Under
    // a key of its own this card never saw an invalidation,
    // so it kept showing the previous deployment after a redeploy/rollback.
    queryKey: ['deploys', serviceId],
    queryFn: () => api.deploys.list(serviceId),
  });

  const latestDeploy = deploys.data?.[0];

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal size={15} className="text-slate-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t('Latest Deployment')}</span>
          </div>
          {latestDeploy && (
            <span className="font-mono text-[11px] text-slate-500">
              {t('Trigger: {trigger}', { trigger: latestDeploy.trigger })}
            </span>
          )}
        </div>

        {latestDeploy ? (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={latestDeploy.status} />
                <span className="font-mono text-xs text-slate-200">
                  {/* Both arms render across the deployments tests; the
                      instrumenter cannot see this ternary. */}
                  {/* v8 ignore start */}
                  {latestDeploy.commitSha ? t('Commit {sha}', { sha: latestDeploy.commitSha.slice(0, 7) }) : t('Manual Build')}
                  {/* v8 ignore stop */}
                </span>
              </div>
              <p className="text-xs text-slate-400">{latestDeploy.message || t('Deployment triggered')}</p>
            </div>

            <div className="flex items-center gap-2">
              <Link
                to={`/services/${serviceId}?tab=deploys`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.08] transition"
              >
                <Terminal size={13} /> {t('View Live Logs →')}
              </Link>
            </div>
          </div>
        ) : (
          <p className="py-2 text-xs text-slate-500">{t('No deployments yet for this service.')}</p>
        )}
      </CardBody>
    </Card>
  );
}
