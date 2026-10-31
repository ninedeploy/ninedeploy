import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Play, Workflow } from 'lucide-react';
import type { CiJobView, CiPipeline } from '@ninedeploy/schemas';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { msg, useT } from '../../lib/i18n.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, ErrorCard, Field, Input, Skeleton, Switch, Textarea } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const LIVE: ReadonlyArray<CiJobView['status']> = ['awaiting_approval', 'queued', 'running'];

const STATUS: Record<CiJobView['status'], { label: string; tone: 'neutral' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'sky' }> = {
  awaiting_approval: { label: msg('Waiting for approval'), tone: 'amber' },
  queued: { label: msg('Queued'), tone: 'indigo' },
  running: { label: msg('Running'), tone: 'sky' },
  succeeded: { label: msg('Succeeded'), tone: 'emerald' },
  failed: { label: msg('Failed'), tone: 'rose' },
  cancelled: { label: msg('Cancelled'), tone: 'neutral' },
};
const TRIGGER: Record<string, string> = { manual: msg('manual'), push: msg('push'), deploy: msg('deploy gate') };

const words = (s: string) => s.split(/[\s,]+/).filter(Boolean);

/**
 * Service → CI (R5). The pipeline (an image and a script run on an enrolled
 * runner), its jobs, and each attempt's log. A PR preview is tested with its
 * parent's pipeline, so it shows jobs only.
 */
export function CiTab({ serviceId, isPreview }: { serviceId: number; isPreview: boolean }) {
  const t = useT();
  return (
    <div className="space-y-4">
      {isPreview ? (
        <Card>
          <CardBody className="text-sm text-slate-400">
            {t("This preview is tested with its parent service's pipeline. Its jobs get none of the service's variables, and a job for a pull request from a fork waits for an admin.")}
          </CardBody>
        </Card>
      ) : (
        <PipelineCard serviceId={serviceId} />
      )}
      <JobsCard serviceId={serviceId} canRun={!isPreview} />
    </div>
  );
}

function PipelineCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const query = useQuery({ queryKey: ['ci-pipeline', serviceId], queryFn: () => api.ci.pipeline(serviceId) });
  const [form, setForm] = useState<CiPipeline | null>(null);
  const [labels, setLabels] = useState('');
  const [secrets, setSecrets] = useState('');
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    const p = query.data.pipeline;
    setForm(
      p ?? {
        image: 'node:24-alpine',
        script: 'npm ci\nnpm test',
        labels: [],
        secrets: [],
        timeoutMinutes: 30,
        maxAttempts: 2,
        requireApproval: false,
        runOnPush: false,
        gateDeploys: false,
      },
    );
    setLabels((p?.labels ?? []).join(' '));
    setSecrets((p?.secrets ?? []).join(' '));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (p: CiPipeline) => api.ci.setPipeline(serviceId, { ...p, labels: words(labels), secrets: words(secrets) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ci-pipeline', serviceId] });
      toast(t('CI pipeline saved'), 'success');
    },
    onError: (err) => toast(t('Could not save the pipeline: {error}', { error: errorText(err) }), 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.ci.deletePipeline(serviceId),
    onSuccess: () => {
      setRemoving(false);
      void qc.invalidateQueries({ queryKey: ['ci-pipeline', serviceId] });
      toast(t('CI pipeline removed'), 'success');
    },
    onError: (err) => toast(t('Could not remove the pipeline: {error}', { error: errorText(err) }), 'error'),
  });

  if (query.isLoading || (query.data && !form)) return <Skeleton className="h-40" />;
  if (query.isError) return <ErrorCard title={t('Could not load the CI pipeline')} error={query.error} onRetry={() => void query.refetch()} />;
  if (!form) return null;
  const set = <K extends keyof CiPipeline>(key: K, value: CiPipeline[K]) => setForm({ ...form, [key]: value });
  const exists = !!query.data?.pipeline;

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center gap-2 font-semibold text-slate-200">
          <Workflow size={15} className="text-sky-300" /> {t('CI pipeline')}
        </div>
        <p className="text-xs text-slate-400">
          {t('Runs the script with sh -e in /workspace, in a container of this image, on an enrolled runner. The job gets the source without .git, and only the variables you name below.')}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Image')}>
            <Input value={form.image} onChange={(e) => set('image', e.target.value)} placeholder="node:24-alpine" />
          </Field>
          <Field label={t('Runner labels')} hint={t('A runner must carry every one of them')}>
            <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="linux" />
          </Field>
        </div>
        <Field label={t('Script')}>
          <Textarea rows={6} className="font-mono text-xs" value={form.script} onChange={(e) => set('script', e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('Variables for the job')} hint={t('Names of service variables; nothing else reaches the job')}>
            <Input value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder="NPM_TOKEN" />
          </Field>
          <Field label={t('Timeout (minutes)')}>
            <Input type="number" min={1} max={360} value={form.timeoutMinutes} onChange={(e) => set('timeoutMinutes', Number(e.target.value))} />
          </Field>
          <Field label={t('Attempts')} hint={t('Only when a runner is lost; a failing script is not retried')}>
            <Input type="number" min={1} max={5} value={form.maxAttempts} onChange={(e) => set('maxAttempts', Number(e.target.value))} />
          </Field>
        </div>
        <div className="space-y-2">
          <Switch checked={form.runOnPush} onChange={(v) => set('runOnPush', v)} label={t('Run on every push to the service branch')} />
          <Switch checked={form.gateDeploys} onChange={(v) => set('gateDeploys', v)} label={t('Deploy only what CI passed (also PR previews)')} />
          <Switch checked={form.requireApproval} onChange={(v) => set('requireApproval', v)} label={t('Every job waits for an admin to approve it')} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {exists && (
            <Button variant="secondary" onClick={() => setRemoving(true)} disabled={remove.isPending}>
              {t('Remove pipeline')}
            </Button>
          )}
          <Button onClick={() => save.mutate(form)} disabled={save.isPending || !form.image.trim() || !form.script.trim()}>
            {save.isPending ? t('Saving…') : t('Save pipeline')}
          </Button>
        </div>
      </CardBody>
      <ConfirmDialog
        open={removing}
        title={t('Remove the CI pipeline?')}
        message={t('New jobs stop; jobs already queued or running carry on. Deploys are no longer held for CI.')}
        confirmLabel={t('Remove')}
        onConfirm={() => remove.mutate()}
        onClose={() => setRemoving(false)}
      />
    </Card>
  );
}

