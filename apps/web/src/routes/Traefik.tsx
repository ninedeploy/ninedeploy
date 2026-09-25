import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, ShieldCheck, ShieldX, RefreshCw, Globe, Server, Activity, FileText, Download, Clock, AlertCircle, Upload } from 'lucide-react';
import { useState } from 'react';
import { authedFetch } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, ErrorCard, PageHeader, Skeleton, StatusBadge, Tabs, cn } from '../components/ui.js';

interface TraefikStatus {
  running: boolean;
  version: string | null;
  versionLatest: string | null;
  outdated: boolean;
  uptime: string | null;
  ports: { http: number; https: number };
  configDir: string;
}

interface TraefikCertificate {
  domain: string;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  issuer: string | null;
}

interface TraefikRouter {
  name: string;
  rule: string;
  service: string;
  entryPoints: string[];
  tls: boolean;
  middleware: string[];
}

interface TraefikService {
  name: string;
  url: string;
  loadBalancer: string;
}

interface TraefikInfo {
  status: TraefikStatus;
  certificates: TraefikCertificate[];
  routers: TraefikRouter[];
  services: TraefikService[];
  middlewares: TraefikMiddleware[];
}

interface TraefikMiddleware {
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export function Traefik() {
  const { user: me } = useAuth();
  const isAdmin = me?.isOperator === true;

  const info = useQuery({
    queryKey: ['traefik'],
    queryFn: async () => {
      const res = await authedFetch('/v1/traefik');
      if (!res.ok) throw new Error('Failed to fetch traefik info');
      return res.json() as Promise<TraefikInfo>;
    },
    refetchInterval: 30_000,
  });

  const logs = useQuery({
    queryKey: ['traefik-logs'],
    queryFn: async () => {
      const res = await authedFetch('/v1/traefik/logs?lines=50');
      if (!res.ok) throw new Error('Failed to fetch traefik logs');
      return res.json() as Promise<{ logs: string[] }>;
    },
    refetchInterval: 15_000,
  });

  const [activeTab, setActiveTab] = useState('overview');

  return (
    <div className="nd-fade">
      <PageHeader
        icon={<Globe size={18} />}
        title="Traefik"
        subtitle="Reverse proxy, SSL certificates, and routing configuration."
      />

      {/* Status Banner */}
      {info.isLoading ? (
        <Skeleton className="mb-6 h-20 w-full" />
      ) : info.isError ? (
        <ErrorCard title="Couldn't load Traefik status" error={info.error} onRetry={() => info.refetch()} />
      ) : (
        <StatusBanner status={info.data!.status} isAdmin={isAdmin} />
      )}

      {/* Tabs */}
      <Tabs
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'certificates', label: `Certificates${info.data?.certificates?.length ? ` (${info.data.certificates.length})` : ''}` },
          { id: 'routers', label: `Routers${info.data?.routers?.length ? ` (${info.data.routers.length})` : ''}` },
          { id: 'logs', label: 'Logs' },
        ]}
      />

      <div className="mt-6">
        {activeTab === 'overview' && <OverviewTab data={info.data} isLoading={info.isLoading} />}
        {activeTab === 'certificates' && info.data && <CertificatesTab certificates={info.data.certificates} />}
        {activeTab === 'routers' && info.data && <RoutersTab data={info.data} />}
        {activeTab === 'logs' && <LogsTab logs={logs.data?.logs ?? []} isLoading={logs.isLoading} />}
      </div>
    </div>
  );
}

