import { useQueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { CalendarClock, Clock, Copy, GitBranch, Plus, Trash2, Webhook } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api.js';
import { PRESETS, describeCron, isValidCron, nextCronRun, presetCron, WEEKDAY_LABELS } from '../../lib/cron.js';
import { formatDateTime, formatRelative, useCopy } from '../../lib/format.js';
import { AttachmentsCard } from '../../components/AttachmentsCard.js';
import { EnvCard } from '../../components/EnvCard.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Input, Skeleton, cn } from '../../components/ui.js';
import { SecretRow } from './SecretRow.js';

/** Environment variables, auto-deploy webhooks, file attachments and cron jobs. */
export function EnvironmentTab({ serviceId }: { serviceId: number }) {
  return (
    <div className="mt-5 grid max-w-6xl grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-5">
        <EnvCard serviceId={serviceId} />
        <WebhooksCard serviceId={serviceId} />
      </div>
      <div className="space-y-5">
        <AttachmentsCard serviceId={serviceId} />
        <JobsCard serviceId={serviceId} />
      </div>
    </div>
  );
}

// ── Webhooks ──────────────────────────────────────────────────────────────
function WebhooksCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [revealed, setRevealed] = useState<{ url: string; secret: string } | null>(null);
  const [watchPaths, setWatchPaths] = useState('');

  const hooks = useQuery({ queryKey: ['webhooks', serviceId], queryFn: () => api.webhooks.list(serviceId) });
  const create = useMutation({
    mutationFn: () => api.webhooks.create(serviceId, watchPaths.trim() ? { watchPaths: watchPaths.trim() } : undefined),
    onSuccess: (w) => {
      setRevealed({ url: w.url, secret: w.secret });
      setWatchPaths('');
      qc.invalidateQueries({ queryKey: ['webhooks', serviceId] });
    },
    onError: () => toast('Could not create the webhook', 'error'),
  });
  const remove = useMutation({
    mutationFn: (hookId: number) => api.webhooks.remove(serviceId, hookId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks', serviceId] }),
    onError: () => toast('Could not remove the webhook', 'error'),
  });

  const { copy } = useCopy();

  return (
    <Card>
      <CardBody>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Webhook size={15} className="text-slate-500" /> Auto-deploy
          </div>
          <Button size="sm" variant="secondary" onClick={() => create.mutate()} disabled={create.isPending}>
            <Plus size={14} /> New
          </Button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="mb-3"
        >
          <Input
            value={watchPaths}
            onChange={(e) => setWatchPaths(e.target.value)}
            placeholder="Watch paths (optional) — e.g. services/api/**, packages/**"
            className="h-8 font-mono text-[11px]"
          />
          <p className="mt-1 text-[10px] text-slate-600">
            Comma or newline separated globs. Only pushes touching these paths deploy (monorepo-friendly). Leave empty to deploy on every push.
          </p>
        </form>

        {revealed && (
          <div className="mb-3 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
            <p className="text-xs font-medium text-amber-200">
              Copy these now — the secret is shown only once.
            </p>
            <SecretRow label="Payload URL" value={revealed.url} />
            <SecretRow label="Secret" value={revealed.secret} />
            <button type="button"
              onClick={() => setRevealed(null)}
              className="text-xs text-amber-200/70 underline-offset-2 hover:underline"
            >
              I&apos;ve saved it
            </button>
          </div>
        )}

        {!hooks.isLoading && hooks.data?.some((w) => /\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(w.url)) && (
          <div className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-2.5 text-[11px] text-amber-200/90">
            These URLs point at <code className="font-mono">localhost</code> because no panel domain is set. Git
            providers can&apos;t reach that — set your real address under{' '}
            <Link to="/settings" className="font-medium underline underline-offset-2">Settings → Security</Link>{' '}
            ("Panel Domain").
          </div>
        )}

        <div className="space-y-1.5">
          {hooks.isLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : !hooks.data || hooks.data.length === 0 ? (
            <p className="py-2 text-xs text-slate-600">No webhooks. Create one and add it to GitHub/GitLab.</p>
          ) : (
            hooks.data.map((w) => (
              <div
                key={w.id}
                className="group flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-inset ring-white/5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-400">
                    <GitBranch size={11} /> {w.branch}
                    {w.watchPaths && (
                      <span className="truncate rounded bg-indigo-500/10 px-1.5 text-[10px] text-indigo-300" title={w.watchPaths}>
                        watch: {w.watchPaths.split(/[\n,]/).filter(Boolean).length} path(s)
                      </span>
                    )}
                  </div>
                  <button type="button"
                    onClick={() => void copy(w.url)}
                    className="mt-0.5 flex items-center gap-1 truncate font-mono text-[11px] text-slate-300 hover:text-indigo-300"
                    title={w.url}
                  >
                    <span className="truncate">{w.url}</span>
                    <Copy size={10} className="shrink-0 opacity-0 group-hover:opacity-100" />
                  </button>
                </div>
                <button type="button"
                  onClick={() => remove.mutate(w.id)}
                  className="text-slate-600 transition hover:text-rose-400"
                  title="Remove webhook"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ── Scheduled jobs (cron) ─────────────────────────────────────────────────
const selectCls = 'h-8 min-w-0 rounded-lg bg-black/30 px-2 text-xs text-slate-100 ring-1 ring-inset ring-white/10';

function parseTimeField(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || n > max) return fallback;
  return n;
}

/** "in ~4h" / "on 12 Aug, 03:00" — next-run chip text. */
function untilLabel(d: Date): string {
  const ms = d.getTime() - Date.now();
  const min = Math.round(ms / 60000);
  if (min <= 1) return 'within a minute';
  if (min < 60) return `in ~${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ~${hr}h`;
  const day = Math.round(hr / 24);
  if (day <= 7) return `in ~${day}d`;
  return `on ${formatDateTime(d)}`;
}

interface JobEntry {
  id: number;
  name: string;
  cron: string;
  kind: 'deploy' | 'exec';
  command: string;
  enabled: boolean;
  lastRunAt: string | null;
}

function JobsCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState('');
  // Preset-driven schedule entry; "custom" reveals the raw cron field.
  const [presetId, setPresetId] = useState('daily');
  const [time, setTime] = useState('03:00');
  const [weekday, setWeekday] = useState(0);
  const [monthday, setMonthday] = useState(1);
  const [customCron, setCustomCron] = useState('');
  const [kind, setKind] = useState<'deploy' | 'exec'>('deploy');
  const [command, setCommand] = useState('');

  const jobs = useQuery({ queryKey: ['jobs', serviceId], queryFn: () => api.jobs.list(serviceId) });
  const create = useMutation({
    mutationFn: () => api.jobs.create(serviceId, { name, cron: cronExpr, kind, command: kind === 'exec' ? command : undefined }),
    onSuccess: () => {
      setName('');
      setCustomCron('');
      setCommand('');
      qc.invalidateQueries({ queryKey: ['jobs', serviceId] });
      toast('Job created — active within 5 minutes', 'success');
    },
    onError: () => toast('Could not create the job', 'error'),
  });
  const remove = useMutation({
    mutationFn: (jobId: number) => api.jobs.remove(serviceId, jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', serviceId] }),
    // r211: the server refuses exec/backup jobs to members (403); a silent
    // failure looked like a dead button.
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not delete the job', 'error'),
  });
  const runNow = useMutation({
    mutationFn: (jobId: number) => api.jobs.run(serviceId, jobId),
    onSuccess: () => {
      toast('Job executed', 'success');
      qc.invalidateQueries({ queryKey: ['jobs', serviceId] }); // refresh 'last ran'
    },
    onError: () => toast('Job run failed', 'error'),
  });
  const toggle = useMutation({
    mutationFn: (j: { id: number; enabled: boolean }) => api.jobs.update(serviceId, j.id, { enabled: !j.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', serviceId] }),
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not update the job', 'error'),
  });

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;
  const isCustom = preset.id === 'custom';
  const [hourRaw, minuteRaw] = time.split(':');
  const hour = parseTimeField(hourRaw, 3, 23);
  const minute = parseTimeField(minuteRaw, 0, 59);
  const cronExpr = isCustom ? customCron.trim() : presetCron(preset, { hour, minute, weekday, monthday }) ?? '';
  const cronValid = isValidCron(cronExpr);

  const description = isCustom
    ? cronValid
      ? describeCron(cronExpr) ?? 'Custom expression.'
      : 'Not a valid 5-field expression yet.'
    : preset.hint || describeCron(cronExpr) || '';
  const nextRun = useMemo(() => (cronValid ? nextCronRun(cronExpr) : null), [cronValid, cronExpr]);

  const canCreate = Boolean(name.trim()) && cronValid && (kind === 'deploy' || command.trim());

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300">
          <CalendarClock size={15} className="text-slate-500" /> Scheduled jobs
        </div>
        <p className="mb-3 text-xs text-slate-500">Cron-scheduled redeploys or container commands (server timezone).</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) create.mutate();
          }}
          className="space-y-2"
        >
          <div className="grid grid-cols-2 gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-rebuild" aria-label="Job name" className="h-8 text-xs" />
            <select value={kind} onChange={(e) => setKind(e.target.value as 'deploy' | 'exec')} aria-label="Job action" className={selectCls}>
              <option value="deploy">Redeploy the service</option>
              <option value="exec">Run a command in the container</option>
            </select>
          </div>
          {kind === 'exec' && (
            <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="pg_dump … / npm run cache:clean" className="h-8 font-mono text-xs" />
          )}

          <div className="flex gap-2">
            <select
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              aria-label="Schedule preset"
              className={cn(selectCls, 'flex-1')}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            {preset.needs && (
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                aria-label="Time of day"
                className="h-8 w-[7.5rem] shrink-0 px-2 font-mono text-xs"
              />
            )}
            {preset.needs === 'weekday-time' && (
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} aria-label="Day of week" className={cn(selectCls, 'shrink-0')}>
                {WEEKDAY_LABELS.map((label, i) => (
                  <option key={label} value={i}>{label}</option>
                ))}
              </select>
            )}
            {preset.needs === 'monthday-time' && (
              <select value={monthday} onChange={(e) => setMonthday(Number(e.target.value))} aria-label="Day of month" className={cn(selectCls, 'shrink-0')}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            )}
          </div>
          {isCustom && (
            <Input
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
              placeholder="0 3 * * *"
              aria-label="Cron expression"
              className={cn('h-8 font-mono text-xs', customCron.trim() !== '' && !cronValid && 'ring-rose-500/50')}
            />
          )}

          <p className={cn('text-[11px]', isCustom && !cronValid ? 'text-rose-300/90' : 'text-slate-600')}>
            {cronValid && nextRun && (
              <span className="mr-2 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                <Clock size={9} /> next {untilLabel(nextRun)}
              </span>
            )}
            {description || '\u00A0'}
          </p>

          <Button type="submit" size="sm" variant="secondary" disabled={!canCreate || create.isPending}>
            <Plus size={13} /> Add job
          </Button>
        </form>

        <div className="mt-3 space-y-1.5">
          {jobs.isLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : !jobs.data || jobs.data.length === 0 ? (
            <p className="py-2 text-xs text-slate-600">No scheduled jobs.</p>
          ) : (
            jobs.data.map((j: JobEntry) => {
              const summary = describeCron(j.cron);
              return (
                <div key={j.id} className="group flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-inset ring-white/5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-medium text-slate-200">{j.name}</span>
                      <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300" title={summary ?? undefined}>{j.cron}</code>
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">{j.kind}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
                      {summary && <span>{summary}</span>}
                      {j.kind === 'exec' && j.command && (
                        <span className="truncate font-mono" title={j.command}>{j.command}</span>
                      )}
                      {j.lastRunAt && (
                        <span title={formatDateTime(j.lastRunAt)} className="shrink-0 text-slate-600">last ran {formatRelative(j.lastRunAt)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button type="button"
                      onClick={() => toggle.mutate({ id: j.id, enabled: j.enabled })}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset transition',
                        j.enabled ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20' : 'bg-slate-500/15 text-slate-400 ring-slate-500/20',
                      )}
                    >
                      {j.enabled ? 'on' : 'off'}
                    </button>
                    <button type="button" onClick={() => runNow.mutate(j.id)} className="text-[11px] text-slate-500 hover:text-indigo-300" title="Run now">
                      run
                    </button>
                    <button type="button" onClick={() => remove.mutate(j.id)} className="text-slate-600 transition hover:text-rose-400" title="Delete job">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </CardBody>
    </Card>
  );
}
