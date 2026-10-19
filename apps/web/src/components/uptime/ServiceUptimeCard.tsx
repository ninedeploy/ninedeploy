import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HeartPulse, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { formatRelative } from '../../lib/format.js';
import { formatResponseMs, type MonitorForm, serviceMonitorTarget } from '../../lib/uptime.js';
import { uptimeApi, uptimeKeys } from '../../lib/uptimeApi.js';
import { Button, Card, CardBody } from '../ui.js';
import { MonitorFormModal } from './MonitorFormModal.js';
import { MonitorStatusBadge, UptimeValue } from './MonitorBits.js';

/**
 * Service → Overview: the uptime monitors attached to this service. Hidden
 * for a member when the service has none (or the panel has no monitors API);
 * operators always see it, with "Add monitor" prefilled for the service.
 */
export function ServiceUptimeCard({ serviceId, svc }: { serviceId: number; svc: Pick<Service, 'name'> & { autoUrl?: string | null } }) {
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const qc = useQueryClient();
  const [prefill, setPrefill] = useState<Partial<MonitorForm> | null>(null);
  const monitors = useQuery({
    queryKey: uptimeKeys.monitorList(serviceId),
    queryFn: () => uptimeApi.monitors.list(serviceId),
    refetchInterval: 30_000,
    retry: false,
  });

  const list = monitors.data ?? [];
  if (monitors.isError) return null;
  if (!isOperator && list.length === 0) return null;

  const openNew = async () => {
    // The service's first domain makes the starting URL; the list may not be loaded on this tab yet.
    const domains = await qc
      .fetchQuery({ queryKey: ['domains', serviceId], queryFn: () => api.domains.list(serviceId), staleTime: 30_000 })
      .catch(() => undefined);
    setPrefill({ serviceId: String(serviceId), name: svc.name, target: serviceMonitorTarget(domains, svc.autoUrl) });
  };

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] pb-3">
          <div className="flex items-center gap-2">
            <HeartPulse size={16} className="text-indigo-400" />
            <span className="text-sm font-semibold text-slate-100">Uptime</span>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/monitoring" className="text-xs text-indigo-400 hover:text-indigo-300">
              All monitors
            </Link>
            {isOperator && (
              <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => void openNew()}>
                <Plus size={12} /> Add monitor
              </Button>
            )}
          </div>
        </div>
        {monitors.isLoading ? (
          <p className="text-xs text-slate-500">Loading monitors…</p>
        ) : list.length === 0 ? (
          <p className="text-xs leading-relaxed text-slate-500">
            No monitors for this service. Add one to check its URL from the panel every minute and get notified when it goes down.
          </p>
        ) : (
          <ul className="space-y-1.5" aria-label="Service monitors">
            {list.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-inset ring-white/5">
                <MonitorStatusBadge status={m.status} />
                <div className="min-w-0 flex-1 basis-40">
                  <div className="truncate text-sm font-medium text-slate-200">{m.name}</div>
                  <div className="truncate font-mono text-[11px] text-slate-500" title={m.target}>
                    {m.target}
                  </div>
                </div>
                <div className="shrink-0 text-right text-[11px] text-slate-500">
                  <div>
                    24h <UptimeValue pct={m.uptime.h24} className="font-semibold" />
                  </div>
                  <div>
                    {formatResponseMs(m.lastResponseMs)}
                    {m.lastCheckedAt ? ` · ${formatRelative(m.lastCheckedAt)}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      {prefill && <MonitorFormModal prefill={prefill} onClose={() => setPrefill(null)} />}
    </Card>
  );
}
