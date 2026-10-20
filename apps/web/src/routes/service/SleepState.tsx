import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun } from 'lucide-react';
import type { Service } from '@ninedeploy/sdk';
import { sleepApi } from '../../lib/sleepApi.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, StatusBadge } from '../../components/ui.js';

type SleepFields = Pick<Service, 'status'> & { asleepAt?: string | null };

/** True when the service is asleep (0.16.11): still `running`, its containers stopped until a request wakes it. */
export const isAsleep = (svc: SleepFields): boolean => svc.status === 'running' && svc.asleepAt != null;

/** "Asleep since 20 Oct 2026, 10:04 — its next request wakes it." */
export function asleepTitle(asleepAt: string): string {
  return `Asleep since ${formatDateTime(asleepAt)} — its next request wakes it`;
}

/**
 * A service's status badge: "asleep" (with since when) while it sleeps,
 * otherwise its status. For the service header and the service cards.
 */
export function ServiceStatusBadge({ svc, since = false }: { svc: SleepFields; since?: boolean }) {
  if (!isAsleep(svc)) return <StatusBadge status={svc.status} />;
  const title = asleepTitle(svc.asleepAt!);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusBadge status="asleep" title={title} />
      {since && (
        <span className="whitespace-nowrap text-xs text-slate-500" title={title}>
          since {formatRelative(svc.asleepAt!)}
        </span>
      )}
    </span>
  );
}

/**
 * The header's sleep actions, next to Restart and Stop: **Wake now** while
 * the service sleeps, **Sleep now** while it is awake with Sleep when idle
 * on. Nothing for a service that is not running, or on an older panel.
 */
export function SleepActions({ svc }: { svc: SleepFields & Pick<Service, 'id' | 'type'> & { sleepAfterMinutes?: number | null } }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['service', svc.id] });
    qc.invalidateQueries({ queryKey: ['services'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);
  const wake = useMutation({
    mutationFn: () => sleepApi.wake(svc.id),
    onSuccess: () => {
      refresh();
      toast('Service woken up', 'success');
    },
    onError: (err) => {
      refresh();
      toast(message(err, 'Could not wake the service'), 'error');
    },
  });
  const sleep = useMutation({
    mutationFn: () => sleepApi.sleep(svc.id),
    onSuccess: () => {
      refresh();
      toast('Service asleep — its next request wakes it', 'success');
    },
    onError: (err) => toast(message(err, 'Could not put the service to sleep'), 'error'),
  });

  if (svc.status !== 'running') return null;
  if (isAsleep(svc)) {
    return (
      <Button variant="secondary" size="md" onClick={() => wake.mutate()} disabled={wake.isPending} title="Start the containers and route the domains back">
        <Sun size={15} /> {wake.isPending ? 'Waking…' : 'Wake now'}
      </Button>
    );
  }
  if (svc.type !== 'docker' || svc.sleepAfterMinutes == null) return null;
  return (
    <Button variant="secondary" size="md" onClick={() => sleep.mutate()} disabled={sleep.isPending} title="Stop the containers now; the next request wakes the service">
      <Moon size={15} /> {sleep.isPending ? 'Sleeping…' : 'Sleep now'}
    </Button>
  );
}