function JobsCard({ serviceId, canRun }: { serviceId: number; canRun: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [ref, setRef] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const jobs = useQuery({
    queryKey: ['ci-jobs', serviceId],
    queryFn: () => api.ci.jobs.list(serviceId),
    refetchInterval: (q) => (q.state.data?.some((j) => LIVE.includes(j.status)) ? 3000 : 15_000),
  });
  const run = useMutation({
    mutationFn: () => api.ci.jobs.create(serviceId, ref.trim() ? { ref: ref.trim() } : {}),
    onSuccess: (job) => {
      setOpen(job.id);
      void qc.invalidateQueries({ queryKey: ['ci-jobs', serviceId] });
    },
    onError: (err) => toast(t('Could not start the job: {error}', { error: errorText(err) }), 'error'),
  });

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="font-semibold text-slate-200">{t('CI jobs')}</div>
          {canRun && (
            <div className="flex items-end gap-2">
              <Input className="w-48" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={t('Branch or commit (optional)')} />
              <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
                <Play size={13} /> {t('Run now')}
              </Button>
            </div>
          )}
        </div>
        {jobs.isLoading && <Skeleton className="h-10" />}
        {jobs.isError && <ErrorCard title={t('Could not load CI jobs')} error={jobs.error} onRetry={() => void jobs.refetch()} />}
        {jobs.data?.length === 0 && <p className="text-xs text-slate-500">{t('No job has run yet.')}</p>}
        <ul className="space-y-2">
          {jobs.data?.map((job) => (
            <li key={job.id} className="rounded-xl border border-white/[0.06]">
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-2 p-3 text-left"
                aria-expanded={open === job.id}
                onClick={() => setOpen(open === job.id ? null : job.id)}
              >
                <span className="font-medium text-slate-200">#{job.id}</span>
                <Badge tone={STATUS[job.status].tone}>{t(STATUS[job.status].label)}</Badge>
                <span className="text-xs text-slate-400">{t(TRIGGER[job.trigger] ?? job.trigger)}</span>
                {job.deploymentId !== null && <span className="text-xs text-slate-400">{t('deploy #{id}', { id: job.deploymentId })}</span>}
                {job.commitSha && <code className="text-xs text-slate-400">{job.commitSha.slice(0, 7)}</code>}
                <span className="ml-auto text-xs text-slate-500">{formatDateTime(job.createdAt)}</span>
              </button>
              {open === job.id && <JobDetail serviceId={serviceId} jobId={job.id} />}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function JobDetail({ serviceId, jobId }: { serviceId: number; jobId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const detail = useQuery({
    queryKey: ['ci-job', serviceId, jobId],
    queryFn: () => api.ci.jobs.get(serviceId, jobId),
    refetchInterval: (q) => (q.state.data && LIVE.includes(q.state.data.job.status) ? 3000 : false),
  });
  const [attempt, setAttempt] = useState<number | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['ci-job', serviceId, jobId] });
    void qc.invalidateQueries({ queryKey: ['ci-jobs', serviceId] });
  };
  const approve = useMutation({
    mutationFn: () => api.ci.jobs.approve(serviceId, jobId),
    onSuccess: refresh,
    onError: (err) => toast(t('Could not approve the job: {error}', { error: errorText(err) }), 'error'),
  });
  const cancel = useMutation({
    mutationFn: () => api.ci.jobs.cancel(serviceId, jobId),
    onSuccess: refresh,
    onError: (err) => toast(t('Could not cancel the job: {error}', { error: errorText(err) }), 'error'),
  });

  if (detail.isLoading) return <Skeleton className="m-3 h-16" />;
  if (detail.isError) return <ErrorCard title={t('Could not load the job')} error={detail.error} onRetry={() => void detail.refetch()} />;
  const data = detail.data;
  if (!data) return null;
  const { job, attempts } = data;
  const shown = attempt ?? attempts.at(-1)?.number ?? null;

  return (
    <div className="space-y-3 border-t border-white/[0.06] p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <code>{job.image}</code>
        {job.ref && <span>{t('ref {ref}', { ref: job.ref })}</span>}
        {job.error && <span className="text-rose-300">{job.error}</span>}
        <span className="ml-auto flex gap-2">
          {job.status === 'awaiting_approval' && (
            <Button size="sm" onClick={() => approve.mutate()} disabled={approve.isPending}>
              {t('Approve')}
            </Button>
          )}
          {LIVE.includes(job.status) && (
            <Button size="sm" variant="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              {t('Cancel')}
            </Button>
          )}
        </span>
      </div>
      {attempts.length === 0 && <p className="text-xs text-slate-500">{t('Waiting for a runner to take the job.')}</p>}
      {attempts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attempts.map((a) => (
            <Button key={a.id} size="sm" variant={a.number === shown ? 'primary' : 'secondary'} onClick={() => setAttempt(a.number)}>
              {t('Attempt {n}', { n: a.number })} · {a.status}
              {a.runnerName ? ` · ${a.runnerName}` : ''}
            </Button>
          ))}
        </div>
      )}
      {shown !== null && <AttemptLog key={shown} serviceId={serviceId} jobId={jobId} attempt={shown} />}
    </div>
  );
}

/** Follows an attempt's log by byte offset until the attempt is over. */
function AttemptLog({ serviceId, jobId, attempt }: { serviceId: number; jobId: number; attempt: number }) {
  const t = useT();
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const pre = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let stopped = false;
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const slice = await api.ci.jobs.log(serviceId, jobId, attempt, { offset });
        if (stopped) return;
        offset = slice.size;
        if (slice.data) setText((prev) => prev + slice.data);
        setError(null);
        if (!slice.done) timer = setTimeout(() => void poll(), 2000);
      } catch (err) {
        if (stopped) return;
        setError(err);
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [serviceId, jobId, attempt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the log as it grows.
  useEffect(() => {
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="space-y-1">
      {error !== null && <p className="text-xs text-rose-300">{t('Could not read the log: {error}', { error: errorText(error) })}</p>}
      <pre ref={pre} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-3 font-mono text-[11px] text-slate-300">
        {text || t('No output yet.')}
      </pre>
    </div>
  );
}
