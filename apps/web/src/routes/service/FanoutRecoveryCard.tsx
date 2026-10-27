import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { Button, ErrorCard } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

export function FanoutRecoveryCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const qc = useQueryClient(), { user } = useAuth(), { toast } = useToast();
  const queryKey = ['fanout-recovery', serviceId];
  const state = useQuery({ queryKey, queryFn: () => api.fanout.recovery(serviceId),
    refetchInterval: query => query.state.data?.length ? 5000 : 30000 });
  const retry = useMutation({ mutationFn: () => api.fanout.retryRecovery(serviceId), onSuccess: result => {
    qc.setQueryData(queryKey, result.entries);
    void qc.invalidateQueries({ queryKey: ['fanout-targets', serviceId] });
    toast(result.entries.length ? t('Recovery is still pending — see the reason below') : t('Fan-out recovery completed'), result.entries.length ? 'info' : 'success');
  }, onError: () => toast(t('Recovery could not be checked; retained runtimes remain protected'), 'error') });
  if (state.isError) return <ErrorCard title={t('Could not load fan-out recovery')} error={state.error} onRetry={() => void state.refetch()} />;
  if (!state.data?.length) return null;
  return <section aria-label={t('Fan-out recovery')} className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
    <h3 className="text-sm font-medium text-amber-200">{t('Fan-out recovery')}</h3>
    <p className="mt-1 text-xs text-slate-400">{t('Health and routing are checked before obsolete containers are removed. Automatic retries continue after a panel restart.')}</p>
    <div className="mt-3 space-y-3">{state.data.map(entry => <div key={entry.id} className="rounded-lg border border-white/10 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-200">{t('Node #{id}', { id: entry.serverId })}</span>
        <span className="text-amber-300">{entry.busy ? t('Deployment or recovery in progress') : t('Recovery pending')}</span></div>
      {entry.reason && <p className="mt-2 break-words text-slate-300">{entry.reason}</p>}
      {!entry.busy && <p className="mt-1 text-slate-500">{t('Next automatic check: {time}', { time: new Date(entry.nextAttemptAt).toLocaleTimeString() })}</p>}
      <details className="mt-2 text-slate-400"><summary className="cursor-pointer">{t('Retained runtimes')}</summary>
        <dl className="mt-2 space-y-1"><div><dt className="inline">{t('Previous:')}{' '}</dt><dd className="inline break-all font-mono">{entry.previousRuntimeId ?? t('None')}</dd></div>
          <div><dt className="inline">{t('Candidate:')}{' '}</dt><dd className="inline break-all font-mono">{entry.candidateRuntimeId}</dd></div></dl>
      </details>
    </div>)}</div>
    {user?.isOperator && <Button size="sm" variant="secondary" className="mt-3" disabled={retry.isPending || state.data.every(e => e.busy)} onClick={() => retry.mutate()}>
      {retry.isPending ? t('Checking recovery…') : t('Retry recovery')}
    </Button>}
  </section>;
}
