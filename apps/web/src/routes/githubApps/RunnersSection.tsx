import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, Square } from 'lucide-react';
import type { GithubApp, GithubRunnerConfig } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { fill, useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Field, Input, Switch } from '../../components/ui.js';

/**
 * G4.5: self-hosted GitHub Actions runners for one App. Collapsed by default,
 * so the Sources page does not ask Docker for runner containers until an
 * operator opens it.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const splitList = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

interface Form {
  enabled: boolean;
  labels: string;
  maxConcurrent: string;
  cpus: string;
  memoryMb: string;
  allowPublicRepos: boolean;
  repositories: string;
}

const toForm = (c: GithubRunnerConfig): Form => ({
  enabled: c.enabled,
  labels: c.labels.join(', '),
  maxConcurrent: String(c.maxConcurrent),
  cpus: c.cpus == null ? '' : String(c.cpus),
  memoryMb: c.memoryMb == null ? '' : String(c.memoryMb),
  allowPublicRepos: c.allowPublicRepos,
  repositories: c.repositories.join('\n'),
});

const fromForm = (f: Form): GithubRunnerConfig => ({
  enabled: f.enabled,
  labels: splitList(f.labels),
  maxConcurrent: Number(f.maxConcurrent),
  cpus: f.cpus.trim() ? Number(f.cpus) : null,
  memoryMb: f.memoryMb.trim() ? Number(f.memoryMb) : null,
  allowPublicRepos: f.allowPublicRepos,
  repositories: splitList(f.repositories),
});

export function RunnersSection({ app }: { app: GithubApp }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-white/5 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Cpu size={12} /> {t('Self-hosted Actions runners')}
      </button>
      {open && <RunnersBody app={app} />}
    </div>
  );
}

function RunnersBody({ app }: { app: GithubApp }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ['github-app-runners', app.id];
  const status = useQuery({ queryKey: key, queryFn: () => api.githubApps.runners(app.id), refetchInterval: 10_000 });
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (status.data && form === null) setForm(toForm(status.data.config));
  }, [status.data, form]);

  const save = useMutation({
    mutationFn: (config: GithubRunnerConfig) => api.githubApps.setRunners(app.id, config),
    onSuccess: (res) => {
      qc.setQueryData(key, res);
      setForm(toForm(res.config));
      toast(t('Runner settings saved'), 'success');
    },
    onError: (err) => toast(t('Could not save the runner settings: {error}', { error: errorText(err) }), 'error'),
  });
  const stop = useMutation({
    mutationFn: (name: string) => api.githubApps.stopRunner(app.id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (err) => toast(t('Could not stop the runner: {error}', { error: errorText(err) }), 'error'),
  });

  if (status.isError) {
    return <div className="mt-2 text-[11px] text-rose-300">{t('Could not load the runners: {error}', { error: errorText(status.error) })}</div>;
  }
  if (!status.data || !form) return null;
  const data = status.data;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(fromForm(form));
  };

  return (
    <div className="mt-3 space-y-4">
      <p className="text-[11px] leading-relaxed text-slate-500">
        {fill(
          t(
            'A workflow job whose {runsOn} names one of these labels gets a one-off runner container on the panel host. The runner has no Docker access, so jobs that use {container}, {services} or build images do not run here. Jobs from public repositories are refused unless you allow them: anyone can open a pull request there.',
          ),
          {
            runsOn: <code className="font-mono">runs-on</code>,
            container: <code className="font-mono">container:</code>,
            services: <code className="font-mono">services:</code>,
          },
        )}
      </p>

      {data.problems.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200" aria-label={t('Runner setup problems')}>
          {data.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} className="space-y-3" aria-label={t('Runner settings')}>
        <div className="flex items-center gap-3">
          <Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label={t('Run jobs on this panel')} />
          <span className="text-xs text-slate-300">{t('Run jobs on this panel')}</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('Labels')} hint={t('comma-separated; jobs ask for them with runs-on: [self-hosted, {label}]', { label: splitList(form.labels)[0] ?? 'ninedeploy' })}>
            <Input value={form.labels} onChange={(e) => set('labels', e.target.value)} placeholder="ninedeploy" />
          </Field>
          <Field label={t('Runners at once')}>
            <Input value={form.maxConcurrent} onChange={(e) => set('maxConcurrent', e.target.value)} inputMode="numeric" />
          </Field>
          <Field label={t('CPUs per runner')} hint={t('empty = no limit')}>
            <Input value={form.cpus} onChange={(e) => set('cpus', e.target.value)} inputMode="decimal" placeholder="2" />
          </Field>
          <Field label={t('Memory per runner (MB)')} hint={t('empty = no limit')}>
            <Input value={form.memoryMb} onChange={(e) => set('memoryMb', e.target.value)} inputMode="numeric" placeholder="4096" />
          </Field>
        </div>
        <Field label={t('Repositories')} hint={t('owner/repo, one per line; empty = every repository the App is installed on')}>
          <textarea
            value={form.repositories}
            onChange={(e) => set('repositories', e.target.value)}
            rows={2}
            className="w-full rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] text-slate-200 ring-1 ring-inset ring-white/10 focus:outline-none focus:ring-indigo-400/60"
            placeholder="acme/api"
          />
        </Field>
        <div className="flex items-center gap-3">
          <Switch checked={form.allowPublicRepos} onChange={(v) => set('allowPublicRepos', v)} label={t('Allow public repositories')} />
          <span className="text-xs text-slate-300">{t('Allow public repositories')}</span>
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? t('Saving…') : t('Save')}
          </Button>
        </div>
      </form>

      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t('Runners')}</div>
        {data.active.length === 0 && data.pending.length === 0 ? (
          <div className="text-[11px] text-slate-500">{t('No runner is running and no job is waiting.')}</div>
        ) : (
          <ul className="space-y-1.5 text-[11px]">
            {data.active.map((r) => (
              <li key={r.name} className="flex flex-wrap items-center gap-2">
                <Badge tone={r.state === 'running' ? 'emerald' : 'neutral'}>{r.state}</Badge>
                <span className="font-mono text-slate-300">{r.name}</span>
                {r.repo && <span className="text-slate-500">{r.repo}</span>}
                {r.startedAt && <span className="text-slate-600">{formatDateTime(r.startedAt)}</span>}
                <Button size="sm" variant="ghost" onClick={() => stop.mutate(r.name)} disabled={stop.isPending} aria-label={t('Stop {name}', { name: r.name })}>
                  <Square size={11} /> {t('Stop')}
                </Button>
              </li>
            ))}
            {data.pending.map((p) => (
              <li key={p.jobId} className="flex flex-wrap items-center gap-2">
                <Badge tone="amber">{t('waiting')}</Badge>
                <span className="text-slate-300">{p.jobName ?? t('job #{id}', { id: p.jobId })}</span>
                <span className="text-slate-500">{p.repo}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="break-all font-mono text-[10px] text-slate-600" title={t('Runner image')}>
        {data.image}
      </div>
    </div>
  );
}
