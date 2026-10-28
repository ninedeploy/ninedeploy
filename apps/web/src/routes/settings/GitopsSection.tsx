import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';
import type { GitopsApplyStep, GitopsCheck, GitopsDriftItem, GitopsView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { msg, useT } from '../../lib/i18n.js';
import { Badge, Button, Card, CardBody, ErrorCard, Field, Input, Select, Skeleton, Switch } from '../../components/ui.js';

const CHANGE_LABEL: Record<GitopsDriftItem['change'], string> = {
  missing: msg('in the file only'),
  extra: msg('in the panel only'),
  changed: msg('different'),
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Settings → GitOps (G5.3, operator only). The instance's projects, services,
 * domains and project grants as one file in a repository: the drift between
 * the file and the panel, applying the file, and exporting the panel as the
 * file to commit. Applying never deletes.
 */
export function GitopsSection() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const view = useQuery({ queryKey: ['gitops'], queryFn: () => api.gitops.get() });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.sources.list() });
  const [form, setForm] = useState({ enabled: true, repoUrl: '', branch: 'main', path: 'ninedeploy-instance.yaml', sourceId: '', intervalMinutes: '15' });
  const [steps, setSteps] = useState<GitopsApplyStep[] | null>(null);
  useEffect(() => {
    const c = view.data?.config;
    if (c) setForm({ enabled: c.enabled, repoUrl: c.repoUrl, branch: c.branch, path: c.path, sourceId: c.sourceId ? String(c.sourceId) : '', intervalMinutes: String(c.intervalMinutes) });
  }, [view.data?.config]);

  const setCheck = (check: GitopsCheck) => qc.setQueryData<GitopsView>(['gitops'], (old) => ({ config: old?.config ?? null, lastCheck: check }));
  const save = useMutation({
    mutationFn: () =>
      api.gitops.configure({
        enabled: form.enabled,
        repoUrl: form.repoUrl.trim(),
        branch: form.branch.trim() || 'main',
        path: form.path.trim() || 'ninedeploy-instance.yaml',
        sourceId: form.sourceId ? Number(form.sourceId) : null,
        intervalMinutes: Number(form.intervalMinutes) || 0,
      }),
    onSuccess: (v) => {
      qc.setQueryData(['gitops'], v);
      toast(t('GitOps settings saved'), 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  const check = useMutation({
    mutationFn: () => api.gitops.check(),
    onSuccess: setCheck,
    onError: (err) => toast(errorText(err), 'error'),
  });
  const apply = useMutation({
    mutationFn: () => api.gitops.apply(),
    onSuccess: (r) => {
      setCheck(r.check);
      setSteps(r.steps);
      const failed = r.steps.filter((s) => !s.ok).length;
      toast(failed ? t('{n} step(s) failed', { n: failed }) : t('The file was applied'), failed ? 'error' : 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  const exportFile = useMutation({
    mutationFn: () => api.gitops.export(),
    onSuccess: ({ file }) => {
      const url = URL.createObjectURL(new Blob([file], { type: 'application/yaml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ninedeploy-instance.yaml';
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (err) => toast(errorText(err), 'error'),
  });

  if (view.isLoading) return <Skeleton className="h-40" />;
  if (view.isError) return <ErrorCard error={view.error} onRetry={() => void view.refetch()} />;
  const last = view.data?.lastCheck ?? null;
  const configured = !!view.data?.config;

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="space-y-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-slate-300">
            <GitMerge size={15} className="text-slate-500" /> {t('Instance GitOps')}
          </div>
          <p className="text-xs text-slate-500">
            {t('Projects, their services, domains and project grants as one YAML file in a repository. The panel reads it on a schedule, shows what differs and alerts when that changes. Applying creates and updates through the API; it never deletes. Secrets stay in the panel.')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Repository URL')}>
              <Input value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} placeholder="https://github.com/acme/infrastructure" />
            </Field>
            <Field label={t('Branch')}>
              <Input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
            </Field>
            <Field label={t('File path')}>
              <Input value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
            </Field>
            <Field label={t('Git source (private repositories)')}>
              <Select value={form.sourceId} onChange={(e) => setForm({ ...form, sourceId: e.target.value })}>
                <option value="">{t('None (public repository)')}</option>
                {(sources.data ?? []).map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('Check every (minutes, 0 = on request)')}>
              <Input type="number" min={0} max={1440} value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 self-end text-xs text-slate-400">
              <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={t('Scheduled checks')} /> {t('Scheduled checks')}
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !form.repoUrl.trim()}>
              {t('Save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => check.mutate()} disabled={!configured || check.isPending}>
              {check.isPending ? t('Checking…') : t('Check now')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => exportFile.mutate()} disabled={exportFile.isPending}>
              {t('Export the panel as the file')}
            </Button>
          </div>
        </CardBody>
      </Card>

      {last && (
        <Card>
          <CardBody className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-slate-300">
              <span className="font-medium">{t('Last check')}</span>
              <span className="text-xs text-slate-500">
                {formatDateTime(last.at)}
                {last.commit ? ` · ${last.commit.slice(0, 7)}` : ''}
              </span>
              {!last.error && <Badge tone={last.drift.length ? 'amber' : 'emerald'}>{last.drift.length ? t('{n} difference(s)', { n: last.drift.length }) : t('In sync')}</Badge>}
            </div>
            {last.error ? (
              <p className="text-xs text-rose-400" role="alert">
                {last.error}
              </p>
            ) : (
              last.drift.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {last.drift.map((d) => (
                    <li key={`${d.kind}:${d.key}:${d.change}`} className="flex flex-wrap gap-2">
                      <code className="font-mono text-slate-300">{d.key}</code>
                      <span className="text-slate-500">
                        {d.kind} · {t(CHANGE_LABEL[d.change])}
                      </span>
                      {d.fields?.map((f) => (
                        <span key={f.field} className="text-slate-500">
                          {f.field}: {String(f.actual ?? '—')} → {String(f.desired ?? '—')}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              )
            )}
            {!last.error && last.drift.some((d) => d.change !== 'extra') && (
              <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending}>
                {apply.isPending ? t('Applying…') : t('Apply the file')}
              </Button>
            )}
            {steps && steps.length > 0 && (
              <ul className="space-y-1 text-xs" aria-label={t('Applied steps')}>
                {steps.map((s, i) => (
                  <li key={i} className={s.ok ? 'text-slate-400' : 'text-rose-400'}>
                    {s.ok ? '✓' : '✗'} {s.item}
                    {s.error ? ` — ${s.error}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
