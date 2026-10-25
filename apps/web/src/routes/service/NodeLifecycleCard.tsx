import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceLifecycleCommand, ServiceLifecycleView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Button } from '../../components/ui.js';
import { useToast } from '../../components/Toast.js';

export function NodeLifecycleCard({ serviceId, command }: { serviceId: number; command: ServiceLifecycleCommand | null }) {
  const qc = useQueryClient(), { toast } = useToast();
  const retry = useMutation({ mutationFn: (id: number) => api.services.retryLifecycle(id), onSuccess: (result, id) => {
    if (!result.command) { void qc.invalidateQueries({ queryKey: ['service-lifecycle', id] }); return; }
    const known = qc.getQueryData<ServiceLifecycleView>(['service-lifecycle', id])?.command;
    if (known && (known.id > result.command.id || known.id === result.command.id && ['completed', 'superseded'].includes(known.phase))) {
      void qc.invalidateQueries({ queryKey: ['service-lifecycle', id] }); return;
    }
    qc.setQueryData(['service-lifecycle', id], { command: result.command });
    void qc.invalidateQueries({ queryKey: ['service-lifecycle', id] });
    if (id === serviceId) toast('Runtime command queued for another check', 'info');
  }, onError: (error, id) => {
    if (id === serviceId) toast(error instanceof Error ? error.message : 'Runtime command could not be retried', 'error');
  } });
  if (!command || command.phase === 'completed') return null;
  const superseded = command.phase === 'superseded' || !command.current;
  return <section aria-label="Runtime command" className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium text-amber-200">{superseded ? 'Runtime command superseded' : `${{ start: 'Start', stop: 'Stop', restart: 'Restart' }[command.action]} requested`}</h3>
      <span className="text-xs text-slate-400">Command #{command.id}</span>
    </div>
    <p className="mt-2 text-xs text-slate-300">{superseded ? 'The service state changed before this command finished. Request a new action if needed.'
      : command.action === 'stop' ? 'Stop is pending until traffic removal, connection drain and container state are confirmed.'
      : 'The service is not reported ready until configured readiness and routing checks finish.'}</p>
    {command.reason && <p className="mt-2 break-words text-xs text-amber-200">{command.reason}</p>}
    {!superseded && <p className="mt-2 text-xs text-slate-400">{command.busy ? 'Checking runtime state…' : `Next automatic check: ${new Date(command.nextAttemptAt).toLocaleTimeString()}`}</p>}
    {command.retryable && !superseded && <Button className="mt-3" size="sm" variant="secondary" disabled={retry.isPending || command.busy} onClick={() => retry.mutate(serviceId)}>
      {retry.isPending ? 'Queueing…' : 'Retry runtime command'}
    </Button>}
  </section>;
}
