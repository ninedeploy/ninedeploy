import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle, BarChart3 } from 'lucide-react';
import type { TrafficRange, TrafficSettingsUpdate, TrafficSettingsView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatBytes, formatRelative } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ErrorCard, Field, Input, Modal, Skeleton, Switch } from '../../components/ui.js';
import { TrafficChart, TrafficRangePicker, TrafficScopeTable, TrafficTotals } from '../../components/traffic/TrafficChart.js';

const STATUS_TONE: Record<TrafficSettingsView['status'], 'neutral' | 'amber' | 'emerald' | 'rose'> = {
  off: 'neutral',
  starting: 'amber',
  running: 'emerald',
  error: 'rose',
};

/**
 * Traefik → Traffic (operator only, 0.15): the opt-in analytics switch and the
 * instance summary. Turning analytics on or off recreates Traefik once; the
 * panel itself may be served through Traefik, so the PUT answer can be lost to
 * the restart — on a network error the card re-reads the settings instead of
 * guessing.
 */
export function TrafficAnalyticsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [range, setRange] = useState<TrafficRange>('24h');
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const [retention, setRetention] = useState<string | null>(null);

  const settings = useQuery({ queryKey: ['traffic-settings'], queryFn: () => api.traffic.settings.get(), refetchInterval: 30_000 });
  const enabled = settings.data?.enabled === true;
  const summary = useQuery({
    queryKey: ['traffic-summary', range],
    queryFn: () => api.traffic.summary({ range }),
    enabled,
    refetchInterval: 60_000,
  });

  const save = useMutation({
    mutationFn: (input: TrafficSettingsUpdate) => api.traffic.settings.set(input),
    onSuccess: (view) => {
      qc.setQueryData(['traffic-settings'], view);
      qc.invalidateQueries({ queryKey: ['traffic-summary'] });
      setRetention(null);
      toast('Traffic analytics settings saved', 'success');
    },
    onError: (err: unknown) => {
      // Without an HTTP status the answer never arrived (Traefik was being
      // recreated under this very request): the server's state is the truth.
      const status = (err as { status?: number } | null)?.status;
      void qc.invalidateQueries({ queryKey: ['traffic-settings'] });
      toast(
        status ? (err as Error).message : 'The proxy restarted before the panel could answer; re-reading the settings.',
        status ? 'error' : 'info',
      );
    },
    onSettled: () => setConfirm(null),
  });

  if (settings.isError && !settings.data) {
    return <ErrorCard title="Couldn't load the traffic settings" error={settings.error} onRetry={() => settings.refetch()} />;
  }
  const view = settings.data;

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <BarChart3 size={15} className="text-slate-500" /> Traffic analytics
                {view && <Badge tone={STATUS_TONE[view.status]}>{view.status}</Badge>}
              </div>
              <p className="mt-1 max-w-2xl text-xs text-slate-500">
                Counts requests per domain from Traefik's access log: status classes, latency and bytes. No client IP, path,
                query string or header is ever written. Off by default.
              </p>
            </div>
            <Switch
              label="Traffic analytics"
              checked={enabled}
              disabled={!view || save.isPending}
              onChange={(on) => setConfirm(on)}
            />
          </div>
          {view && (
            <div className="grid gap-3 text-xs text-slate-400 sm:grid-cols-4">
              <div>
                Last ingest: <span className="text-slate-300">{view.lastIngestAt ? formatRelative(view.lastIngestAt) : '—'}</span>
              </div>
              <div>
                Log file: <span className="text-slate-300">{formatBytes(view.logBytes)}</span>
              </div>
              <div>
                Malformed lines: <span className="text-slate-300">{view.malformedLines}</span>
              </div>
              <div>
                Docker log driver: <span className="text-slate-300">{view.dockerLogDriver ?? 'unknown'}</span>
              </div>
            </div>
          )}
          {view?.lastError && <p className="text-xs text-rose-300">{view.lastError}</p>}
          {view && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (retention !== null) save.mutate({ retentionDays: Number(retention) });
              }}
            >
              <Field label="Keep hourly rows (days)" hint="Minute rows are kept for 48 hours.">
                <Input
                  type="number"
                  min={1}
                  max={400}
                  aria-label="Keep hourly rows (days)"
                  className="w-28"
                  value={retention ?? String(view.retentionDays)}
                  onChange={(e) => setRetention(e.target.value)}
                />
              </Field>
              <Button type="submit" size="sm" variant="secondary" disabled={retention === null || save.isPending}>
                Save
              </Button>
            </form>
          )}
        </CardBody>
      </Card>

      {enabled && (
        <Card>
          <CardBody className="space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-200">Instance traffic</h3>
              <TrafficRangePicker value={range} onChange={setRange} />
            </div>
            {summary.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : summary.isError || !summary.data ? (
              <ErrorCard title="Couldn't load the traffic summary" error={summary.error} onRetry={() => summary.refetch()} />
            ) : (
              <>
                <TrafficTotals totals={summary.data.totals} />
                <TrafficChart series={summary.data.series} />
                <div>
                  <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Top domains</h4>
                  <TrafficScopeTable rows={summary.data.topDomains} empty="No domain traffic in this range." />
                </div>
                <div>
                  <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Panel and custom routes</h4>
                  <TrafficScopeTable
                    rows={[summary.data.panel, summary.data.custom].filter((r) => r !== null)}
                    empty="No panel or custom-route traffic in this range."
                  />
                </div>
              </>
            )}
          </CardBody>
        </Card>
      )}

      {confirm !== null && (
        <Modal
          title={confirm ? 'Enable traffic analytics?' : 'Disable traffic analytics?'}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button disabled={save.isPending} onClick={() => save.mutate({ enabled: confirm })}>
                {confirm ? 'Enable and restart Traefik' : 'Disable and restart Traefik'}
              </Button>
            </>
          }
        >
          <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <p>
              This recreates the Traefik container once: expect about 1–2 seconds of refused connections on every domain,
              including this panel if it is served through Traefik.
              {confirm ? '' : ' Collected rollups are kept until retention removes them; the raw log is deleted.'}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
