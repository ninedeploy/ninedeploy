import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import type { AutoscaleEvent, AutoscaleMetric } from '@ninedeploy/schemas';
import { autoscaleApi, autoscaleKeys } from '../../lib/autoscaleApi.js';
import { formatRelative } from '../../lib/format.js';
import { Button, Card, CardBody } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

/** "62.5%" / "12 req/s"; a dash when the value could not be read. */
export function autoscaleValue(value: number | null | undefined, metric: AutoscaleMetric | undefined): string {
  if (value == null) return '—';
  return metric === 'rps' ? `${value} req/s` : `${value}%`;
}

/** "2 → 3, 4m ago: cpu 80% per container over 60s (target 50%)". */
export function autoscaleEventLine(ev: AutoscaleEvent): string {
  return `${ev.from} → ${ev.to}, ${formatRelative(ev.at)}: ${ev.reason}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-2">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words font-mono text-[12px] text-slate-200">{value}</dd>
    </div>
  );
}

/**
 * 0.16.10: what the autoscaler sees and did last, polled every 15 s while
 * `enabled` (the Overview is open and the service has autoscaling on).
 * Keeps an unavailable status visible; cached figures are hidden on error.
 */
export function AutoscalePanel({ serviceId, enabled }: { serviceId: number; enabled: boolean }) {
  const t = useT();
  const q = useQuery({
    queryKey: autoscaleKeys.status(serviceId),
    queryFn: () => autoscaleApi.status(serviceId),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
    retry: false,
  });
  if (!enabled || (!q.isError && q.data?.enabled === false)) return null;
  const view = !q.isError && q.data?.enabled ? q.data : null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <Gauge size={16} className="text-indigo-200" />
            <span className="text-sm font-semibold text-slate-100">{t('Autoscaling')}</span>
          </div>
          <span className="whitespace-nowrap rounded-full bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-slate-400">{q.isError ? t('Unavailable') : t('Updates every 15s')}</span>
        </div>

        {q.isError ? (
          <div role="alert" className="space-y-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">
            <p>{t('Autoscaling status is unavailable. Current measurements and decisions could not be confirmed.')}</p>
            <Button size="sm" variant="secondary" disabled={q.isFetching} onClick={() => void q.refetch()}>{t('Retry status')}</Button>
          </div>
        ) : !view ? <p role="status" className="text-xs text-slate-400">{t('Loading autoscaling status…')}</p> : <>
        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <Stat label={t('Containers serving')} value={t('{replicas} of {min}–{max}', { replicas: String(view.replicas), min: String(view.minReplicas), max: String(view.maxReplicas) })} />
          <Stat
            label={t('{metric} per container', { metric: String(view.metric) })}
            value={t('{value} · target {target}', { value: autoscaleValue(view.value, view.metric), target: autoscaleValue(view.target, view.metric) })}
          />
          <Stat label={t('Desired')} value={view.desired != null ? String(view.desired) : '—'} />
        </dl>

        {view.holding && <p role="status" className="break-words rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">{t('Holding: {reason}.', { reason: view.holding })}</p>}
        <p className="break-words text-xs text-slate-400">
          <span className="text-slate-500">{t('Last change: ')}</span>
          {view.lastEvent ? autoscaleEventLine(view.lastEvent) : t('none yet')}
        </p>
        </>}
      </CardBody>
    </Card>
  );
}
