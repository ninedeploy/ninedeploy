import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import type { PendingChange } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { onStaged, setServiceStaging } from '../../lib/pendingStaging.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Switch } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** The whole value: a reviewer must see exactly what applies (security review). */
const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

/**
 * Service → Settings, at the top (G5.2): stage edits instead of applying
 * them one by one, review them as a diff, and apply them together, with a
 * deploy if wanted (which an approval-gated lane then holds for review).
 */
export function PendingChangesTray({ serviceId }: { serviceId: number }) {
  const t = useT();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['pending', serviceId], queryFn: () => api.services.pending.get(serviceId) });
  const staging = q.data?.staging ?? false;
  const [vouch, setVouch] = useState(false);

  useEffect(() => {
    setServiceStaging(serviceId, staging);
  }, [serviceId, staging]);
  // Leaving the page: edits elsewhere apply directly again until the tray loads.
  useEffect(() => () => setServiceStaging(serviceId, false), [serviceId]);
  useEffect(() => onStaged(() => void qc.invalidateQueries({ queryKey: ['pending', serviceId] })), [qc, serviceId]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['pending', serviceId] });
    void qc.invalidateQueries({ queryKey: ['service', serviceId] });
  };
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.services.pending.setStaging(serviceId, on),
    onSuccess: (view) => qc.setQueryData(['pending', serviceId], view),
    onError: (err) => toast(errorText(err), 'error'),
  });
  const discard = useMutation({
    mutationFn: () => api.services.pending.discard(serviceId),
    onSuccess: (view) => {
      qc.setQueryData(['pending', serviceId], view);
      toast(t('Pending changes discarded'), 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  const apply = useMutation({
    mutationFn: (deploy: boolean) => api.services.pending.apply(serviceId, { deploy, includeOthers: vouch, version: q.data?.updatedAt ?? null }),
    onSuccess: (res) => {
      setVouch(false);
      refresh();
      void qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
      toast(
        res.deploymentId ? t('{n} changes applied; deploy #{id} queued', { n: res.applied.length, id: res.deploymentId }) : t('{n} changes applied', { n: res.applied.length }),
        'success',
      );
    },
    onError: (err) => {
      refresh();
      toast(t('Could not apply the changes: {error}', { error: errorText(err) }), 'error');
    },
  });

  if (!q.data) return null;
  const changes: PendingChange[] = q.data.changes;
  const me = user?.id ?? null;
  const fromOthers = changes.filter((c) => c.stagedByUserId !== me);
  const busy = apply.isPending || discard.isPending || (fromOthers.length > 0 && !vouch);

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-slate-300">
            <Layers size={15} className="text-slate-500" /> {t('Pending changes')}
            {changes.length > 0 && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-200">{changes.length}</span>}
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            {t('Stage edits before applying')}
            <Switch checked={staging} onChange={(on) => toggle.mutate(on)} disabled={toggle.isPending} label={t('Stage edits before applying')} />
          </label>
        </div>
        {staging && changes.length === 0 && (
          <p className="text-xs text-slate-500">{t('Edits below collect here instead of applying at once. Review them, then apply them together.')}</p>
        )}
        {changes.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{t('Field')}</th>
                    <th className="py-1 pr-3 font-medium">{t('Now')}</th>
                    <th className="py-1 pr-3 font-medium">{t('After')}</th>
                    <th className="py-1 font-medium">{t('Staged by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.field} className="border-t border-white/[0.05] align-top">
                      <td className="py-1 pr-3 font-mono text-slate-300">{c.field}</td>
                      <td className="whitespace-pre-wrap break-all py-1 pr-3 font-mono text-rose-200/80">{c.masked ? <span className="text-slate-500">{t('hidden')}</span> : show(c.current)}</td>
                      <td className="whitespace-pre-wrap break-all py-1 pr-3 font-mono text-emerald-200">{c.masked ? <span className="text-slate-500">{t('hidden')}</span> : show(c.next)}</td>
                      <td className={c.stagedByUserId === me ? 'py-1 text-slate-400' : 'py-1 text-amber-200'}>{c.stagedBy ?? t('unknown')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {fromOthers.length > 0 && (
              <label className="flex items-start gap-2 text-xs text-amber-200">
                <input type="checkbox" checked={vouch} onChange={(e) => setVouch(e.target.checked)} className="mt-0.5" />
                {t('{n} of these changes were staged by someone else. They apply with your permissions: I reviewed them.', { n: fromOthers.length })}
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => apply.mutate(true)} disabled={busy}>
                {t('Apply and deploy')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => apply.mutate(false)} disabled={busy}>
                {t('Apply only')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => discard.mutate()} disabled={busy}>
                {t('Discard')}
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
