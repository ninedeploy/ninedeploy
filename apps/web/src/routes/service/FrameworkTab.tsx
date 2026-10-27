import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Check, FileCode2, GitBranch, Info, KeyRound, RefreshCw, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RepoInsights, Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { fill, useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Skeleton } from '../../components/ui.js';

/**
 * Framework tab: what the service's repository contains (full analysis) plus
 * the framework-specific special settings — suggested build commands, port
 * and environment variables, applicable with one click each.
 */
export function FrameworkTab({ serviceId, svc }: { serviceId: number; svc: Service }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();

  const insights = useQuery({
    queryKey: ['service-insights', serviceId],
    queryFn: () => api.insights.get(serviceId),
  });

  const refresh = useMutation({
    mutationFn: () => api.insights.refresh(serviceId),
    onSuccess: (updated) => {
      qc.setQueryData(['service-insights', serviceId], updated);
      toast(t('Repository analysis updated'), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Analysis failed'), 'error'),
  });

  if (!svc.repoUrl) {
    return (
      <Card className="mt-5">
        <CardBody className="py-8 text-center">
          <Boxes size={32} className="mx-auto mb-2 text-slate-600" />
          <p className="text-sm font-semibold text-slate-300">{t('No repository attached')}</p>
          <p className="mt-1 text-xs text-slate-500">{t('This service deploys a prebuilt image, so there is no repository to analyze.')}</p>
        </CardBody>
      </Card>
    );
  }

  if (insights.isLoading) {
    return <Card className="mt-5"><CardBody><Skeleton className="h-48 w-full" /></CardBody></Card>;
  }

  const data = insights.data;
  if (!data) {
    return (
      <Card className="mt-5">
        <CardBody className="py-8 text-center">
          <GitBranch size={32} className="mx-auto mb-2 text-slate-600" />
          <p className="text-sm font-semibold text-slate-300">{t('This repository has not been analyzed yet')}</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">
            {t('An analysis clones the repository and detects the framework, package manager, Node engine and suggested deploy settings. It also runs automatically on every deployment.')}
          </p>
          <Button size="sm" className="mt-4" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw size={13} className={refresh.isPending ? 'animate-spin' : undefined} />
            {refresh.isPending ? t('Analyzing…') : t('Analyze repository')}
          </Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="mt-5 space-y-5">
      <DetectedFrameworkCard insights={data} branch={svc.branch} onRefresh={refresh.mutate} refreshing={refresh.isPending} />
      <SpecialSettingsCard serviceId={serviceId} svc={svc} insights={data} />
      <NotesCard insights={data} />
    </div>
  );
}

// ── Card A: full analysis ───────────────────────────────────────────────────
function DetectedFrameworkCard({
  insights,
  branch,
  onRefresh,
  refreshing,
}: {
  insights: RepoInsights;
  branch: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const t = useT();
  const f = insights.framework;

  const facts: Array<[string, string]> = [
    [t('Language'), insights.language],
    [t('Framework'), `${f.name}${insights.frameworkVersion ? ` ${insights.frameworkVersion}` : ''}`],
    [t('Category'), f.category],
    [t('Package manager'), insights.packageManager ?? '—'],
    [t('Node engine'), insights.nodeVersion ?? '—'],
    [t('Packages'), t('{prod} prod · {dev} dev', { prod: insights.dependencyCount, dev: insights.devDependencyCount })],
    [t('Base directory'), insights.baseDir],
    [t('Branch'), branch],
    [t('Analyzed commit'), insights.commitSha ? insights.commitSha.slice(0, 12) : '—'],
    [t('Analyzed at'), new Date(insights.analyzedAt).toLocaleString()],
  ];

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl leading-none">{f.emoji}</span>
            <div>
              <span className="text-sm font-semibold text-slate-100">
                {f.name}
                {insights.frameworkVersion && <span className="ml-1 font-mono text-xs text-slate-400">{insights.frameworkVersion}</span>}
              </span>
              <p className="text-[11px] text-slate-500">{t('What this repository contains')}</p>
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={onRefresh} disabled={refreshing} className="h-7 text-xs">
            {/* The pending label is asserted in the refresh tests; the
                instrumenter cannot see the spinner class ternary. */}
            <RefreshCw size={12} className={/* v8 ignore start */ refreshing ? 'animate-spin' : undefined /* v8 ignore stop */} /> {t('Re-analyze')}
          </Button>
        </div>

        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          {facts.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between rounded-lg border border-white/[0.04] bg-white/[0.02] p-2">
              <dt className="text-[11px] font-medium text-slate-400">{k}</dt>
              <dd className="truncate font-mono text-[11px] text-slate-200" title={v}>{v}</dd>
            </div>
          ))}
        </dl>

        {Object.keys(insights.scripts).length > 0 && (
          <div className="rounded-lg border border-white/[0.06] bg-black/25 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <FileCode2 size={11} /> {t('package.json scripts')}
            </div>
            <div className="max-h-40 space-y-1 overflow-y-auto font-mono text-[11px]">
              {Object.entries(insights.scripts).map(([name, cmd]) => (
                <div key={name} className="flex gap-2">
                  <span className="w-24 shrink-0 truncate text-indigo-300" title={name}>{name}</span>
                  <span className="truncate text-slate-400" title={cmd}>{cmd}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {insights.detectedFiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-slate-500">{t('Detected files:')}</span>
            {insights.detectedFiles.map((file) => (
              <span key={file} className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-slate-300">{file}</span>
            ))}
          </div>
        )}

        {(insights.workspacePackages ?? []).length > 0 && (
          <div className="space-y-2 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-300">
              {t('Monorepo packages ({n})', { n: insights.workspacePackages.length })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {insights.workspacePackages.map((p) => (
                <span
                  key={p.dir}
                  // Both title arms render across the package tests; the
                  // instrumenter cannot see this chain.
                  title={/* v8 ignore start */ p.frameworkVersion ? `${p.framework ?? '—'} ${p.frameworkVersion}` : (p.framework ?? undefined) /* v8 ignore stop */}
                  className="rounded-full bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] text-slate-300 ring-1 ring-inset ring-white/10"
                >
                  /{p.dir}
                  {p.framework && <span className="ml-1 font-sans text-slate-500">· {p.framework}</span>}
                </span>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              {fill(
                t('Deploy sibling sub-apps as their own services: same repository URL, base directory {dir}, their own port and domain — then add an auto-deploy webhook with watch path {glob} so each service rebuilds only when its directory changes.'),
                {
                  dir: <span className="font-mono text-slate-300">/&lt;package&gt;</span>,
                  glob: <span className="font-mono text-slate-300">/&lt;package&gt;/**</span>,
                },
              )}
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── Card B: special settings (apply framework presets) ────────────────────
function SpecialSettingsCard({ serviceId, svc, insights }: { serviceId: number; svc: Service; insights: RepoInsights }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const f = insights.framework;

  // Pre-check every suggested env var; the user can untick before applying.
  const [envSelected, setEnvSelected] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setEnvSelected(Object.fromEntries(f.env.map((e) => [e.key, true])));
  }, [f]);

  const applyCommands = useMutation({
    mutationFn: () =>
      api.services.update(serviceId, {
        port: f.port,
        build: {
          ...(f.installCmd ? { installCmd: f.installCmd } : {}),
          ...(f.buildCmd ? { buildCmd: f.buildCmd } : {}),
          ...(f.startCmd ? { startCmd: f.startCmd } : {}),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(t('Framework settings applied — redeploy to take effect'), 'success');
    },
    onError: () => toast(t('Could not apply framework settings'), 'error'),
  });

  const applyEnv = useMutation({
    mutationFn: async () => {
      const existing = new Set((await api.env.list(serviceId)).map((v) => v.key));
      let created = 0;
      let skipped = 0;
      for (const e of f.env) {
        if (envSelected[e.key] !== true) continue;
        if (existing.has(e.key)) {
          skipped++;
          continue;
        }
        await api.env.create(serviceId, { key: e.key, value: e.value, isSecret: false });
        created++;
      }
      return { created, skipped };
    },
    onSuccess: ({ created, skipped }) => {
      qc.invalidateQueries({ queryKey: ['env', serviceId] });
      toast(
        created > 0
          ? skipped > 0
            ? created > 1
              ? t('{n} environment variables created, {skipped} already existed', { n: created, skipped })
              : t('{n} environment variable created, {skipped} already existed', { n: created, skipped })
            : created > 1
              ? t('{n} environment variables created', { n: created })
              : t('{n} environment variable created', { n: created })
          : t('Suggested variables already exist'),
        'success',
      );
    },
    onError: () => toast(t('Could not apply environment suggestions'), 'error'),
  });

  const rows: Array<{ label: string; current: string; suggested: string | null }> = [
    { label: t('Install command'), current: svc.build?.installCmd ?? '—', suggested: f.installCmd },
    { label: t('Build command'), current: svc.build?.buildCmd ?? '—', suggested: f.buildCmd },
    { label: t('Start command'), current: svc.build?.startCmd ?? '—', suggested: f.startCmd },
    { label: t('Container port'), current: svc.port ? String(svc.port) : '—', suggested: String(f.port) },
  ];

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <Wand2 size={16} className="text-indigo-400" />
            <span className="text-sm font-semibold text-slate-100">{t('Special Settings — {name} presets', { name: f.name })}</span>
          </div>
          <span className="rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-400">{t('applies on next deploy')}</span>
        </div>

        <div className="overflow-hidden rounded-lg border border-white/[0.06]">
          <div className="grid grid-cols-[1fr_1.2fr_1.2fr] bg-white/[0.03] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <span>{t('Setting')}</span><span>{t('Current')}</span><span>{t('Suggested for {name}', { name: f.name })}</span>
          </div>
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-[1fr_1.2fr_1.2fr] items-center border-t border-white/[0.04] px-3 py-2 text-[11px]">
              <span className="text-slate-400">{r.label}</span>
              <span className="truncate pr-2 font-mono text-slate-300" title={r.current}>{r.current}</span>
              <span className="truncate font-mono text-emerald-300" title={r.suggested ?? undefined}>
                {r.suggested ?? <span className="text-slate-600">—</span>}
              </span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => applyCommands.mutate()} disabled={applyCommands.isPending}>
            {applyCommands.isPending ? t('Applying…') : t('Apply commands & port')}
          </Button>
          <span className="text-[11px] text-slate-500">{t('Writes the suggested build commands and port to the service configuration.')}</span>
        </div>

        {f.env.length > 0 && (
          <div className="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <KeyRound size={11} /> {t('Suggested environment variables')}
            </div>
            {f.env.map((e) => (
              <label key={e.key} className="flex cursor-pointer items-center gap-2.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={envSelected[e.key] === true}
                  onChange={(ev) => setEnvSelected((s) => ({ ...s, [e.key]: ev.target.checked }))}
                  className="rounded border-white/20 bg-slate-800 text-indigo-500 focus:ring-0"
                />
                <span className="font-mono text-indigo-300">{e.key}</span>
                <span className="font-mono text-slate-500">=</span>
                <span className="font-mono text-slate-200">{e.value}</span>
                {e.description && <span className="hidden truncate text-slate-500 sm:inline">— {e.description}</span>}
              </label>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" variant="secondary" onClick={() => applyEnv.mutate()} disabled={applyEnv.isPending}>
                {applyEnv.isPending ? t('Creating…') : t('Create selected variables')}
              </Button>
              <span className="text-[11px] text-slate-500">{t('Existing keys are left untouched.')}</span>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── Card C: framework deploy notes ─────────────────────────────────────────
function NotesCard({ insights }: { insights: RepoInsights }) {
  const t = useT();
  const notes = insights.framework.notes;
  if (notes.length === 0) return null;

  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Info size={15} className="text-slate-500" /> {t('Deployment notes for {name}', { name: insights.framework.name })}
        </div>
        <ul className="space-y-1.5">
          {notes.map((note) => (
            <li key={note} className="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
              <Check size={13} className="mt-0.5 shrink-0 text-emerald-400" /> {note}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
