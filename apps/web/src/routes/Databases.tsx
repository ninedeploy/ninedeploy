import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Check, Copy, Database, HardDriveDownload, Link2, Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useTagScope } from '../lib/projects.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorCard, PageHeader, Skeleton, StatusBadge, cn } from '../components/ui.js';
import { useCopy } from '../lib/format.js';
import { StorageGauge } from '../components/StorageGauge.js';
import { DatabaseWizard } from '../components/DatabaseWizard.js';

const ENGINE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
  valkey: 'Valkey',
  mongo: 'MongoDB',
  clickhouse: 'ClickHouse',
  meilisearch: 'Meilisearch',
  rabbitmq: 'RabbitMQ',
};

export function Databases() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [wizard, setWizard] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{ id: number; name: string; attachedServices?: Array<{ id: number; name: string; slug: string }> } | null>(null);
  const { copied, copy } = useCopy();
  // Live per-container stats (kind 'database', refId = database id) — the
  // backend already reports running managed databases in the snapshot.
  const snapshot = useQuery({
    queryKey: ['live-stats-snapshot'],
    queryFn: () => api.stats.snapshot(),
    refetchInterval: 3000,
  });
  const liveStats = new Map(
    (snapshot.data?.containers ?? []).filter((c) => c.kind === 'database').map((c) => [c.refId, c]),
  );
  // Databases are still scoped by a single project (the new many-to-many
  // tagging is services-only). We pull the first selected project from the
  // tag scope so the top-bar filter continues to narrow the list.
  const { projectIds } = useTagScope();
  const activeProjectId = projectIds[0] ?? null;

  const list = useQuery({
    queryKey: ['databases', activeProjectId],
    queryFn: () => api.databases.list(activeProjectId != null ? `?projectId=${activeProjectId}` : ''),
  });
  const remove = useMutation({
    mutationFn: ({ id, force }: { id: number; force?: boolean }) => api.databases.remove(id, { force }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['databases'] });
      toast('Database deleted — its volume was kept (retained)', 'success');
    },
    onError: () => toast('Could not delete the database', 'error'),
  });
  const backup = useMutation({
    mutationFn: (id: number) => api.backups.backupNow(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backups'] });
      toast('Backup started', 'success');
    },
    onError: () => toast('Backup failed', 'error'),
  });

  return (
    <div>
      <PageHeader
        icon={<Database size={18} />}
        title="Databases"
        subtitle="Managed databases with persistent storage."
        actions={
          <Button onClick={() => setWizard(true)}>
            <Plus size={16} /> New database
          </Button>
        }
      />

      {wizard && <DatabaseWizard onClose={() => setWizard(false)} />}

      {list.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-3 h-3 w-2/3" />
            </Card>
          ))}
        </div>
      ) : list.isError ? (
        <ErrorCard title="Couldn't load databases" error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data || list.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Database size={26} />}
            title="No databases"
            hint="Spin up a managed Postgres, MySQL, Redis or MongoDB instance."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.data.map((d) => (
            <Card key={d.id} interactive className="flex h-full flex-col p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.04] text-indigo-300 ring-1 ring-inset ring-white/10">
                    <Database size={18} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <Link to={`/databases/${d.id}`} className="font-semibold leading-tight text-slate-100 hover:text-indigo-300 transition">
                        {d.name}
                      </Link>
                      {d.attachedServices && d.attachedServices.length > 0 && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20"
                          title={`In use by: ${d.attachedServices.map((s) => s.name).join(', ')}`}
                        >
                          <Link2 size={10} />
                          {d.attachedServices.length} linked
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">{ENGINE_LABEL[d.engine] ?? d.engine}{d.version ? ` ${d.version}` : ''}</div>
                  </div>
                </div>
                <StatusBadge status={d.status} />
              </div>

              <div className="mt-4 flex-1">
                {d.connectionString ? (
                  <button type="button"
                    onClick={() => void copy(d.connectionString!)}
                    className="group flex w-full items-center gap-2 rounded-lg bg-black/30 px-2.5 py-2 text-left ring-1 ring-inset ring-white/5 hover:ring-white/15"
                    title="Copy connection string"
                  >
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-emerald-300/90">
                      {d.connectionString}
                    </code>
                    {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} className="shrink-0 text-slate-500" />}
                  </button>
                ) : (
                  <div className="rounded-lg bg-black/20 px-2.5 py-2 text-[11px] text-slate-600">Not running</div>
                )}
                {d.status === 'running' && (
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-4 text-[11px] text-slate-400">
                      {liveStats.get(d.id) ? (
                        <>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            CPU <span className="font-mono text-slate-300">{liveStats.get(d.id)!.cpuPct.toFixed(1)}%</span>
                          </span>
                          <span>
                            RAM{' '}
                            <span className="font-mono text-slate-300">{liveStats.get(d.id)!.memMb} MB</span>
                          </span>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-slate-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-600" /> live stats…
                        </span>
                      )}
                    </div>
                    <StorageGauge databaseId={d.id} />
                  </div>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Link
                    to={`/databases/${d.id}`}
                    className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition"
                  >
                    Manage &rarr;
                  </Link>
                  <button type="button"
                    onClick={() => backup.mutate(d.id)}
                    disabled={backup.isPending}
                    className="flex items-center gap-1 text-xs text-slate-400 transition hover:text-indigo-300 disabled:opacity-50"
                  >
                    <HardDriveDownload size={12} /> Backup
                  </button>
                </div>
                <button type="button"
                  onClick={() => setPendingRemove({ id: d.id, name: d.name, attachedServices: d.attachedServices })}
                  className={cn('flex items-center gap-1 text-xs text-slate-600 transition hover:text-rose-400')}
                >
                  <Trash2 size={12} /> Remove
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingRemove != null}
        title={pendingRemove?.attachedServices && pendingRemove.attachedServices.length > 0 ? 'Force delete in-use database' : 'Delete database'}
        message={
          pendingRemove?.attachedServices && pendingRemove.attachedServices.length > 0
            ? `⚠️ Dependency warning: "${pendingRemove.name}" is currently attached to ${pendingRemove.attachedServices.length} service(s) (${pendingRemove.attachedServices.map((s) => s.name).join(', ')}). Deleting it will immediately break these services!`
            : `Delete "${pendingRemove?.name}"? The container is removed; its data volume is kept and can be freed under Volumes.`
        }
        confirmLabel={pendingRemove?.attachedServices && pendingRemove.attachedServices.length > 0 ? 'Force Delete' : 'Delete'}
        onConfirm={() => pendingRemove && remove.mutate({ id: pendingRemove.id, force: (pendingRemove.attachedServices?.length ?? 0) > 0 })}
        onClose={() => setPendingRemove(null)}
      />
    </div>
  );
}
