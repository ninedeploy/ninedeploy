import { useQuery } from '@tanstack/react-query';
import type { MonitorView } from '@ninedeploy/schemas';
import { Sparkline } from '../Sparkline.js';
import { cn } from '../ui.js';
import { uptimeApi, uptimeKeys } from '../../lib/uptimeApi.js';
import { formatUptime, monitorStatusUi, sparklinePoints, UPTIME_TONE_TEXT, uptimeTone } from '../../lib/uptime.js';
import { useT } from '../../lib/i18n.js';

/** The UP / DOWN / PENDING / PAUSED pill with its dot. */
export function MonitorStatusBadge({ status }: { status: MonitorView['status'] }) {
  const ui = monitorStatusUi(status);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold tracking-wider ring-1 ring-inset',
        ui.badge,
        status === 'down' && 'animate-pulse',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', ui.dot)} />
      {ui.label}
    </span>
  );
}

/** An uptime percent coloured by how healthy it is. */
export function UptimeValue({ pct, className }: { pct: number | null; className?: string }) {
  return <span className={cn('tabular-nums', UPTIME_TONE_TEXT[uptimeTone(pct)], className)}>{formatUptime(pct)}</span>;
}

/** Response times over the last 24 hours as a sparkline. */
export function MonitorSpark({ monitor, width = 120, height = 28 }: { monitor: MonitorView; width?: number; height?: number }) {
  const t = useT();
  const checks = useQuery({
    queryKey: uptimeKeys.checks(monitor.id, 24),
    queryFn: () => uptimeApi.monitors.checks(monitor.id, 24),
    refetchInterval: 60_000,
    retry: false,
  });
  const points = sparklinePoints(checks.data ?? []);
  return (
    <span className="inline-block shrink-0" title={points.length > 0 ? t('Response time, last 24 hours ({n} checks)', { n: points.length }) : t('No response times yet')}>
      <Sparkline points={points} color={monitorStatusUi(monitor.status).spark} width={width} height={height} />
    </span>
  );
}
