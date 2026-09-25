import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Activity as ActivityIcon,
  Clock,
  Download,
  Eye,
  RefreshCw,
  Search,
  User,
  Zap,
} from 'lucide-react';
import type { ActivityEntry } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
} from '../components/ui.js';

export function Activity() {
  const [entityFilter, setEntityFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [inspectEntry, setInspectEntry] = useState<ActivityEntry | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // r344: the server pages 50 rows at a time and hands back `nextCursor`
  // (the oldest id on the page) to send as `before`. Dropping it capped
  // search and export at the newest 50 rows with no way to see more.
  const activityQuery = useInfiniteQuery({
    queryKey: ['activity-list', entityFilter, actionFilter, userFilter],
    queryFn: ({ pageParam }) =>
      api.activity.list({
        entity: entityFilter || undefined,
        action: actionFilter || undefined,
        userId: userFilter ? Number(userFilter) : undefined,
        before: pageParam,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const entries = useMemo(() => activityQuery.data?.pages.flatMap((p) => p.entries) ?? [], [activityQuery.data]);

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter((e) => {
      const matchAction = e.action.toLowerCase().includes(q);
      const matchEntity = e.entity ? e.entity.toLowerCase().includes(q) : false;
      const matchUser = (e.userName ?? '').toLowerCase().includes(q) || (e.userEmail ?? '').toLowerCase().includes(q);
      const matchMeta = e.meta ? JSON.stringify(e.meta).toLowerCase().includes(q) : false;
      return matchAction || matchEntity || matchUser || matchMeta;
    });
  }, [entries, searchQuery]);

  const uniqueEntities = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.entity) set.add(e.entity);
    }
    return Array.from(set);
  }, [entries]);

  const uniqueActions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      set.add(e.action);
    }
    return Array.from(set);
  }, [entries]);

  const exportAsJson = () => {
    const blob = new Blob([JSON.stringify(filteredEntries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ninedeploy-audit-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAsCsv = () => {
    const headers = ['ID', 'Timestamp', 'User', 'Email', 'Entity', 'Action', 'Metadata'];
    const rows = filteredEntries.map((e) => [
      e.id,
      `"${e.ts}"`,
      `"${(e.userName ?? '').replace(/"/g, '""')}"`,
      `"${(e.userEmail ?? '').replace(/"/g, '""')}"`,
      `"${(e.entity ?? '').replace(/"/g, '""')}"`,
      `"${e.action.replace(/"/g, '""')}"`,
      `"${(e.meta ? JSON.stringify(e.meta) : '').replace(/"/g, '""')}"`,
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ninedeploy-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Well-known actions get a human-readable badge; anything unknown falls
  // through to the raw action name so new backend events are never invisible.
  const ACTION_LABELS: Record<string, string> = {
    'alert.oom': 'Out of memory',
    'ai.diagnose': 'AI diagnosis',
    'ai.suggest': 'AI manifest',
    'service.oom': 'Out of memory',
  };
  const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

  const getActionTone = (action: string) => {
    if (action.startsWith('alert.') || action.includes('oom')) {
      return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
    }
    if (action.includes('delete') || action.includes('destroy') || action.includes('remove') || action.includes('error')) {
      return 'text-rose-400 bg-rose-500/10 border-rose-500/20';
    }
    if (action.includes('rollback') || action.includes('warn')) {
      return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
    }
    if (action.includes('create') || action.includes('install') || action.includes('enable')) {
      return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    }
    if (action.includes('deploy') || action.includes('restart') || action.includes('start')) {
      return 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20';
    }
    return 'text-slate-300 bg-slate-800/60 border-slate-700/50';
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<ActivityIcon size={20} className="text-indigo-400" />}
        title="Activity & Audit Logs"
        subtitle="Full immutable ledger of platform operations, lifecycle events, and user actions."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                autoRefresh
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
              }`}
            >
              <Zap size={13} className={autoRefresh ? 'fill-emerald-400' : ''} />
              {autoRefresh ? 'Live Stream On' : 'Paused'}
            </button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => activityQuery.refetch()}
              disabled={activityQuery.isFetching}
              title="Refresh audit logs"
            >
              <RefreshCw size={13} className={activityQuery.isFetching ? 'animate-spin' : ''} />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={exportAsCsv}
              disabled={filteredEntries.length === 0}
            >
              <Download size={13} className="mr-1.5" />
              Export CSV
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={exportAsJson}
              disabled={filteredEntries.length === 0}
            >
              <Download size={13} className="mr-1.5" />
              Export JSON
            </Button>
          </div>
        }
      />

      {/* Filter Toolbar */}
      <Card>
        <CardBody className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                placeholder="Search audit trail..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 text-xs"
              />
            </div>
            <div>
              <Select
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value)}
                className="text-xs"
              >
                <option value="">All Entities</option>
                {uniqueEntities.map((ent) => (
                  <option key={ent} value={ent}>
                    {ent}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                className="text-xs"
              >
                <option value="">All Actions</option>
                {uniqueActions.map((act) => (
                  <option key={act} value={act}>
                    {act}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Input
                placeholder="User ID (e.g. 1)"
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                className="text-xs"
              />
              {(searchQuery || entityFilter || actionFilter || userFilter) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchQuery('');
                    setEntityFilter('');
                    setActionFilter('');
                    setUserFilter('');
                  }}
                  className="text-xs text-slate-400 hover:text-slate-200 shrink-0"
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Audit Log Table */}
      <Card>
        {activityQuery.isLoading ? (
          <CardBody className="space-y-3 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardBody>
        ) : filteredEntries.length === 0 ? (
          <CardBody className="p-12">
            <EmptyState
              icon={<Clock size={28} />}
              title="No activity recorded"
              hint="Audit log events and lifecycle updates will appear here automatically."
            />
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.01] text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3">Actor / User</th>
                  <th className="px-4 py-3 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {filteredEntries.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-white/[0.02]">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-slate-400">
                      {new Date(row.ts).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${getActionTone(row.action)}`}
                        title={row.action}
                      >
                        {actionLabel(row.action)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {row.entity ? (
                        <span className="font-mono text-slate-300 bg-white/[0.04] px-1.5 py-0.5 rounded text-[11px]">
                          {row.entity}
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <User size={12} className="text-slate-500" />
                        {row.userName ? (
                          <span className="font-medium text-slate-300">
                            {row.userName}
                            {row.userEmail && <span className="ml-1 text-slate-500">({row.userEmail})</span>}
                          </span>
                        ) : row.userId ? (
                          <span className="text-slate-400">User #{row.userId}</span>
                        ) : (
                          <span className="text-slate-500 italic">System Automation</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {row.meta ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setInspectEntry(row)}
                          className="h-7 px-2 text-[11px] text-indigo-400 hover:text-indigo-300"
                        >
                          <Eye size={12} className="mr-1" /> Inspect
                        </Button>
                      ) : (
                        <span className="text-[11px] text-slate-600">None</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {activityQuery.hasNextPage && (
          <CardBody className="flex justify-center border-t border-white/[0.04] p-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => activityQuery.fetchNextPage()}
              disabled={activityQuery.isFetchingNextPage}
            >
              {activityQuery.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
            </Button>
          </CardBody>
        )}
      </Card>

      {/* Inspect Meta Modal */}
      {inspectEntry && (
        <Modal
          title={`Audit Payload #${inspectEntry.id}`}
          wide
          onClose={() => setInspectEntry(null)}
          footer={
            <Button variant="secondary" size="sm" onClick={() => setInspectEntry(null)}>
              Dismiss
            </Button>
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs">
              <div>
                <span className="text-slate-500">Action:</span>
                <p className="font-mono font-medium text-slate-200 mt-0.5">{inspectEntry.action}</p>
              </div>
              <div>
                <span className="text-slate-500">Target Entity:</span>
                <p className="font-mono font-medium text-slate-200 mt-0.5">{inspectEntry.entity ?? 'None'}</p>
              </div>
              <div>
                <span className="text-slate-500">Timestamp:</span>
                <p className="font-mono text-slate-300 mt-0.5">{new Date(inspectEntry.ts).toISOString()}</p>
              </div>
              <div>
                <span className="text-slate-500">Actor:</span>
                <p className="text-slate-300 mt-0.5">
                  {inspectEntry.userName ? `${inspectEntry.userName} (${inspectEntry.userEmail})` : inspectEntry.userId ? `User #${inspectEntry.userId}` : 'System'}
                </p>
              </div>
            </div>

            <div>
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-400">
                JSON Metadata &amp; Parameters
              </span>
              <pre className="max-h-72 overflow-auto rounded-xl border border-white/[0.08] bg-black/40 p-3 font-mono text-xs text-indigo-200">
                {JSON.stringify(inspectEntry.meta, null, 2)}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
