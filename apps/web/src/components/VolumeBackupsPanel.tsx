import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Archive, Download, History, Loader2, RotateCcw, ShieldCheck, Tag, Trash2, X } from 'lucide-react';
import type { Backup } from '@ninedeploy/sdk';
import { api, authedFetch } from '../lib/api.js';
import { Button, Card, Input } from './ui.js';
import { downloadBlob, formatBytes } from '../lib/format.js';
import { useToast } from './Toast.js';

export function VolumeBackupsPanel({ volumeName }: { volumeName: string }) {
  const qc = useQueryClient();
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [label, setLabel] = useState('');

  const backups = useQuery({
    queryKey: ['volume-backups', volumeName],
    queryFn: () => api.volumeBackups.list(volumeName),
  });
  const trigger = useMutation({
    mutationFn: () => api.volumeBackups.create(volumeName, { label: label.trim() || 'manual' }),
    onSuccess: () => {
      setLabel('');
      qc.invalidateQueries({ queryKey: ['volume-backups', volumeName] });
    },
  });
  const restore = useMutation({
    mutationFn: (id: number) => api.volumeBackups.restore(volumeName, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['volume-backups', volumeName] }),
  });

  const list = backups.data ?? [];

  return (
    <div className="space-y-3" data-testid="volume-backups-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Archive size={16} className="text-amber-400" />
          <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">Volume Backups ({list.length})</h3>
        </div>
        <div className="flex items-center gap-2">
          {/* Optional name for THIS snapshot — ends up on the row and in the
              tar.gz filename; leaving it empty falls back to "manual". */}
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            aria-label="Snapshot label"
            maxLength={40}
            className="h-8 w-36 font-mono text-xs"
            data-testid="snapshot-label-input"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => trigger.mutate()}
            disabled={trigger.isPending}
            data-testid="trigger-backup-button"
          >
            {trigger.isPending ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
            Backup now
          </Button>
        </div>
      </div>

      {trigger.isError && (
        <Card className="p-3 border-rose-500/30 bg-rose-500/[0.04]">
          <p className="text-xs text-rose-300">Backup failed: {(trigger.error as Error).message}</p>
        </Card>
      )}

      {backups.isLoading ? (
        <Card className="p-4 text-center text-slate-500 text-xs">
          <Loader2 size={16} className="mx-auto animate-spin mb-1" />
          Loading backups…
        </Card>
      ) : list.length === 0 ? (
        <Card className="p-6 text-center">
          <History size={20} className="mx-auto mb-2 text-slate-600" />
          <p className="text-sm font-medium text-slate-300">No backups yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Click <em>Backup now</em> to snapshot the volume, or wire up a scheduled <em>backup</em> job for the service.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {list.map((b) => (
            <BackupRow
              key={b.id}
              volumeName={volumeName}
              backup={b}
              restoring={restoringId === b.id}
              onConfirmRestore={() => {
                setRestoringId(b.id);
              }}
              onCancelRestore={() => setRestoringId(null)}
              onRestore={() => {
                restore.mutate(b.id);
                setRestoringId(null);
              }}
              isRestoring={restore.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BackupRow({
  volumeName,
  backup,
  restoring,
  onConfirmRestore,
  onCancelRestore,
  onRestore,
  isRestoring,
}: {
  volumeName: string;
  backup: Backup;
  restoring: boolean;
  onConfirmRestore: () => void;
  onCancelRestore: () => void;
  onRestore: () => void;
  isRestoring: boolean;
}) {
  const date = new Date(backup.createdAt);
  const { toast } = useToast();
  // r202: a plain <a href> sends no Authorization header (the panel's session
  // is a bearer token, not a cookie), so every volume backup download was a
  // 401 JSON body. Fetch with the session and save the blob instead, as the
  // database backup downloads do.
  const download = async () => {
    try {
      const res = await authedFetch(api.volumeBackups.downloadUrl(volumeName, backup.id));
      if (!res.ok) {
        toast('Download failed', 'error');
        return;
      }
      downloadBlob(await res.blob(), `${volumeName}-backup-${backup.id}.tar.gz`, 'application/gzip');
    } catch {
      toast('Download failed', 'error');
    }
  };
  return (
    <Card className="p-3" data-testid={`backup-row-${backup.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Snapshot name first — the timestamp alone made rows
                indistinguishable at a glance. */}
            <span className="flex items-center gap-1 text-xs font-semibold text-slate-200">
              <Tag size={11} className="shrink-0 text-slate-500" />
              {backup.label ?? 'Snapshot'}
            </span>
            <span className="font-mono text-[11px] text-slate-500">
              {date.toISOString().slice(0, 16).replace('T', ' ')}
            </span>
            <StatusBadge status={backup.status} />
            {backup.hasRemoteCopy && (
              <span className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-300 ring-1 ring-inset ring-sky-500/20">
                <ShieldCheck size={10} /> Off-site
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 font-mono truncate mt-0.5">{volumeName}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-300 shrink-0">{formatBytes(backup.sizeBytes)}</span>
          <button
            type="button"
            onClick={() => void download()}
            className="text-slate-400 hover:text-indigo-300 transition-colors"
            title="Download tar.gz"
            aria-label="Download tar.gz"
            data-testid={`download-backup-${backup.id}`}
          >
            <Download size={14} />
          </button>
          {restoring ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={onCancelRestore} className="text-xs h-6 px-2">
                <X size={11} /> Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={onRestore}
                disabled={isRestoring}
                className="text-xs h-6 px-2 bg-rose-600 hover:bg-rose-500"
                data-testid={`confirm-restore-${backup.id}`}
              >
                {isRestoring ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                Confirm
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={onConfirmRestore}
              className="text-xs h-6 px-2 text-rose-400"
              title="Restore this backup to the volume"
              data-testid={`restore-button-${backup.id}`}
            >
              <RotateCcw size={12} /> Restore
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20',
    running: 'bg-sky-500/10 text-sky-300 ring-sky-500/20',
    failed: 'bg-rose-500/10 text-rose-300 ring-rose-500/20',
    pending: 'bg-slate-500/10 text-slate-300 ring-slate-500/20',
  };
  const cls = map[status] ?? map.pending;
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset ${cls}`}>
      {status}
    </span>
  );
}
