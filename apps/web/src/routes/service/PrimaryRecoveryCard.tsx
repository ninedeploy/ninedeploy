import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { Button, ErrorCard } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

export function PrimaryRecoveryCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const qc = useQueryClient(), { user } = useAuth(), { toast } = useToast();
  const queryKey = ['primary-recovery', serviceId];
  const state = useQuery({ queryKey, queryFn: () => api.services.runtimeRecovery(serviceId),
    refetchInterval: query => query.state.data ? 5000 : 30000 });
  const preparations = useQuery({ queryKey: ['node-preparations', serviceId], queryFn: () => api.services.nodePreparations(serviceId),
    refetchInterval: query => query.state.data?.length ? 5000 : 30000 });
  const retry = useMutation({ mutationFn: () => api.services.retryRuntimeRecovery(serviceId), onSuccess: result => {
    qc.setQueryData(queryKey, result.entry);
    void qc.invalidateQueries({ queryKey: ['service', serviceId] });
    toast(result.entry ? t('Recovery is still pending — see the reason below') : t('Primary runtime recovery completed'), result.entry ? 'info' : 'success');
  }, onError: () => toast(t('Recovery could not be checked; retained runtimes remain protected'), 'error') });
  const pending = preparations.data ?? [];
  const preparationNotice = pending.length > 0 && <section aria-label={t('Node deployment preparation')} className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
    <h3 className="text-sm font-medium text-amber-200">{t('Node deployment preparation')}</h3>
    {pending.map(item => <p key={item.deploymentId} className="mt-2 text-xs text-slate-300">{t('Deployment #{id} on node #{node}: {phase} ({status})', { id: item.deploymentId, node: item.serverId, phase: item.phase, status: item.deploymentStatus })}</p>)}
    <p className="mt-2 text-xs text-slate-400">{t('A pending preparation can hold later deployments. If the deployment has stopped, use the service Stop action to settle its node candidates; this also stops the service.')}</p>
  </section>;
  const preparationError = preparations.isError && <ErrorCard title={t('Could not load node preparation status')} error={preparations.error} onRetry={() => void preparations.refetch()} />;
  const recoveryError = state.isError && <ErrorCard title={t('Could not load primary runtime recovery')} error={state.error} onRetry={() => void state.refetch()} />;
  if (!state.data) return <>{preparationNotice}{preparationError}{recoveryError}</>;
  const entry = state.data;
  return <>{preparationNotice}{preparationError}<section aria-label={t('Primary runtime recovery')} className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
    <h3 className="text-sm font-medium text-amber-200">{t('Primary runtime recovery')}</h3>
    <p className="mt-1 text-xs text-slate-400">{t('Health and loaded routing are checked before older runtimes are retired. Previous Swarm services stay at zero replicas after their tasks drain. Interrupted deploys are checked automatically after a panel restart.')}</p>
    <div className="mt-3 space-y-3"><div key={entry.id} className="rounded-lg border border-white/10 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-200">{entry.serverId == null ? t('Panel host') : t('Node #{id}', { id: entry.serverId })}</span>
        <span className="text-amber-300">{entry.busy ? t('Deployment or recovery in progress') : t('Recovery pending')}</span></div>
      {entry.reason && <p className="mt-2 break-words text-slate-300">{entry.reason}</p>}
      {!entry.busy && <p className="mt-1 text-slate-500">{t('Next automatic check: {time}', { time: new Date(entry.nextAttemptAt).toLocaleTimeString() })}</p>}
      <details className="mt-2 text-slate-400"><summary className="cursor-pointer">{t('Retained runtimes')}</summary>
        <dl className="mt-2 space-y-1"><div><dt className="inline">{t('Previous:')}{' '}</dt><dd className="inline break-all font-mono">{entry.previousRuntimeId ?? t('None')}</dd></div>
          <div><dt className="inline">{t('Candidate:')}{' '}</dt><dd className="inline break-all font-mono">{entry.candidateRuntimeId}</dd></div></dl>
      </details>
    </div></div>
    {user?.isOperator && <Button size="sm" variant="secondary" className="mt-3" disabled={retry.isPending || entry.busy} onClick={() => retry.mutate()}>
      {retry.isPending ? t('Checking recovery…') : t('Retry recovery')}
    </Button>}
  </section></>;
}
