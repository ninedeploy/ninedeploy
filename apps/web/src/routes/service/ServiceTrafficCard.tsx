import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import type { TrafficRange } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { Card, CardBody, ErrorCard, Skeleton } from '../../components/ui.js';
import { TrafficChart, TrafficRangePicker, TrafficScopeTable, TrafficTotals } from '../../components/traffic/TrafficChart.js';

/**
 * Per-service traffic (0.15): requests by status class, latency and bytes for
 * the service's domains, from `GET /v1/services/:id/traffic` (any seat on the
 * service). With analytics off the card says so instead of drawing zeros.
 */
export function ServiceTrafficCard({ serviceId }: { serviceId: number }) {
  const [range, setRange] = useState<TrafficRange>('24h');
  const q = useQuery({
    queryKey: ['service-traffic', serviceId, range],
    queryFn: () => api.traffic.service(serviceId, { range }),
    refetchInterval: 60_000,
  });

  return (
    <Card className="mt-6">
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <BarChart3 size={15} className="text-slate-500" /> Traffic
          </div>
          {q.data?.enabled && <TrafficRangePicker value={range} onChange={setRange} />}
        </div>
        {q.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : q.isError || !q.data ? (
          <ErrorCard title="Couldn't load the traffic for this service" error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.enabled ? (
          <p className="text-xs text-slate-500">
            Traffic analytics is off. An operator can turn it on in Traefik → Traffic (it restarts the proxy once).
          </p>
        ) : (
          <>
            <TrafficTotals totals={q.data.totals} />
            <TrafficChart series={q.data.series} />
            <TrafficScopeTable rows={q.data.domains} empty="No domain of this service received traffic in this range." />
          </>
        )}
      </CardBody>
    </Card>
  );
}
