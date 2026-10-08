import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { SquareTerminal } from 'lucide-react';
import type { TerminalSession, TerminalSessionStatus, TerminalTargetKind } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { formatBytes, formatDateTime } from '../lib/format.js';
import { useToast } from '../components/Toast.js';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorCard, PageHeader, Select, Skeleton } from '../components/ui.js';

const STATUS_TONE: Record<TerminalSessionStatus, 'emerald' | 'amber' | 'neutral' | 'rose'> = {
  active: 'emerald',
  pending: 'amber',
  ended: 'neutral',
  expired: 'neutral',
  failed: 'rose',
};

/** End reasons as an operator reads them. */
const END_REASONS: Record<string, string> = {
  shell_exited: 'shell exited',
  client_closed: 'closed by the user',
  idle: 'idle timeout',
  max_duration: 'maximum length',
  terminated: 'terminated by an operator',
  revoked: 'access revoked',
  too_many_sessions: 'too many sessions',
  target_unreachable: 'target unreachable',
  frame_too_large: 'frame too large',
  panel_restart: 'panel restarted',
  context_lost: 'session context lost',
};

export const endReasonLabel = (reason: string | null): string => (reason ? (END_REASONS[reason] ?? reason.replace(/_/g, ' ')) : '');

function duration(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const isLive = (s: TerminalSession) => s.status === 'active' || s.status === 'pending';

/**
 * Terminal sessions (operator only, 0.15): who opened which shell, when, for
 * how long and how many bytes moved. Live sessions can be terminated (the
 * user's socket closes with 4410). No transcript is ever recorded.
 */
export function Terminals() {
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState<TerminalSessionStatus | ''>('');
  const [targetKind, setTargetKind] = useState<TerminalTargetKind | ''>('');
  const [pendingKill, setPendingKill] = useState<TerminalSession | null>(null);

  const history = useInfiniteQuery({
    queryKey: ['terminal-sessions', status, targetKind],
    queryFn: ({ pageParam }) =>
      api.terminals.list({
        ...(status ? { status } : {}),
        ...(targetKind ? { targetKind } : {}),
        limit: 50,
        ...(pageParam ? { before: pageParam } : {}),
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: isOperator,
    refetchInterval: 15_000,
  });

  const terminate = useMutation({
    mutationFn: (id: number) => api.terminals.terminate(id),
    onSuccess: (res) => {
      toast(res.wasLive ? 'Session terminated' : 'Pending session revoked', 'success');
      qc.invalidateQueries({ queryKey: ['terminal-sessions'] });
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : 'Could not terminate the session', 'error'),
  });

  if (!isOperator) {
    return <PageHeader icon={<SquareTerminal size={18} />} title="Terminal sessions" subtitle="Operators only." />;
  }

  const rows = history.data?.pages.flatMap((p) => p.items) ?? [];
  const live = rows.filter(isLive);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<SquareTerminal size={18} />}
        title="Terminal sessions"
        subtitle="Every shell opened through the panel: metadata only, never a transcript."
        actions={
          <Link to="/settings?section=security" className="text-xs text-indigo-400 hover:text-indigo-300">
            Terminal settings →
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-slate-500">Live in this list</div>
          <div className="mt-1 text-2xl font-semibold text-white">{live.length}</div>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as TerminalSessionStatus | '')} className="w-40">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="ended">Ended</option>
            <option value="failed">Failed</option>
            <option value="expired">Expired</option>
          </Select>
          <Select aria-label="Target" value={targetKind} onChange={(e) => setTargetKind(e.target.value as TerminalTargetKind | '')} className="w-40">
            <option value="">Any target</option>
            <option value="service">Service</option>
            <option value="database">Database</option>
            <option value="container">Container</option>
            <option value="host">Host</option>
          </Select>
        </div>
      </Card>

      {history.isLoading ? (
        <Card className="p-5">
          <Skeleton className="h-10 w-full" />
        </Card>
      ) : history.isError ? (
        <ErrorCard title="Couldn't load terminal sessions" error={history.error} onRetry={() => history.refetch()} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<SquareTerminal size={26} />} title="No terminal sessions" hint="Shells opened from a service, database or the Servers page appear here." />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-medium">Target</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Started</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">In / out</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 text-slate-200">
                      <Badge tone={s.targetKind === 'host' ? 'rose' : 'neutral'}>{s.targetKind}</Badge>
                      <span className="font-mono text-xs">{s.targetLabel}</span>
                    </div>
                    {s.serverId !== null && <div className="mt-0.5 text-[11px] text-slate-500">node #{s.serverId}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {s.userEmail ?? '—'}
                    {s.clientIp && <div className="text-[11px] text-slate-600">{s.clientIp}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                    {s.endReason && <div className="mt-0.5 text-[11px] text-slate-500">{endReasonLabel(s.endReason)}</div>}
                    {s.exitCode !== null && <div className="text-[11px] text-slate-600">exit {s.exitCode}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">{formatDateTime(s.startedAt ?? s.createdAt)}</td>
                  <td className="px-4 py-3 text-xs text-slate-400">{duration(s.durationMs)}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                    {formatBytes(s.bytesIn)} / {formatBytes(s.bytesOut)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isLive(s) && (
                      <Button size="sm" variant="danger" onClick={() => setPendingKill(s)}>
                        Terminate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.hasNextPage && (
            <div className="border-t border-white/5 p-3 text-center">
              <Button size="sm" variant="ghost" disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>
                Load older sessions
              </Button>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={pendingKill !== null}
        title="Terminate this session?"
        message={
          pendingKill
            ? `${pendingKill.userEmail ?? 'The user'} loses the shell on ${pendingKill.targetLabel} immediately.`
            : ''
        }
        confirmLabel="Terminate"
        onConfirm={() => {
          if (pendingKill) terminate.mutate(pendingKill.id);
        }}
        onClose={() => setPendingKill(null)}
      />
    </div>
  );
}
