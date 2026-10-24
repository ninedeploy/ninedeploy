import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { Button, ErrorCard } from '../../components/ui.js';

export function PrimaryRecoveryCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient(), { user } = useAuth(), { toast } = useToast();
  const queryKey = ['primary-recovery', serviceId];
  const state = useQuery({ queryKey, queryFn: () => api.services.runtimeRecovery(serviceId),
    refetchInterval: query => query.state.data ? 5000 : 30000 });
  const retry = useMutation({ mutationFn: () => api.services.retryRuntimeRecovery(serviceId), onSuccess: result => {
    qc.setQueryData(queryKey, result.entry);
    void qc.invalidateQueries({ queryKey: ['service', serviceId] });
    toast(result.entry ? 'Recovery is still pending — see the reason below' : 'Primary runtime recovery completed', result.entry ? 'info' : 'success');
  }, onError: () => toast('Recovery could not be checked; retained runtimes remain protected', 'error') });
  if (state.isError) return <ErrorCard title="Could not load primary runtime recovery" error={state.error} onRetry={() => void state.refetch()} />;
  if (!state.data) return null;
  const entry = state.data;
  return <section aria-label="Primary runtime recovery" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
    <h3 className="text-sm font-medium text-amber-200">Primary runtime recovery</h3>
    <p className="mt-1 text-xs text-slate-400">Health and loaded routing are checked before older runtimes are retired. Previous Swarm services stay at zero replicas after their tasks drain. Interrupted deploys are checked automatically after a panel restart.</p>
    <div className="mt-3 space-y-3"><div key={entry.id} className="rounded-lg border border-white/10 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-200">{entry.serverId == null ? 'Panel host' : `Node #${entry.serverId}`}</span>
        <span className="text-amber-300">{entry.busy ? 'Deployment or recovery in progress' : 'Recovery pending'}</span></div>
      {entry.reason && <p className="mt-2 break-words text-slate-300">{entry.reason}</p>}
      {!entry.busy && <p className="mt-1 text-slate-500">Next automatic check: {new Date(entry.nextAttemptAt).toLocaleTimeString()}</p>}
      <details className="mt-2 text-slate-400"><summary className="cursor-pointer">Retained runtimes</summary>
        <dl className="mt-2 space-y-1"><div><dt className="inline">Previous: </dt><dd className="inline break-all font-mono">{entry.previousRuntimeId ?? 'None'}</dd></div>
          <div><dt className="inline">Candidate: </dt><dd className="inline break-all font-mono">{entry.candidateRuntimeId}</dd></div></dl>
      </details>
    </div></div>
    {user?.isOperator && <Button size="sm" variant="secondary" className="mt-3" disabled={retry.isPending || entry.busy} onClick={() => retry.mutate()}>
      {retry.isPending ? 'Checking recovery…' : 'Retry recovery'}
    </Button>}
  </section>;
}
