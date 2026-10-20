import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import type { AutoscaleEvent, AutoscaleMetric } from '@ninedeploy/schemas';
import { autoscaleApi, autoscaleKeys } from '../../lib/autoscaleApi.js';
import { formatRelative } from '../../lib/format.js';
import { Card, CardBody } from '../../components/ui.js';

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
 * Renders nothing when autoscaling is off or the status cannot be read.
 */
export function AutoscalePanel({ serviceId, enabled }: { serviceId: number; enabled: boolean }) {
  const q = useQuery({
    queryKey: autoscaleKeys.status(serviceId),
    queryFn: () => autoscaleApi.status(serviceId),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
    retry: false,
  });
  const view = enabled && !q.isError && q.data?.enabled ? q.data : null;
  if (!view) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <Gauge size={16} className="text-indigo-200" />
            <span className="text-sm font-semibold text-slate-100">Autoscaling</span>
          </div>
          <span className="whitespace-nowrap rounded-full bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-slate-400">Live 15s</span>
        </div>

        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <Stat label="Containers serving" value={`${view.replicas} of ${view.minReplicas}–${view.maxReplicas}`} />
          <Stat
            label={`${view.metric} per container`}
            value={`${autoscaleValue(view.value, view.metric)} · target ${autoscaleValue(view.target, view.metric)}`}
          />
          <Stat label="Desired" value={view.desired != null ? String(view.desired) : '—'} />
        </dl>

        {view.holding && <p className="text-xs text-slate-500">Holding: {view.holding}.</p>}
        <p className="break-words text-xs text-slate-400">
          <span className="text-slate-500">Last change: </span>
          {view.lastEvent ? autoscaleEventLine(view.lastEvent) : 'none yet'}
        </p>
      </CardBody>
    </Card>
  );
}
