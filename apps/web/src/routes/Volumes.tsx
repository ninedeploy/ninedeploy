import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Archive, ArrowUpRight, Database, ExternalLink, FolderOpen, HardDrive, Layers, Lock, Package, Server, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorCard, PageHeader, Skeleton, cn } from '../components/ui.js';
import { formatBytes } from '../lib/format.js';
import { VolumeBrowser } from '../components/VolumeBrowser.js';
import { VolumeBackupsPanel } from '../components/VolumeBackupsPanel.js';

export function Volumes() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const list = useQuery({
    queryKey: ['volumes'],
    queryFn: () => api.volumes.list(),
    // Instance-wide inventory is admin-only (L-12) — a member landing here
    // directly must not fire (and poll) a refused call.
    enabled: user?.isOperator === true,
  });
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [browsing, setBrowsing] = useState<string | null>(null);
  // Snapshot history for one volume, expanded under the grid. Volume
  // backups used to be reachable only from a service's Volumes tab, which
  // left every retained (owner-less) volume with no way to snapshot or
  // restore it at all.
  const [snapshotting, setSnapshotting] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (name: string) => api.volumes.remove(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['volumes'] });
      toast('Volume deleted', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Delete failed', 'error'),
  });
  const prune = useMutation({
    mutationFn: () => api.volumes.prune(),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['volumes'] });
      toast(`Pruned ${data.deleted} retained volume(s) (freed ${formatBytes(data.freedBytes)})`, 'success');
      setConfirmPrune(false);
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Prune failed', 'error'),
  });
  const total = (list.data ?? []).reduce((s, v) => s + v.sizeBytes, 0);
  const max = Math.max(1, ...(list.data ?? []).map((v) => v.sizeBytes));
  const retainedList = (list.data ?? []).filter((v) => !v.owner);
  const retained = retainedList.length;
  const retainedBytes = retainedList.reduce((s, v) => s + v.sizeBytes, 0);

  if (!user?.isOperator) {
    return <PageHeader icon={<Layers size={18} />} title="Volumes & Storage" subtitle="Instance-wide storage inventory — operators only." />;
  }

  return (
    <div>
      <PageHeader
        icon={<Layers size={18} />}
        title="Volumes & Storage"
        subtitle={`${(list.data?.length ?? 0)} volumes · ${formatBytes(total)} used${retained > 0 ? ` · ${retained} retained (${formatBytes(retainedBytes)})` : ''}`}
        actions={
          retained > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmPrune(true)}
              className="text-xs"
              disabled={prune.isPending}
            >
              <Trash2 size={13} /> Prune retained ({retained})
            </Button>
          ) : undefined
        }
      />

      <DockerResources />

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Persistent volumes</h2>
      {list.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <Card key={i} className="p-5"><Skeleton className="h-12 w-full" /></Card>)}
        </div>
      ) : list.isError ? (
        <ErrorCard title="Couldn't load volumes" error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data || list.data.length === 0 ? (
        <Card><EmptyState icon={<HardDrive size={26} />} title="No volumes" hint="Deploy a service with a volume or create a database." /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.data.map((v) => {
            const isRetained = !v.owner;
            const ownerHref = v.owner?.id
              ? v.owner.kind === 'database'
                ? `/databases/${v.owner.id}`
                : `/services/${v.owner.id}`
              : null;

            return (
              <Card key={v.name} interactive className="p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className={cn('grid h-9 w-9 place-items-center rounded-xl ring-1 ring-inset ring-white/10 shrink-0', isRetained ? 'bg-amber-500/10 text-amber-300' : v.owner?.kind === 'database' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-indigo-500/10 text-indigo-300')}>
                        {isRetained ? <HardDrive size={16} /> : v.owner?.kind === 'database' ? <Database size={16} /> : <Server size={16} />}
                      </span>
                      <div className="min-w-0">
                        {ownerHref ? (
                          <Link
                            to={ownerHref}
                            className="group inline-flex items-center gap-1 font-semibold leading-tight text-slate-100 transition hover:text-indigo-400"
                            title={`Navigate to ${v.owner?.kind}: ${v.owner?.name}`}
                          >
                            <span className="truncate">{v.owner?.name}</span>
                            <ArrowUpRight size={13} className="text-slate-400 opacity-80 group-hover:text-indigo-400 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform shrink-0" />
                          </Link>
                        ) : (
                          <div className="font-semibold leading-tight text-slate-100">{v.owner?.name ?? 'Retained'}</div>
                        )}
                        <div className="font-mono text-[10px] text-slate-500">
                          {isRetained ? 'no active owner' : `${v.owner!.kind}${v.owner!.engine ? ` · ${v.owner!.engine}` : ''}`}
                        </div>
                      </div>
                    </div>
                    <span className="text-sm font-semibold tabular-nums text-slate-200 shrink-0">{formatBytes(v.sizeBytes)}</span>
                  </div>

                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                    <div className={cn('h-full rounded-full transition-all', isRetained ? 'bg-amber-500/70' : 'bg-indigo-500/70')} style={{ width: `${Math.max(3, (v.sizeBytes / max) * 100)}%` }} />
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide', v.inUse ? 'bg-rose-500/10 text-rose-300' : isRetained ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/10 text-emerald-300/80')}>
                      {v.inUse ? 'in use · locked' : isRetained ? 'retained · reusable' : 'attached · stopped'}
                    </span>
                    {ownerHref && (
                      <Link
                        to={ownerHref}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 transition"
                      >
                        <span>{v.owner?.kind === 'database' ? 'DB' : 'Service'}</span>
                        <ExternalLink size={10} />
                      </Link>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button type="button"
                      onClick={() => setBrowsing(v.name)}
                      className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-[var(--nd-accent)]"
                      title="Browse files in this volume"
                    >
                      <FolderOpen size={14} />
                    </button>
                    <button type="button"
                      onClick={() => setSnapshotting((cur) => (cur === v.name ? null : v.name))}
                      className={cn(
                        'rounded-lg p-1.5 transition hover:bg-white/5',
                        snapshotting === v.name ? 'text-amber-300' : 'text-slate-500 hover:text-amber-300',
                      )}
                      title="Snapshots — back up, restore or download this volume"
                      aria-expanded={snapshotting === v.name}
                      aria-label={`Snapshots for ${v.name}`}
                    >
                      <Archive size={14} />
                    </button>
                    {!v.inUse && (
                      <button type="button"
                        onClick={() => setPendingDelete(v.name)}
                        className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-400"
                        title="Delete volume (destructive)"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                    {v.inUse && <span title={`Attached to a running ${v.owner?.kind ?? 'workload'} — stop it first`}><Lock size={13} className="text-slate-600 ml-1" /></span>}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {snapshotting && (
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.02] p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-mono text-[11px] text-slate-400">{snapshotting}</p>
            <Button size="sm" variant="secondary" onClick={() => setSnapshotting(null)}>Close</Button>
          </div>
          <VolumeBackupsPanel volumeName={snapshotting} />
        </div>
      )}
      {browsing && <VolumeBrowser volume={browsing} onClose={() => setBrowsing(null)} />}

      <p className="mt-3 text-xs text-slate-600">
        Deleting a database keeps its volume (marked <span className="text-amber-400">retained</span>) so data survives — recreating the same database reuses it. Remove a volume here only to free disk. <Link to="/backups" className="text-indigo-400 hover:underline">Backups</Link>.
      </p>

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete volume"
        message={pendingDelete
          ? <>Volume <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">{pendingDelete}</code> and all data in it will be removed permanently. This cannot be undone.</>
          : ''}
        confirmLabel="Delete"
        confirmWord={pendingDelete ?? undefined}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={confirmPrune}
        title="Prune retained volumes"
        message={`Permanently delete ${retained} retained volume(s) and free ${formatBytes(retainedBytes)} of disk space? This cannot be undone.`}
        confirmLabel="Prune all"
        onConfirm={() => prune.mutate()}
        onClose={() => setConfirmPrune(false)}
      />
    </div>
  );
}

function DockerResources() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const res = useQuery({ queryKey: ['docker-resources'], queryFn: () => api.system.resources(), refetchInterval: 20000 });
  const prune = useMutation({
    mutationFn: () => api.system.pruneImages(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['docker-resources'] });
      toast('Image prune finished', 'success');
    },
    onError: () => toast('Prune failed', 'error'),
  });
  const s = res.data?.imagesSummary;

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Package size={15} className="text-slate-500" /> Docker resources
        </div>
        <Button size="sm" variant="secondary" onClick={() => prune.mutate()} disabled={prune.isPending}>
          <Trash2 size={13} /> Prune images
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Network" value={res.data?.network ?? '—'} />
        <Metric label="Containers" value={String(res.data?.containers ?? '—')} />
        <Metric label="Volumes" value={String(res.data?.volumes ?? '—')} />
        <Metric label="Images" value={s ? `${s.active}/${s.total} active` : '—'} />
      </div>
      {s && (
        <p className="mt-3 text-xs text-slate-500">
          Images use <span className="text-slate-300">{s.size}</span>
          {s.reclaimable && s.reclaimable !== '0B' && <> · <span className="text-amber-400">{s.reclaimable}</span> reclaimable</>}.
        </p>
      )}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm text-slate-200">{value}</div>
    </div>
  );
}