function StatusBanner({ status, isAdmin }: { status: TraefikStatus; isAdmin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const restart = useMutation({
    mutationFn: async () => {
      const res = await authedFetch('/v1/traefik/restart', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to restart Traefik');
      return res.json();
    },
    onSuccess: () => {
      toast('Traefik restarted successfully', 'success');
      qc.invalidateQueries({ queryKey: ['traefik'] });
    },
    onError: () => toast('Failed to restart Traefik', 'error'),
  });

  const backup = useMutation({
    mutationFn: async () => {
      const res = await authedFetch('/v1/traefik/backup-certs', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to backup certificates');
      return res.json();
    },
    onSuccess: () => {
      toast('Certificates backed up successfully', 'success');
    },
    onError: () => toast('Failed to backup certificates', 'error'),
  });

  const update = useMutation({
    mutationFn: async () => {
      const res = await authedFetch('/v1/traefik/update', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to update Traefik');
      return res.json() as Promise<{ ok: boolean; newVersion: string | null }>;
    },
    onSuccess: (data) => {
      // r346: the server reports newVersion: null when the registry lookup
      // fails (the pull still happened) — that used to read "updated to vnull".
      toast(data.newVersion ? `Traefik updated to v${data.newVersion}` : 'Traefik updated to the latest image', 'success');
      qc.invalidateQueries({ queryKey: ['traefik'] });
    },
    onError: (err) => toast(`Failed to update Traefik: ${err.message}`, 'error'),
  });

  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-4">
          {status.running ? (
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/20">
              <ShieldCheck size={24} className="text-emerald-400" />
            </div>
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-rose-500/10 ring-1 ring-inset ring-rose-500/20">
              <ShieldX size={24} className="text-rose-400" />
            </div>
          )}

          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">
                {status.running ? 'Traefik Running' : 'Traefik Stopped'}
              </h2>
              <StatusBadge status={status.running ? 'running' : 'stopped'} />
            </div>
            <div className="mt-1 flex items-center gap-3 text-sm text-slate-400">
              {status.version && (
                <span className={cn('flex items-center gap-1', status.outdated && 'text-amber-400')}>
                  <FileText size={12} />
                  v{status.version}
                  {status.outdated && status.versionLatest && (
                    <span className="text-xs">→ v{status.versionLatest}</span>
                  )}
                </span>
              )}
              {status.uptime && (
                <span className="flex items-center gap-1">
                  <Clock size={12} />
                  Uptime: {status.uptime}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Globe size={12} />
                :{status.ports.http} / :{status.ports.https}
              </span>
            </div>
          </div>
        </div>

        {isAdmin && status.running && (
          <div className="flex items-center gap-2">
            {status.outdated && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => update.mutate()}
                disabled={update.isPending}
                className="h-8 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
              >
                <Upload size={14} className={cn('mr-1.5', update.isPending && 'animate-bounce')} />
                {update.isPending ? 'Updating…' : `Update to v${status.versionLatest}`}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => backup.mutate()}
              disabled={backup.isPending}
              className="h-8"
            >
              <Download size={14} className="mr-1.5" />
              {backup.isPending ? 'Backing up…' : 'Backup Certs'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => restart.mutate()}
              disabled={restart.isPending}
              className="h-8"
            >
              <RefreshCw size={14} className={cn('mr-1.5', restart.isPending && 'animate-spin')} />
              {restart.isPending ? 'Restarting…' : 'Restart'}
            </Button>
          </div>
        )}
      </div>

      {/* Outdated warning */}
      {status.outdated && (
        <div className="border-t border-amber-500/20 bg-amber-500/5 px-5 py-3">
          <div className="flex items-center gap-2 text-sm text-amber-400">
            <AlertCircle size={14} />
            A newer Traefik version is available (v{status.versionLatest}). Click &quot;Update&quot; to upgrade.
          </div>
        </div>
      )}

      {!status.running && (
        <div className="border-t border-white/5 bg-rose-500/5 px-5 py-3">
          <div className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={14} />
            Traefik is not running. Domain routing will be unavailable.
          </div>
        </div>
      )}
    </Card>
  );
}

function OverviewTab({ data, isLoading }: { data: TraefikInfo | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-3 h-8 w-16" />
          </Card>
        ))}
      </div>
    );
  }

  if (!data) return null;

  const certStats = {
    valid: data.certificates.filter((c) => c.daysUntilExpiry === null || c.daysUntilExpiry > 30).length,
    expiring: data.certificates.filter((c) => c.daysUntilExpiry !== null && c.daysUntilExpiry <= 30 && c.daysUntilExpiry > 7).length,
    critical: data.certificates.filter((c) => c.daysUntilExpiry !== null && c.daysUntilExpiry <= 7).length,
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="p-5">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
          <Shield size={14} className="text-indigo-400" /> Certificates
        </div>
        <div className="mt-2 text-2xl font-semibold">{data.certificates.length}</div>
        <div className="mt-1 flex items-center gap-2 text-xs">
          <span className="text-emerald-400">{certStats.valid} valid</span>
          {certStats.expiring > 0 && <span className="text-amber-400">{certStats.expiring} expiring</span>}
          {certStats.critical > 0 && <span className="text-rose-400">{certStats.critical} critical</span>}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
          <Globe size={14} className="text-indigo-400" /> Routers
        </div>
        <div className="mt-2 text-2xl font-semibold">{data.routers.length}</div>
        <div className="mt-1 text-xs text-slate-500">
          {data.routers.filter((r) => r.tls).length} with TLS
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
          <Server size={14} className="text-indigo-400" /> Services
        </div>
        <div className="mt-2 text-2xl font-semibold">{data.services.length}</div>
        <div className="mt-1 text-xs text-slate-500">load balanced</div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
          <Activity size={14} className="text-indigo-400" /> Middlewares
        </div>
        <div className="mt-2 text-2xl font-semibold">{data.middlewares.length}</div>
        <div className="mt-1 text-xs text-slate-500">redirects / headers</div>
      </Card>
    </div>
  );
}

