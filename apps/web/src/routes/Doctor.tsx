import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, RefreshCw, Stethoscope, Wrench } from 'lucide-react';
import type { DoctorFinding, DoctorReport } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, EmptyState, ErrorCard, PageHeader, Skeleton } from '../components/ui.js';
import { useToast } from '../components/Toast.js';
import { useAuth } from '../lib/auth.js';

function fmtBytes(n: number | null | undefined): string {
  if (n == null || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

const SEVERITY_TONE: Record<DoctorFinding['severity'], 'rose' | 'amber' | 'sky'> = {
  critical: 'rose',
  warn: 'amber',
  info: 'sky',
};

/** Destructive repairs confirm; self-healing or advisory-safe ones run directly. */
function needsConfirm(finding: DoctorFinding): boolean {
  return finding.action === 'delete_volume' || finding.action === 'remove_container' || finding.action === 'remove_network';
}

export function Doctor() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const [confirming, setConfirming] = useState<DoctorFinding | null>(null);

  const scan = useQuery({
    queryKey: ['doctor-report'],
    queryFn: () => api.doctor.scan() as Promise<DoctorReport>,
    // r472: the scan is admin-only; the render guard below only changes what
    // is DISPLAYED — a member hitting the URL directly must not fire it.
    enabled: user?.isOperator === true,
  });

  const fix = useMutation({
    mutationFn: (findingId: string) => api.doctor.fix({ findingId }),
    onSuccess: (res) => {
      toast(`Fixed: ${res.action}`, 'info');
      // The fix response already carries the post-fix report — seed the cache
      // with it instead of invalidating, which would trigger a THIRD full
      // scan (fix already scans before and after executing) per click.
      qc.setQueryData(['doctor-report'], res.report);
    },
    onError: (err: Error) => toast(err.message ?? 'Fix failed', 'error'),
  });

  if (!user?.isOperator) {
    return <PageHeader title="Doctor" subtitle="Host-wide analysis and cleanup — operators only." />;
  }

  const report = scan.data;
  const findings = report?.findings ?? [];
  const grouped = {
    critical: findings.filter((f) => f.severity === 'critical'),
    warn: findings.filter((f) => f.severity === 'warn'),
    info: findings.filter((f) => f.severity === 'info'),
  };

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Stethoscope className="h-6 w-6" />}
        title="Doctor"
        subtitle="Dead containers, orphaned volumes & networks, desynced rows, reclaimable bloat — analyzed fresh on every scan. Fixes re-validate against live state before touching anything."
        actions={
          <Button variant="secondary" onClick={() => scan.refetch()} disabled={scan.isFetching}>
            {scan.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Scan
          </Button>
        }
      />

      {scan.isLoading && <Skeleton className="h-40" />}

      {/* r562: a failed scan rendered as a blank page under the header. */}
      {scan.isError && !report && (
        <ErrorCard title="The Doctor scan failed" error={scan.error} onRetry={() => void scan.refetch()} />
      )}

      {report && (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              {report.healthy ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" /> All clear — no warnings
                </>
              ) : (
                <>
                  <Stethoscope className="h-5 w-5 text-amber-500" /> {report.totals.findings} finding(s)
                </>
              )}
            </span>
            <span className="text-sm text-slate-400">
              Disk {report.host.diskUsedPercent}% · Images {fmtBytes(report.host.dockerImagesBytes)} · Volumes{' '}
              {fmtBytes(report.host.dockerVolumesBytes)} · Build cache {fmtBytes(report.host.dockerBuildCacheBytes)}
            </span>
            <span className="text-sm text-slate-400">
              Reclaimable: <strong>{fmtBytes(report.totals.reclaimableBytes)}</strong>
            </span>
          </CardBody>
        </Card>
      )}

      {report && findings.length === 0 && (
        <EmptyState
          icon={<CheckCircle2 className="h-8 w-8 text-emerald-500" />}
          title="Nothing to fix"
          hint="No dead containers, orphan volumes, desynced rows or bloat were found on this host."
        />
      )}

      {(['critical', 'warn', 'info'] as const).map((sev) =>
        grouped[sev].length ? (
          <div key={sev} className="space-y-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              {sev} ({grouped[sev].length})
            </h3>
            {grouped[sev].map((f) => (
              <Card key={f.id}>
                <CardBody className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
                      <span className="font-medium">{f.title}</span>
                      {f.sizeBytes != null && f.sizeBytes > 0 && <Badge tone="neutral">{fmtBytes(f.sizeBytes)}</Badge>}
                    </div>
                    <p className="text-sm text-slate-400">{f.detail}</p>
                    <p className="font-mono text-xs text-slate-500">{f.id}</p>
                  </div>
                  {f.action && (
                    <Button
                      variant="secondary"
                      onClick={() => (needsConfirm(f) ? setConfirming(f) : fix.mutate(f.id))}
                      disabled={fix.isPending}
                    >
                      {fix.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
                      Fix
                    </Button>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
        ) : null,
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? `Fix: ${confirming.action}` : ''}
        message={
          confirming?.action
            ? `This will ${confirming.action.replaceAll('_', ' ')} ${confirming.target.name ?? confirming.target.id ?? ''}. For volumes this DESTROYS the data permanently. The action re-validates live state before executing.`
            : ''
        }
        confirmLabel="Fix it"
        onConfirm={() => {
          if (confirming) fix.mutate(confirming.id);
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
