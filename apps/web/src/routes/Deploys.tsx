import { useMemo } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, GitBranch, Hash, Loader2, Rocket, StopCircle, Trash2, X } from 'lucide-react';
import type { QueueItem, QueueResponse } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorCard,
  PageHeader,
  Skeleton,
} from '../components/ui.js';
import { useToast } from '../components/Toast.js';
import { type Translate, msg, useT } from '../lib/i18n.js';

const STATUS_BADGE: Record<QueueItem['status'], { label: string; tone: 'amber' | 'sky' | 'indigo' }> = {
  queued: { label: msg('Queued'), tone: 'amber' },
  building: { label: msg('Building'), tone: 'sky' },
  deploying: { label: msg('Deploying'), tone: 'indigo' },
  awaiting_ci: { label: msg('Waiting for CI'), tone: 'amber' },
};

const POLL_MS = 3_000;

function relativeAge(iso: string, t: Translate): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return t('just now');
  const sec = Math.round(diff / 1000);
  if (sec < 60) return t('{n}s ago', { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('{n}m ago', { n: min });
  const hr = Math.round(min / 60);
  return t('{n}h ago', { n: hr });
}

function commitLabel(item: QueueItem): string {
  if (item.commitSha) return item.commitSha.slice(0, 7);
  if (item.imageDigest) return item.imageDigest.slice(0, 15);
  return '—';
}

/**
 * 0.16.13: deploys waiting for an admin's approval, across every service the
 * caller can see. Renders nothing when none waits (or on a panel without the
 * route), so the queue below stays the page's main content.
 */
function ApprovalsCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.deploys.approvals(),
    refetchInterval: 10_000,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: async (input: { serviceId: number; id: number; decision: 'approve' | 'reject' }): Promise<void> => {
      if (input.decision === 'approve') await api.deploys.approve(input.serviceId, input.id);
      else await api.deploys.reject(input.serviceId, input.id);
    },
    onSuccess: (_res, input) => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['deploys-queue'] });
      toast(input.decision === 'approve' ? t('Deployment #{id} approved', { id: input.id }) : t('Deployment #{id} rejected', { id: input.id }), 'info');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : t('Could not record the decision'), 'error'),
  });
  const items = approvals.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card className="mb-5 border-violet-500/20">
      <CardBody>
        <div className="mb-3 text-sm font-medium text-slate-200">{t('Waiting for approval')}</div>
        <ul className="space-y-2">
          {items.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2">
              <span className="min-w-0 text-xs">
                <Link to={`/services/${d.serviceId}`} className="font-medium text-slate-200 hover:text-indigo-300">
                  {d.serviceName}
                </Link>
                <span className="ml-2 font-mono text-[11px] text-slate-500">
                  #{d.id} · {d.commitSha ? d.commitSha.slice(0, 7) : d.imageDigest ? d.imageDigest.slice(0, 15) : '—'}
                </span>
                <span className="ml-2 text-[11px] text-slate-500">
                  {d.message ? d.message.split('\n')[0] : d.trigger} · {relativeAge(d.createdAt, t)}
                </span>
              </span>
              {d.mayReview ? (
                <span className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ serviceId: d.serviceId, id: d.id, decision: 'reject' })}
                  >
                    {t('Reject')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ serviceId: d.serviceId, id: d.id, decision: 'approve' })}
                  >
                    {t('Approve')}
                  </Button>
                </span>
              ) : (
                <span className="text-[11px] text-slate-500">{t('a workspace admin decides')}</span>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function Deploys() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();

  const queue = useQuery({
    queryKey: ['deploys-queue'],
    queryFn: async () => {
      const res = await api.deploys.queue();
      return res as QueueResponse;
    },
    refetchInterval: POLL_MS,
  });

  // Assign per-service queue position so the user can see "this is
  // job #3 for service X" — a separate service's claim does not
  // push it forward, but a sibling deploy ahead of it does.
  const ranked = useMemo(() => {
    const items = queue.data?.items ?? [];
    const perServiceSeq = new Map<number, number>();
    const perServiceAhead = new Map<number, number>();
    const out: Array<QueueItem & { position: number | null; aheadInService: number }> = [];
    // Pass 1: count how many queued items exist per service (for the
    // "x ahead of you" affordance the panel surfaces on each row).
    for (const it of items) {
      if (it.status === 'queued') perServiceAhead.set(it.serviceId, (perServiceAhead.get(it.serviceId) ?? 0) + 1);
    }
    // Pass 2: number every queued row in claim order so the UI can
    // show "queue #2 of 3" for the same service.
    for (const it of items) {
      if (it.status !== 'queued') {
        out.push({ ...it, position: null, aheadInService: 0 });
        continue;
      }
      const seq = (perServiceSeq.get(it.serviceId) ?? 0) + 1;
      perServiceSeq.set(it.serviceId, seq);
      const total = perServiceAhead.get(it.serviceId) ?? 1;
      out.push({ ...it, position: seq, aheadInService: total - seq });
    }
    return out;
  }, [queue.data]);

  const cancel = useMutation({
    mutationFn: (item: QueueItem) => api.deploys.cancel(item.serviceId, item.id),
    onSuccess: (_res, item) => {
      toast(t('Cancelled #{id}', { id: item.id }), 'info');
      qc.invalidateQueries({ queryKey: ['deploys-queue'] });
    },
    onError: () => toast(t('Cancel failed'), 'error'),
  });

  const remove = useMutation({
    mutationFn: (item: QueueItem) => api.deploys.remove(item.serviceId, item.id),
    onSuccess: (_res, item) => {
      toast(t('Removed #{id}', { id: item.id }), 'info');
      qc.invalidateQueries({ queryKey: ['deploys-queue'] });
    },
    // The server refuses in-flight (cancel it first) and `running` (the
    // build that is currently serving traffic). Surface the specific
    // reason from the API so the operator knows what to do next.
    onError: (err: Error) => toast(err.message ?? t('Remove failed'), 'error'),
  });

  const data = queue.data;
  const items = ranked;
  const counts = data?.byStatus ?? { queued: 0, building: 0, deploying: 0 };
  const total = data?.count ?? 0;

  return (
    <>
      <PageHeader
        icon={<Rocket size={18} />}
        title={t('Deploys')}
        subtitle={t('What is running right now, and what is queued behind it.')}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="sky">{t('{n} building', { n: counts.building })}</Badge>
            <Badge tone="indigo">{t('{n} deploying', { n: counts.deploying })}</Badge>
            <Badge tone="amber">{t('{n} queued', { n: counts.queued })}</Badge>
            {!!counts.awaiting_ci && <Badge tone="amber">{t('{n} waiting for CI', { n: counts.awaiting_ci })}</Badge>}
            <span className="text-xs text-slate-500">
              {t('auto-refresh {n}s', { n: POLL_MS / 1000 })}
            </span>
          </div>
        }
      />

      <ApprovalsCard />

      {queue.isLoading ? (
        <Skeleton className="h-32" />
      ) : queue.isError && !data ? (
        // r562: a failed load is not "nothing in flight".
        <ErrorCard title={t('Could not load the deploy queue')} error={queue.error} onRetry={() => void queue.refetch()} />
      ) : total === 0 ? (
        <EmptyState
          icon={<Rocket size={26} />}
          title={t('Nothing in flight')}
          hint={t("Trigger a deploy from a service's Deploys tab to see it land here.")}
        />
      ) : (
        <Card>
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.08] text-left text-[11px] uppercase tracking-widest text-slate-500">
                    <th className="py-2 pr-4 font-normal">{t('Service')}</th>
                    <th className="py-2 pr-4 font-normal">{t('Status')}</th>
                    <th className="py-2 pr-4 font-normal">{t('Commit')}</th>
                    <th className="py-2 pr-4 font-normal">{t('Message')}</th>
                    <th className="py-2 pr-4 font-normal">{t('Trigger')}</th>
                    <th className="py-2 pr-4 font-normal">{t('Age')}</th>
                    <th className="py-2 pr-4 text-right font-normal">{t('Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    // The queue serializer can race a cancel or gain a status
                    // this build has never heard of; render it instead of
                    // letting the page crash on a missing map entry.
                    const known = STATUS_BADGE[item.status];
                    const badge = known ? { label: t(known.label), tone: known.tone } : { label: item.status, tone: 'amber' as const };
                    return (
                      <tr
                        key={item.id}
                        className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]"
                      >
                        <td className="py-3 pr-4">
                          <Link
                            to={`/services/${item.serviceId}`}
                            className="font-medium text-slate-100 hover:text-indigo-300"
                          >
                            {item.serviceName}
                          </Link>
                          {item.position !== null && (
                            <div className="mt-0.5 text-[11px] text-slate-500">
                              {t('queue #{n} of {total}', { n: item.position, total: item.position + item.aheadInService })}
                            </div>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          <Badge tone={badge.tone}>
                            {item.status === 'building' || item.status === 'deploying' ? (
                              <Loader2 size={11} className="mr-1 inline animate-spin" />
                            ) : (
                              <Clock size={11} className="mr-1 inline" />
                            )}
                            {badge.label}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4 font-mono text-[11px] text-slate-400">
                          {item.commitSha ? (
                            <span title={item.commitSha}>
                              <GitBranch size={11} className="mr-1 inline" />
                              {commitLabel(item)}
                            </span>
                          ) : item.imageDigest ? (
                            <span title={item.imageDigest}>
                              <Hash size={11} className="mr-1 inline" />
                              {commitLabel(item)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-3 pr-4 max-w-xs truncate text-slate-300" title={item.message ?? undefined}>
                          {item.message ?? '—'}
                        </td>
                        <td className="py-3 pr-4 text-[11px] uppercase tracking-wider text-slate-500">
                          {item.trigger}
                        </td>
                        <td className="py-3 pr-4 text-slate-400">
                          {item.startedAt
                            ? t('started {age}', { age: relativeAge(item.startedAt, t) })
                            : t('enqueued {age}', { age: relativeAge(item.createdAt, t) })}
                        </td>
                        <td className="py-3 pr-0 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => cancel.mutate(item)}
                              disabled={cancel.isPending}
                              title={t('Stop the pipeline at the next step boundary')}
                            >
                              <StopCircle size={12} />
                              {t('Cancel')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => remove.mutate(item)}
                              disabled={remove.isPending}
                              title={t('Remove from history (refused for in-flight or serving-traffic deploys)')}
                            >
                              <Trash2 size={12} />
                              <X size={12} className="ml-0.5 opacity-60" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}
    </>
  );
}
