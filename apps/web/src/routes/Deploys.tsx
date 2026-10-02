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

const STATUS_BADGE: Record<QueueItem['status'], { label: string; tone: 'amber' | 'sky' | 'indigo' }> = {
  queued: { label: 'Queued', tone: 'amber' },
  building: { label: 'Building', tone: 'sky' },
  deploying: { label: 'Deploying', tone: 'indigo' },
};

const POLL_MS = 3_000;

function relativeAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function commitLabel(item: QueueItem): string {
  if (item.commitSha) return item.commitSha.slice(0, 7);
  if (item.imageDigest) return item.imageDigest.slice(0, 15);
  return '—';
}

export function Deploys() {
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
      toast(`Cancelled #${item.id}`, 'info');
      qc.invalidateQueries({ queryKey: ['deploys-queue'] });
    },
    onError: () => toast('Cancel failed', 'error'),
  });

  const remove = useMutation({
    mutationFn: (item: QueueItem) => api.deploys.remove(item.serviceId, item.id),
    onSuccess: (_res, item) => {
      toast(`Removed #${item.id}`, 'info');
      qc.invalidateQueries({ queryKey: ['deploys-queue'] });
    },
    // The server refuses in-flight (cancel it first) and `running` (the
    // build that is currently serving traffic). Surface the specific
    // reason from the API so the operator knows what to do next.
    onError: (err: Error) => toast(err.message ?? 'Remove failed', 'error'),
  });

  const data = queue.data;
  const items = ranked;
  const counts = data?.byStatus ?? { queued: 0, building: 0, deploying: 0 };
  const total = data?.count ?? 0;

  return (
    <>
      <PageHeader
        icon={<Rocket size={18} />}
        title="Deploys"
        subtitle="What is running right now, and what is queued behind it."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="sky">{counts.building} building</Badge>
            <Badge tone="indigo">{counts.deploying} deploying</Badge>
            <Badge tone="amber">{counts.queued} queued</Badge>
            <span className="text-xs text-slate-500">
              auto-refresh {POLL_MS / 1000}s
            </span>
          </div>
        }
      />

      {queue.isLoading ? (
        <Skeleton className="h-32" />
      ) : queue.isError && !data ? (
        // r562: a failed load is not "nothing in flight".
        <ErrorCard title="Could not load the deploy queue" error={queue.error} onRetry={() => void queue.refetch()} />
      ) : total === 0 ? (
        <EmptyState
          icon={<Rocket size={26} />}
          title="Nothing in flight"
          hint="Trigger a deploy from a service's Deploys tab to see it land here."
        />
      ) : (
        <Card>
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.08] text-left text-[11px] uppercase tracking-widest text-slate-500">
                    <th className="py-2 pr-4 font-normal">Service</th>
                    <th className="py-2 pr-4 font-normal">Status</th>
                    <th className="py-2 pr-4 font-normal">Commit</th>
                    <th className="py-2 pr-4 font-normal">Message</th>
                    <th className="py-2 pr-4 font-normal">Trigger</th>
                    <th className="py-2 pr-4 font-normal">Age</th>
                    <th className="py-2 pr-4 text-right font-normal">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    // The queue serializer can race a cancel or gain a status
                    // this build has never heard of; render it instead of
                    // letting the page crash on a missing map entry.
                    const badge = STATUS_BADGE[item.status] ?? { label: item.status, tone: 'amber' as const };
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
                              queue #{item.position} of {item.position + item.aheadInService}
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
                            ? `started ${relativeAge(item.startedAt)}`
                            : `enqueued ${relativeAge(item.createdAt)}`}
                        </td>
                        <td className="py-3 pr-0 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => cancel.mutate(item)}
                              disabled={cancel.isPending}
                              title="Stop the pipeline at the next step boundary"
                            >
                              <StopCircle size={12} />
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => remove.mutate(item)}
                              disabled={remove.isPending}
                              title="Remove from history (refused for in-flight or serving-traffic deploys)"
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
