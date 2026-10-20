import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Split } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { CanaryReleaseStats } from '@ninedeploy/schemas';
import { api } from '../../lib/api.js';
import { canaryApi, canaryKeys } from '../../lib/canaryApi.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Spinner } from '../../components/ui.js';

/** "1m 05s" / "42s" until `endsAt`; null without an end. */
export function canaryTimeLeft(endsAt: string | undefined, now: number): string | null {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return null;
  const s = Math.max(0, Math.ceil((end - now) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function ReleaseStats({ label, stats }: { label: string; stats: CanaryReleaseStats | undefined }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <div className="text-[11px] font-medium text-slate-400">{label}</div>
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <div>
          <dt className="inline text-slate-500">Requests </dt>
          <dd className="inline font-mono text-slate-200">{stats?.requests ?? 0}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">5xx </dt>
          <dd className="inline font-mono text-slate-200">{stats?.errorRate != null ? `${stats.errorRate}%` : '—'}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">p95 </dt>
          <dd className="inline font-mono text-slate-200">{stats?.p95Ms != null ? `${stats.p95Ms} ms` : '—'}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * 0.16.9: the canary of the deploy in progress, polled every 5 s while
 * `enabled`. Renders nothing when no canary runs or the status cannot be
 * read. Promote switches all traffic now; Abort cancels the deployment, which
 * routes everything back to the previous release. Any seat on the service may
 * use both (the server checks the member floor).
 */
export function CanaryPanel({ serviceId, enabled }: { serviceId: number; enabled: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirmAbort, setConfirmAbort] = useState(false);
  const q = useQuery({
    queryKey: canaryKeys.status(serviceId),
    queryFn: () => canaryApi.status(serviceId),
    enabled,
    refetchInterval: enabled ? 5000 : false,
    retry: false,
  });
  const view = enabled && !q.isError && q.data?.active ? q.data : null;

  // A one-second clock for the time left in the step, only while one shows.
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!view?.stepEndsAt;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: canaryKeys.status(serviceId) });
    qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
  };
  const promote = useMutation({
    mutationFn: (deploymentId: number) => canaryApi.promote(serviceId, deploymentId),
    onSuccess: () => {
      refresh();
      toast('Promoting: all traffic switches to the new release', 'success');
    },
    onError: (err) => toast(err instanceof Error && err.message ? err.message : 'Could not promote the canary', 'error'),
  });
  const abort = useMutation({
    mutationFn: (deploymentId: number) => api.deploys.cancel(serviceId, deploymentId),
    onSuccess: () => {
      refresh();
      toast('Canary aborted: all traffic goes back to the previous release', 'success');
    },
    onError: (err) => toast(err instanceof Error && err.message ? err.message : 'Could not abort the canary', 'error'),
  });

  if (!view || view.deploymentId == null) return null;
  const depId = view.deploymentId;
  const weight = Math.max(0, Math.min(100, view.weight ?? 0));
  const left = canaryTimeLeft(view.stepEndsAt, now);
  const busy = promote.isPending || abort.isPending || view.promoting === true;

  return (
    <Card className="mt-5">
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.03] text-indigo-200">
              <Split size={15} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-200">Canary release · deployment #{depId}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {view.promoting
                  ? 'Switching all traffic to the new release…'
                  : `Step ${view.step ?? 1} of ${view.steps ?? 1}${left ? ` · ${left} left in this step` : ''}`}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => promote.mutate(depId)} disabled={busy} title="Skip the remaining steps and switch all traffic now">
              {promote.isPending || view.promoting ? <Spinner className="h-3 w-3" /> : null} Promote
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmAbort(true)} disabled={busy}>
              Abort
            </Button>
          </div>
        </div>

        <div>
          <div className="flex flex-wrap justify-between gap-x-3 text-[11px]">
            <span className="text-indigo-200">New release {weight}%</span>
            <span className="text-slate-500">Previous release {100 - weight}%</span>
          </div>
          <div
            className="mt-1 h-2 overflow-hidden rounded-full bg-white/[0.06]"
            role="progressbar"
            aria-label="Share of requests on the new release"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={weight}
          >
            <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${weight}%` }} />
          </div>
        </div>

        {view.measured ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ReleaseStats label="New release" stats={view.canary} />
            <ReleaseStats label="Previous release" stats={view.stable} />
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            Traffic analytics is off, so each step is judged on the healthcheck only. An operator can turn it on in{' '}
            <Link to="/traefik" className="text-indigo-200 underline-offset-2 hover:underline">Traefik → Traffic</Link>.
          </p>
        )}

        <ConfirmDialog
          open={confirmAbort}
          title="Abort this canary?"
          message={`Deployment #${depId} is cancelled and all traffic goes back to the previous release. The new container is stopped.`}
          confirmLabel="Abort canary"
          onConfirm={() => abort.mutate(depId)}
          onClose={() => setConfirmAbort(false)}
        />
      </CardBody>
    </Card>
  );
}
