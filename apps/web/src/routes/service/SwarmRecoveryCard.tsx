import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { Button, ErrorCard } from '../../components/ui.js';

const PHASES = { prepared: 'Update prepared', submitted: 'Native update submitted', ready: 'Tasks verified', routing: 'Confirming traffic', retained: 'Waiting for review' };
export function SwarmRecoveryCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient(), { user } = useAuth(), { toast } = useToast();
  const queryKey = ['swarm-recovery', serviceId];
  const state = useQuery({ queryKey, queryFn: () => api.services.swarmRecovery(serviceId), refetchInterval: query => query.state.data ? 5000 : 30000 });
  const retry = useMutation({ mutationFn: () => api.services.retrySwarmRecovery(serviceId), onSuccess: result => {
    qc.setQueryData(queryKey, result.entry); void qc.invalidateQueries({ queryKey: ['service', serviceId] });
    toast(result.entry ? 'Swarm recovery is still pending — see the reason below' : 'Swarm recovery completed', result.entry ? 'info' : 'success');
  }, onError: () => toast('Swarm recovery could not be confirmed; the service remains protected', 'error') });
  if (state.isError) return <ErrorCard title="Could not load Swarm recovery" error={state.error} onRetry={() => void state.refetch()} />;
  if (!state.data) return null;
  const entry = state.data;
  return <section aria-label="Swarm runtime recovery" className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
    <h3 className="text-sm font-medium text-amber-200">Swarm runtime recovery</h3>
    <p className="mt-1 text-xs text-slate-400">Interrupted updates resume the original deployment after the manager, task images and routing are checked. Previous Docker containers stay protected until cutover is confirmed. Builds and host hooks are not replayed.</p>
    <div className="mt-3 rounded-lg border border-white/10 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-200">Deployment #{entry.deploymentId}</span>
        <span className="text-amber-300">{entry.busy ? 'Deployment or recovery in progress' : PHASES[entry.phase]}</span></div>
      {entry.reason && <p className="mt-2 break-words text-slate-300">{entry.reason}</p>}
      {!entry.busy && <p className="mt-1 text-slate-500">Next automatic check: {new Date(entry.nextAttemptAt).toLocaleTimeString()}</p>}
    </div>
    {user?.isOperator && <Button size="sm" variant="secondary" className="mt-3" disabled={retry.isPending || entry.busy} onClick={() => retry.mutate()}>{retry.isPending ? 'Checking recovery…' : 'Retry recovery'}</Button>}
  </section>;
}