function CertificatesTab({ certificates }: { certificates: TraefikCertificate[] }) {
  if (certificates.length === 0) {
    return (
      <Card className="p-10 text-center">
        <Shield size={32} className="mx-auto mb-3 text-slate-600" />
        <p className="text-sm text-slate-500">No SSL certificates configured.</p>
        <p className="mt-1 text-xs text-slate-600">
          Enable SSL on domains to automatically provision Let's Encrypt certificates.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-5 py-3">Domain</th>
            <th className="px-5 py-3">Issuer</th>
            <th className="px-5 py-3">Expires</th>
            <th className="px-5 py-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {certificates.map((cert) => (
            <tr key={cert.domain} className="border-t border-white/5">
              <td className="px-5 py-3 font-mono text-sm">{cert.domain}</td>
              <td className="px-5 py-3 text-slate-400">{cert.issuer}</td>
              <td className="px-5 py-3 tabular-nums">
                {cert.expiresAt
                  ? new Date(cert.expiresAt).toLocaleDateString()
                  : '—'}
              </td>
              <td className="px-5 py-3">
                <CertificateBadge daysUntilExpiry={cert.daysUntilExpiry} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CertificateBadge({ daysUntilExpiry }: { daysUntilExpiry: number | null }) {
  if (daysUntilExpiry === null) {
    return <StatusBadge status="running" />;
  }

  if (daysUntilExpiry <= 7) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-medium text-rose-300 ring-1 ring-inset ring-rose-500/20">
      <span className="h-1.5 w-1.5 rounded-full bg-current" /> {daysUntilExpiry}d
    </span>;
  }

  if (daysUntilExpiry <= 30) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20">
      <span className="h-1.5 w-1.5 rounded-full bg-current" /> {daysUntilExpiry}d
    </span>;
  }

  return <StatusBadge status="running" />;
}

function RoutersTab({ data }: { data: TraefikInfo }) {
  return (
    <div className="space-y-4">
      {data.routers.length === 0 ? (
        <Card className="p-10 text-center">
          <Globe size={32} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm text-slate-500">No routers configured.</p>
          <p className="mt-1 text-xs text-slate-600">
            Add domains to services to create routing rules.
          </p>
        </Card>
      ) : (
        data.routers.map((router) => (
          <Card key={router.name} className="p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{router.name}</span>
                  {router.tls && (
                    <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                      <ShieldCheck size={10} /> TLS
                    </span>
                  )}
                </div>
                <div className="mt-2 font-mono text-xs text-slate-500">{router.rule}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {router.entryPoints.map((ep) => (
                    <span
                      key={ep}
                      className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400"
                    >
                      {ep}
                    </span>
                  ))}
                  <span className="text-xs text-slate-600">
                    → {router.service}
                  </span>
                </div>
              </div>
            </div>
          </Card>
        ))
      )}

      {data.services.length > 0 && (
        <>
          <h3 className="mt-6 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            <Server size={14} /> Backend Services
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.services.map((svc) => (
              <Card key={svc.name} className="p-3">
                <div className="font-mono text-xs font-medium">{svc.name}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-slate-500">{svc.url}</div>
                <div className="mt-1 text-[10px] text-slate-600">{svc.loadBalancer}</div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LogsTab({ logs, isLoading }: { logs: string[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <Card className="p-5">
        <Skeleton className="h-64 w-full" />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-white/5 px-4 py-2">
        <span className="text-xs font-medium text-slate-400">Recent Logs</span>
      </div>
      <div className="max-h-96 overflow-auto">
        {logs.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">No logs available.</div>
        ) : (
          <pre className="p-4 font-mono text-[11px] leading-relaxed text-slate-400">
            {logs.map((line, i) => (
              <div
                key={`log-${i}-${line.slice(0, 10)}`}
                className={cn(
                  'hover:bg-white/[0.02]',
                  line.includes('error') && 'text-rose-400',
                  line.includes('warn') && 'text-amber-400',
                  line.includes('level=info') && 'text-slate-500',
                )}
              >
                {line}
              </div>
            ))}
          </pre>
        )}
      </div>
    </Card>
  );
}
