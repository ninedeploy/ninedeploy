import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Globe, HeartPulse, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { MonitorView, StatusPageView } from '@ninedeploy/schemas';
import { api } from '../../lib/api.js';
import { apiUrl } from '../../lib/apiUrl.js';
import { copyText, formatRelative } from '../../lib/format.js';
import { certExpiry, formatInterval, formatResponseMs } from '../../lib/uptime.js';
import { uptimeApi, uptimeKeys } from '../../lib/uptimeApi.js';
import { useToast } from '../Toast.js';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorCard, Skeleton, cn } from '../ui.js';
import { MonitorFormModal } from './MonitorFormModal.js';
import { MonitorSpark, MonitorStatusBadge, UptimeValue } from './MonitorBits.js';
import { StatusPageFormModal } from './StatusPageFormModal.js';

export const UPTIME_EMPTY_HINT =
  'Check a URL or a TCP port from the panel every minute; get notified on your notification channels when it goes down.';

/** Shared monitor mutations (check now, pause/resume, delete) with their toasts. */
export function useMonitorActions() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const refresh = (id?: number) => {
    void qc.invalidateQueries({ queryKey: uptimeKeys.monitors });
    if (id !== undefined) void qc.invalidateQueries({ queryKey: ['monitor-checks', id] });
  };
  const checkNow = useMutation({
    mutationFn: (id: number) => uptimeApi.monitors.check(id),
    onSuccess: ({ check }, id) => {
      refresh(id);
      if (check.ok) toast(`Check passed${check.responseMs != null ? ` in ${formatResponseMs(check.responseMs)}` : ''}`, 'success');
      else toast(`Check failed: ${check.error ?? (check.statusCode != null ? `HTTP ${check.statusCode}` : 'no response')}`, 'error');
    },
    onError: (err: Error) => toast(err.message || 'Could not run the check', 'error'),
  });
  const toggle = useMutation({
    mutationFn: (m: { id: number; enabled: boolean }) => uptimeApi.monitors.update(m.id, { enabled: m.enabled }),
    onSuccess: (_data, vars) => {
      refresh(vars.id);
      toast(vars.enabled ? 'Monitor resumed' : 'Monitor paused', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not update the monitor', 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => uptimeApi.monitors.remove(id),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: uptimeKeys.statusPages });
      toast('Monitor deleted', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not delete the monitor', 'error'),
  });
  return { checkNow, toggle, remove };
}

/**
 * Monitoring → Uptime (0.16.8): HTTP/TCP monitors probed from the panel, with
 * their 24h / 7d / 30d uptime and response-time trend, and (operators) the
 * public status pages built from them.
 */
export function UptimeSection({ isOperator }: { isOperator: boolean }) {
  const monitors = useQuery({ queryKey: uptimeKeys.monitorList(), queryFn: () => uptimeApi.monitors.list(), refetchInterval: 15_000 });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.services.list(), staleTime: 60_000 });
  const { checkNow, toggle, remove } = useMonitorActions();
  const [editing, setEditing] = useState<MonitorView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MonitorView | null>(null);

  const list = monitors.data ?? [];
  const down = list.filter((m) => m.status === 'down').length;
  const up = list.filter((m) => m.status === 'up').length;
  const serviceNames = new Map((services.data ?? []).map((s) => [s.id, s.name]));

  return (
    <section aria-label="Uptime">
      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <HeartPulse size={14} /> Uptime
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {list.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              {down > 0 && <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-300 ring-1 ring-inset ring-rose-500/20">{down} down</span>}
              {up > 0 && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300 ring-1 ring-inset ring-emerald-500/20">{up} up</span>}
              <span className="text-slate-500">
                {list.length} monitor{list.length === 1 ? '' : 's'}
              </span>
            </div>
          )}
          {isOperator && list.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
              <Plus size={13} /> New monitor
            </Button>
          )}
        </div>
      </div>

      <Card className="p-4">
        {monitors.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : monitors.isError ? (
          <ErrorCard title="Couldn't load monitors" error={monitors.error} onRetry={() => monitors.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<HeartPulse size={22} />}
            title="No uptime monitors yet"
            hint={UPTIME_EMPTY_HINT}
            action={
              isOperator ? (
                <Button size="sm" onClick={() => setEditing('new')}>
                  <Plus size={13} /> New monitor
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-white/5" aria-label="Monitors">
            {list.map((m) => (
              <MonitorRow
                key={m.id}
                monitor={m}
                serviceName={m.serviceId != null ? (serviceNames.get(m.serviceId) ?? `service #${m.serviceId}`) : null}
                isOperator={isOperator}
                busy={checkNow.isPending && checkNow.variables === m.id}
                onCheck={() => checkNow.mutate(m.id)}
                onToggle={() => toggle.mutate({ id: m.id, enabled: !m.enabled })}
                onEdit={() => setEditing(m)}
                onDelete={() => setDeleting(m)}
              />
            ))}
          </ul>
        )}
      </Card>

      {isOperator && <StatusPagesCard monitors={list} />}

      {editing && <MonitorFormModal monitor={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this monitor?"
        message={`${deleting?.name ?? ''} and its check history are removed, and it leaves every status page.`}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        onClose={() => setDeleting(null)}
      />
    </section>
  );
}

function MonitorRow({
  monitor: m,
  serviceName,
  isOperator,
  busy,
  onCheck,
  onToggle,
  onEdit,
  onDelete,
}: {
  monitor: MonitorView;
  serviceName: string | null;
  isOperator: boolean;
  busy: boolean;
  onCheck: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cert = m.certExpiresAt ? certExpiry(m.certExpiresAt) : null;
  return (
    <li className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-1 last:pb-1', !m.enabled && 'opacity-70')}>
      <MonitorStatusBadge status={m.status} />

      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-200">{m.name}</span>
          <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-400 ring-1 ring-inset ring-white/10">{m.kind}</span>
          {serviceName && m.serviceId != null && (
            <Link to={`/services/${m.serviceId}`} className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-500/20 hover:text-indigo-400">
              {serviceName}
            </Link>
          )}
        </div>
        <div className="mt-0.5 break-all font-mono text-[11px] text-slate-500">{m.target}</div>
        <div className="mt-0.5 text-[11px] text-slate-500">
          {m.lastCheckedAt ? `checked ${formatRelative(m.lastCheckedAt)}` : 'not checked yet'} · {formatInterval(m.intervalSeconds)}
          {m.lastStatusCode != null && ` · HTTP ${m.lastStatusCode}`}
        </div>
        {m.status === 'down' && m.lastError && <div className="mt-1 break-words text-[11px] text-rose-300">{m.lastError}</div>}
        {cert && (
          <div className={cn('mt-0.5 text-[11px]', cert.tone === 'rose' ? 'text-rose-300' : cert.tone === 'amber' ? 'text-amber-300' : 'text-slate-500')}>{cert.text}</div>
        )}
      </div>

      <MonitorSpark monitor={m} />

      <dl className="grid shrink-0 grid-cols-4 gap-3 text-right">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">Resp.</dt>
          <dd className="text-xs font-semibold tabular-nums text-slate-200">{formatResponseMs(m.lastResponseMs)}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">24h</dt>
          <dd className="text-xs font-semibold">
            <UptimeValue pct={m.uptime.h24} />
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">7d</dt>
          <dd className="text-xs font-semibold">
            <UptimeValue pct={m.uptime.d7} />
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">30d</dt>
          <dd className="text-xs font-semibold">
            <UptimeValue pct={m.uptime.d30} />
          </dd>
        </div>
      </dl>

      {isOperator && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Check now" aria-label={`Check ${m.name} now`} onClick={onCheck} disabled={busy}>
            <RefreshCw size={13} className={busy ? 'animate-spin' : undefined} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            title={m.enabled ? 'Pause' : 'Resume'}
            aria-label={m.enabled ? `Pause ${m.name}` : `Resume ${m.name}`}
            onClick={onToggle}
          >
            {m.enabled ? <Pause size={13} /> : <Play size={13} />}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Edit" aria-label={`Edit ${m.name}`} onClick={onEdit}>
            <Pencil size={13} />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-400 hover:text-rose-300" title="Delete" aria-label={`Delete ${m.name}`} onClick={onDelete}>
            <Trash2 size={13} />
          </Button>
        </div>
      )}
    </li>
  );
}

/** The absolute public URL of a status page. */
export function statusPageUrl(page: Pick<StatusPageView, 'path'>): string {
  return new URL(apiUrl(page.path), window.location.href).href;
}

/** Operators: the public status pages. */
function StatusPagesCard({ monitors }: { monitors: readonly MonitorView[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const pages = useQuery({ queryKey: uptimeKeys.statusPages, queryFn: () => uptimeApi.statusPages.list() });
  const [editing, setEditing] = useState<StatusPageView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<StatusPageView | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => uptimeApi.statusPages.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: uptimeKeys.statusPages });
      toast('Status page deleted', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not delete the status page', 'error'),
  });
  const copy = async (page: StatusPageView) => {
    const ok = await copyText(statusPageUrl(page));
    toast(ok ? 'Link copied' : 'Could not copy the link', ok ? 'success' : 'error');
  };
  const list = pages.data ?? [];

  return (
    <>
      <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <Globe size={13} /> Status pages
        </h3>
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
          <Plus size={13} /> New status page
        </Button>
      </div>
      <Card className="p-4">
        {pages.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : pages.isError ? (
          <ErrorCard title="Couldn't load status pages" error={pages.error} onRetry={() => pages.refetch()} />
        ) : list.length === 0 ? (
          <p className="py-2 text-center text-sm text-slate-500">No status pages yet. A status page shows chosen monitors publicly, by name only.</p>
        ) : (
          <ul className="divide-y divide-white/5" aria-label="Status pages">
            {list.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-1 last:pb-1">
                <div className="min-w-0 flex-1 basis-48">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-200">{p.title}</span>
                    {p.published ? <Badge tone="emerald">Published</Badge> : <Badge>Draft</Badge>}
                  </div>
                  <div className="mt-0.5 break-all font-mono text-[11px] text-slate-500">
                    {p.path} · {p.monitorIds.length} monitor{p.monitorIds.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <a
                    href={apiUrl(p.path)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${p.title}`}
                    title="Open the public page"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-300 hover:bg-white/[0.08]"
                  >
                    <ExternalLink size={13} />
                  </a>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Copy link" aria-label={`Copy link to ${p.title}`} onClick={() => void copy(p)}>
                    <Copy size={13} />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Edit" aria-label={`Edit ${p.title}`} onClick={() => setEditing(p)}>
                    <Pencil size={13} />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-rose-400 hover:text-rose-300" title="Delete" aria-label={`Delete ${p.title}`} onClick={() => setDeleting(p)}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && <StatusPageFormModal page={editing === 'new' ? undefined : editing} monitors={monitors} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this status page?"
        message={`${deleting?.path ?? ''} stops answering. The monitors stay.`}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}
