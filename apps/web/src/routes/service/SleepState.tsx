import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun } from 'lucide-react';
import type { Service, ServiceLifecycleCommand, ServiceLifecycleView } from '@ninedeploy/sdk';
import { sleepApi } from '../../lib/sleepApi.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, StatusBadge } from '../../components/ui.js';
import { type Translate, translate, useT } from '../../lib/i18n.js';

const ENGLISH: Translate = (text, vars) => translate('en', text, vars);

type SleepFields = Pick<Service, 'status'> & { asleepAt?: string | null };

/** True when the service is asleep (0.16.11): still `running`, its containers stopped until a request wakes it. */
export const isAsleep = (svc: SleepFields): boolean => svc.status === 'running' && svc.asleepAt != null;

/** "Asleep since 20 Oct 2026, 10:04 — its next request wakes it." */
export function asleepTitle(asleepAt: string, t: Translate = ENGLISH): string {
  return t('Asleep since {time} — its next request wakes it', { time: formatDateTime(asleepAt) });
}

/**
 * A service's status badge: "asleep" (with since when) while it sleeps,
 * otherwise its status. For the service header and the service cards.
 */
export function ServiceStatusBadge({ svc, since = false }: { svc: SleepFields; since?: boolean }) {
  const t = useT();
  if (!isAsleep(svc)) return <StatusBadge status={svc.status} />;
  const title = asleepTitle(svc.asleepAt!, t);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusBadge status="asleep" title={title} />
      {since && (
        <span className="whitespace-nowrap text-xs text-slate-500" title={title}>
          {t('since {time}', { time: formatRelative(svc.asleepAt!) })}
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
export function SleepActions({ svc, command }: { svc: SleepFields & Pick<Service, 'id' | 'type'> & { sleepAfterMinutes?: number | null; serverId?: number | null }; command?: ServiceLifecycleCommand | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['service-sleep', svc.id], queryFn: () => sleepApi.status(svc.id),
    enabled: svc.serverId != null && svc.type === 'docker', refetchInterval: 5000, retry: false });
  const refresh = (serviceId = svc.id) => {
    qc.invalidateQueries({ queryKey: ['service', serviceId] });
    qc.invalidateQueries({ queryKey: ['services'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['service-sleep', serviceId] });
  };
  const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);
  const wake = useMutation({
    mutationFn: (serviceId: number) => sleepApi.wake(serviceId),
    onSuccess: (result, serviceId) => {
      refresh(serviceId);
      if (result.pending) {
        const key = ['service-lifecycle', serviceId];
        const known = qc.getQueryData<ServiceLifecycleView>(key)?.command;
        if (known && result.lifecycle && (known.id > result.lifecycle.id || known.id === result.lifecycle.id && ['completed', 'superseded'].includes(known.phase))) {
          void qc.invalidateQueries({ queryKey: key }); return;
        }
        qc.setQueryData(key, { command: result.lifecycle ?? null });
        void qc.invalidateQueries({ queryKey: key });
        if (serviceId === svc.id) toast(result.lifecycle?.phase === 'superseded' ? t('Start request superseded by a newer action') : t('Start requested; runtime verification is pending'), 'info');
        return;
      }
      if (serviceId === svc.id) toast(t('Service woken up'), 'success');
    },
    onError: (err, serviceId) => {
      refresh(serviceId);
      if (serviceId === svc.id) toast(message(err, t('Could not wake the service')), 'error');
    },
  });
  const busyCommand = command?.current === true && !['completed', 'superseded'].includes(command.phase);
  // Only a running node controller performs the wake; with automatic node
  // recovery off a "waking" or "held" journal waits for this button.
  const automaticWake = status.data?.phase === 'waking' && status.data.nodeControllerActive;
  // R2: a node sleep interrupted before Stop keeps the domains on the wake
  // catcher with asleepAt null; with recovery off, only Wake settles it.
  const heldOnCatcher = svc.serverId != null && status.data != null && !status.data.nodeControllerActive &&
    (status.data.phase === 'held' || status.data.phase === 'waking');
  const wakingCurrent = wake.isPending && wake.variables === svc.id || busyCommand && command?.action === 'start' || automaticWake;
  const sleep = useMutation({
    mutationFn: () => sleepApi.sleep(svc.id),
    onSuccess: () => {
      refresh();
      toast(t('Service asleep — its next request wakes it'), 'success');
    },
    onError: (err) => toast(message(err, t('Could not put the service to sleep')), 'error'),
  });

  if (svc.status !== 'running') return null;
  if (isAsleep(svc) || heldOnCatcher) {
    return (
      <Button variant="secondary" size="md" onClick={() => wake.mutate(svc.id)} disabled={wakingCurrent || busyCommand} title={t('Start the containers and route the domains back')}>
        <Sun size={15} /> {wakingCurrent ? t('Waking…') : t('Wake now')}
      </Button>
    );
  }
  if (svc.type !== 'docker' || svc.sleepAfterMinutes == null || svc.serverId != null) return null;
  return (
    <Button variant="secondary" size="md" onClick={() => sleep.mutate()} disabled={sleep.isPending || busyCommand} title={t('Stop the containers now; the next request wakes the service')}>
      <Moon size={15} /> {sleep.isPending ? t('Sleeping…') : t('Sleep now')}
    </Button>
  );
}

/** Node idle observations come from the serving node rather than panel traffic analytics. */
export function NodeSleepState({ svc }: { svc: Pick<Service, 'id' | 'type' | 'serverId'> & { sleepAfterMinutes?: number | null; asleepAt?: string | null } }) {
  const t = useT();
  const show = svc.serverId != null && svc.type === 'docker' && (svc.sleepAfterMinutes != null || svc.asleepAt != null);
  const status = useQuery({ queryKey: ['service-sleep', svc.id], queryFn: () => sleepApi.status(svc.id), enabled: show, refetchInterval: 5000, retry: false });
  if (!show) return null;
  const state = status.data;
  const text = status.isError ? t('Could not load node sleep status') : !state ? t('Loading node sleep status…')
    : state.phase === 'asleep' ? state.nodeControllerActive ? t('Asleep — its next request wakes it') : t('Automatic node wake is paused — use Wake now')
      : state.phase === 'waking' ? t('Waking — application readiness and routing are pending')
        : state.phase === 'sleeping' ? t('Preparing verified sleep routing')
          : state.phase === 'held' ? t('Node verification is pending')
            : state.phase === 'disabled' ? t('Automatic sleep is off')
              : state.phase === 'unsupported' ? t('Scale to zero requires an ordinary Docker service')
                : state.idleMs == null ? t('Waiting for verified node idle coverage')
                  : t('Verified idle: {seconds}s / {required}s', { seconds: Math.floor(state.idleMs / 1000), required: Math.floor((state.requiredMs ?? 0) / 1000) });
  return <div className="mt-3 text-xs text-slate-400" role="status"><p>{text}</p>{state?.holding && <p className="mt-1">{state.holding}</p>}</div>;
}
