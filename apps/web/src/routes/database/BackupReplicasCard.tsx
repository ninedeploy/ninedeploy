import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import type { BackupReplica, BackupReplicasView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Input, Select } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

const MAX = 3;

/**
 * G3.3, Database → Backups: more destinations for the scheduled dumps, each
 * keeping its own number of copies. Destinations are operator rows, so
 * editing is for operators; others see the list read-only.
 */
export function BackupReplicasCard({ dbId }: { dbId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const q = useQuery({ queryKey: ['backup-replicas', dbId], queryFn: () => api.backups.replicas.get(dbId), retry: false });
  const destinations = useQuery({ queryKey: ['backup-destinations'], queryFn: () => api.backupDestinations.list(), enabled: isOperator });
  const [rows, setRows] = useState<Array<{ destinationId: string; retainCount: string }>>([]);
  useEffect(() => {
    if (q.data) setRows(q.data.replicas.map((r) => ({ destinationId: String(r.destinationId), retainCount: String(r.retainCount) })));
  }, [q.data]);
  const save = useMutation({
    mutationFn: (replicas: BackupReplica[]) => api.backups.replicas.set(dbId, replicas),
    onSuccess: (view: BackupReplicasView) => {
      qc.setQueryData(['backup-replicas', dbId], view);
      toast(t('Backup replicas saved'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (q.isError || !q.data) return null;
  if (!isOperator && q.data.replicas.length === 0) return null;

  const byId = new Map(q.data.replicas.map((r) => [r.destinationId, r]));
  const names = new Map((destinations.data ?? []).map((d) => [d.id, `${d.name} (${d.bucket})`]));
  const valid = rows.every((r) => /^\d+$/.test(r.destinationId) && /^\d+$/.test(r.retainCount) && Number(r.retainCount) >= 1 && Number(r.retainCount) <= 365) &&
    new Set(rows.map((r) => r.destinationId)).size === rows.length;
  const set = (i: number, patch: Partial<{ destinationId: string; retainCount: string }>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-slate-300">
          <Copy size={15} className="text-slate-500" /> {t('Backup replicas')}
        </div>
        <p className="text-xs text-slate-500">
          {t('Each scheduled dump is also copied to these destinations after the main upload, and each keeps its own number of copies. Not for a local-only schedule.')}
        </p>
        {rows.map((r, i) => {
          const live = byId.get(Number(r.destinationId));
          return (
            <div key={i} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {isOperator ? (
                  <Select value={r.destinationId} onChange={(e) => set(i, { destinationId: e.target.value })} className="h-9 min-w-48 text-xs" aria-label={t('Destination')}>
                    <option value="">{t('Choose a destination')}</option>
                    {(destinations.data ?? []).map((d) => (
                      <option key={d.id} value={String(d.id)}>
                        {d.name} ({d.bucket})
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-xs text-slate-300">{names.get(Number(r.destinationId)) ?? `#${r.destinationId}`}</span>
                )}
                <Input
                  value={r.retainCount}
                  onChange={(e) => set(i, { retainCount: e.target.value })}
                  disabled={!isOperator}
                  inputMode="numeric"
                  className="h-9 w-20 font-mono text-xs"
                  aria-label={t('Copies kept')}
                />
                <span className="text-xs text-slate-500">{t('copies kept')}</span>
                {isOperator && (
                  <Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={t('Remove replica')}>
                    <Trash2 size={13} />
                  </Button>
                )}
              </div>
              {live && (
                <p className="text-xs text-slate-400">
                  {t('{n} copies there', { n: live.copies })}
                  {live.lastCopyAt ? ` · ${t('newest {time}', { time: formatDateTime(live.lastCopyAt) })}` : ''}
                  {live.lastError ? <span className="text-rose-400"> · {live.lastError}</span> : null}
                </p>
              )}
            </div>
          );
        })}
        {isOperator && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { destinationId: '', retainCount: '7' }])} disabled={rows.length >= MAX}>
              <Plus size={13} /> {t('Add replica')}
            </Button>
            <Button
              size="sm"
              onClick={() => save.mutate(rows.map((r) => ({ destinationId: Number(r.destinationId), retainCount: Number(r.retainCount) })))}
              disabled={!valid || save.isPending}
            >
              {t('Save')}
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
