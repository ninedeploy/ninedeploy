import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Cpu, Database, Globe, HardDrive, Link2, MemoryStick, Package, Rocket, Server, Sparkles, Upload, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, CardBody, ErrorCard, Skeleton, cn } from '../components/ui.js';
import { formatBytes, formatDateTime } from '../lib/format.js';
import { ServiceDomainLauncher } from '../components/ServiceDomainLauncher.js';
import { PluginSlot } from '../components/PluginSlot.js';

export function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api.dashboard.get(), refetchInterval: 5000 });
  const snapshot = useQuery({
    queryKey: ['live-stats-snapshot'],
    queryFn: () => api.stats.snapshot(),
    refetchInterval: 3000,
  });
  const importRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const seedDemo = useMutation({
    mutationFn: () => api.demo.seed(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['deploys'] });
      const demo = res.services[0];
      toast(`Next.js Demo created — first build queued for ${demo?.name ?? 'the demo service'}`, 'success');
    },
    onError: () => toast('Could not create the demo', 'error'),
  });

  const doImport = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const res = await api.services.importBundle(bundle);
      navigate(`/services/${res.serviceId}`);
    } catch (err) {
      setImporting(false);
      // Surface the API's actual reason (incompatible bundle version, bad
      // shape, …) — a bare "Import failed" turned every rejection into a
      // support ticket.
      const message = err instanceof Error ? err.message : 'Import failed';
      toast(`Import failed: ${message}`, 'error');
    }
  };

  if (dash.isLoading) {
    return (
      <div className="space-y-4">
        <FetchBar show />
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const data = dash.data;
  if (!data) {
    // Query failed (not loading) — show an actionable error instead of a blank page.
    return <ErrorCard title="Couldn't load the dashboard" error={dash.error} onRetry={() => dash.refetch()} />;
  }
  const s = data.stats;
  // Unknown health (a remote node's runtime — the panel cannot probe it) is
  // NOT an alarm: only an explicit false counts against the banner.
  const allHealthy = data.health.every((h) => h.status !== 'running' || h.healthy !== false);
  const unhealthyCount = data.health.filter((h) => h.status === 'running' && h.healthy === false).length;

  const host = snapshot.data?.host;
  const memPct = host && host.memTotalBytes > 0 ? Math.round((host.memUsedBytes / host.memTotalBytes) * 100) : 0;
  const diskPct = host && host.diskTotalBytes > 0 ? Math.round((host.diskUsedBytes / host.diskTotalBytes) * 100) : 0;

  return (
    <div className="nd-fade space-y-5">
      {/* Hero status banner */}
      <input ref={importRef} type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ''; }} />
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => seedDemo.mutate()}
          disabled={seedDemo.isPending}
        >
          <Sparkles size={13} className="text-indigo-400" />
          {seedDemo.isPending ? 'Creating Demo…' : 'Load Next.js Demo'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => importRef.current?.click()} disabled={importing}>
          <Upload size={13} /> {importing ? 'Importing…' : 'Import service'}
        </Button>
      </div>
      <FetchBar show={dash.isFetching} />
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl border p-5',
          allHealthy ? 'border-emerald-500/20 bg-emerald-500/[0.04]' : 'border-rose-500/20 bg-rose-500/[0.04]',
        )}
      >
        <div className="flex items-center gap-4">
          <div className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-xl', allHealthy ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300')}>
            {allHealthy ? <CheckCircle2 size={24} /> : <AlertCircle size={24} />}
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Dashboard</p>
            <h1 className="text-lg font-semibold">
              {allHealthy ? 'All systems operational' : `${unhealthyCount} service${unhealthyCount > 1 ? 's' : ''} need attention`}
            </h1>
            <p className="text-sm text-slate-400">
              {s.running} running · {s.stopped} stopped · {s.errored} errored · {s.containers} containers · {s.dbRunning} databases
            </p>
          </div>
          <div className="ml-auto hidden items-center gap-1.5 rounded-full bg-white/[0.04] px-3 py-1 text-xs text-slate-400 sm:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Live · refreshes every 3s
          </div>
        </div>
      </div>

      {/* Host Infrastructure Telemetry (CPU / RAM / Disk) */}
      {host && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card className="p-4 bg-white/[0.02]">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="flex items-center gap-1.5 text-slate-400 font-medium">
                <Cpu size={14} className="text-indigo-400" /> Host CPU Load
              </span>
              <span className="font-mono text-xs font-semibold text-slate-200">
                {host.load1 != null ? host.load1.toFixed(2) : '0.00'} loadavg
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-1.5">
              <span>{host.cpuCores} Cores</span>
              <span className="text-indigo-300 font-medium">{Math.min(100, Math.round((host.load1 / Math.max(1, host.cpuCores)) * 100))}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(3, (host.load1 / Math.max(1, host.cpuCores)) * 100))}%` }}
              />
            </div>
          </Card>

          <Card className="p-4 bg-white/[0.02]">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="flex items-center gap-1.5 text-slate-400 font-medium">
                <MemoryStick size={14} className="text-emerald-400" /> Memory (RAM)
              </span>
              <span className="font-mono text-xs font-semibold text-slate-200">
                {memPct}%
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-1.5">
              <span>{formatBytes(host.memUsedBytes)}</span>
              <span>{formatBytes(host.memTotalBytes)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className={cn('h-full rounded-full transition-all duration-500', memPct > 85 ? 'bg-rose-500' : memPct > 65 ? 'bg-amber-500' : 'bg-emerald-500')}
                style={{ width: `${Math.min(100, Math.max(3, memPct))}%` }}
              />
            </div>
          </Card>

          <Card className="p-4 bg-white/[0.02]">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="flex items-center gap-1.5 text-slate-400 font-medium">
                <HardDrive size={14} className="text-amber-400" /> Disk Storage
              </span>
              <span className="font-mono text-xs font-semibold text-slate-200">
                {diskPct}%
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-1.5">
              <span>{formatBytes(host.diskUsedBytes)}</span>
              <span>{formatBytes(host.diskTotalBytes)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className={cn('h-full rounded-full transition-all duration-500', diskPct > 85 ? 'bg-rose-500' : diskPct > 70 ? 'bg-amber-500' : 'bg-amber-500/80')}
                style={{ width: `${Math.min(100, Math.max(3, diskPct))}%` }}
              />
            </div>
          </Card>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard icon={<Server size={15} />} label="Services" value={s.services} sub={`${s.running} running`} tone="indigo" />
        <StatCard icon={<Database size={15} />} label="Databases" value={s.databases} sub={`${s.dbRunning} running`} tone="emerald" />
        <StatCard icon={<Rocket size={15} />} label="Deploys" value={s.deployments} sub="total" tone="sky" />
        <StatCard icon={<Globe size={15} />} label="Domains" value={s.domains} sub="routed" tone="amber" />
        <StatCard icon={<Link2 size={15} />} label="Webhooks" value={s.webhooks} sub="active" tone="violet" />
        <StatCard icon={<Package size={15} />} label="Containers" value={s.containers} sub="docker" tone="slate" />
      </div>

      {/* Quick Actions Hub */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Link to="/hub" className="group">
          <Card interactive className="p-4 transition-all duration-200 group-hover:border-indigo-500/30 group-hover:bg-indigo-500/[0.03]">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-500/10 text-indigo-400 ring-1 ring-inset ring-indigo-500/20 group-hover:bg-indigo-500/20 group-hover:scale-105 transition-transform">
                <Rocket size={18} />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white group-hover:text-indigo-300 transition-colors">Deploy New Service</h3>
                <p className="truncate text-xs text-slate-400">Git repo, Dockerfile or image</p>
              </div>
            </div>
          </Card>
        </Link>

        <Link to="/databases" className="group">
          <Card interactive className="p-4 transition-all duration-200 group-hover:border-emerald-500/30 group-hover:bg-emerald-500/[0.03]">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20 group-hover:bg-emerald-500/20 group-hover:scale-105 transition-transform">
                <Database size={18} />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white group-hover:text-emerald-300 transition-colors">Managed Databases</h3>
                <p className="truncate text-xs text-slate-400">PostgreSQL, Redis, MySQL</p>
              </div>
            </div>
          </Card>
        </Link>

        <Link to="/servers" className="group">
          <Card interactive className="p-4 transition-all duration-200 group-hover:border-sky-500/30 group-hover:bg-sky-500/[0.03]">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-500/10 text-sky-400 ring-1 ring-inset ring-sky-500/20 group-hover:bg-sky-500/20 group-hover:scale-105 transition-transform">
                <Server size={18} />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white group-hover:text-sky-300 transition-colors">Cluster Nodes</h3>
                <p className="truncate text-xs text-slate-400">Multi-server &amp; edge agents</p>
              </div>
            </div>
          </Card>
        </Link>

        <Link to="/monitoring" className="group">
          <Card interactive className="p-4 transition-all duration-200 group-hover:border-amber-500/30 group-hover:bg-amber-500/[0.03]">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20 group-hover:bg-amber-500/20 group-hover:scale-105 transition-transform">
                <Sparkles size={18} />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white group-hover:text-amber-300 transition-colors">Live Telemetry</h3>
                <p className="truncate text-xs text-slate-400">CPU, memory &amp; container metrics</p>
              </div>
            </div>
          </Card>
        </Link>
      </div>

      {/* Dynamic Plugin Extensions & Widgets */}
      <PluginSlot slot="dashboard:overview" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" />

      {/* Service health grid */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Service Health</h2>
        {data.health.length === 0 ? (
          <Card><CardBody><p className="py-6 text-center text-sm text-slate-500">No services yet. Deploy from the <Link to="/hub" className="text-indigo-400 hover:underline">Hub</Link>.</p></CardBody></Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.health.map((h) => {
              const isRunning = h.status === 'running';
              // null = the runtime lives on a remote node the panel cannot
              // probe — show the running state without a health verdict.
              const isHealthy = h.healthy;
              const isRemote = isRunning && isHealthy == null;
              const liveStat = snapshot.data?.containers.find((c) => c.refId === h.serviceId && c.kind === 'service');

              return (
                <div key={h.serviceId} className="relative h-full">
                  <Link to={`/services/${h.serviceId}`} className="block h-full">
                  <Card interactive className="group flex h-full flex-col justify-between p-4 pb-12">
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className={cn(
                            'grid h-9 w-9 place-items-center rounded-lg ring-1 ring-inset transition',
                            isRunning && isHealthy === true ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20' :
                            isRunning && isHealthy === false ? 'bg-rose-500/10 text-rose-300 ring-rose-500/20' :
                            isRemote ? 'bg-indigo-500/10 text-indigo-300 ring-indigo-500/20' :
                            h.status === 'stopped' ? 'bg-slate-500/10 text-slate-400 ring-slate-500/20' :
                            'bg-amber-500/10 text-amber-300 ring-amber-500/20',
                          )}>
                            {isRunning && isHealthy === true ? <CheckCircle2 size={17} /> :
                             isRunning && isHealthy === false ? <XCircle size={17} /> :
                             isRemote ? <Server size={17} /> :
                             h.status === 'stopped' ? <Server size={17} /> :
                             <AlertCircle size={17} />}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-slate-200 group-hover:text-white">{h.name}</div>
                            <div className="font-mono text-[10px] text-slate-500">{h.type} · {h.commitSha ?? '—'}</div>
                          </div>
                        </div>
                        <div className="text-right">
                          {h.responseMs != null && (
                            <div className={cn(
                              'font-mono text-xs font-medium',
                              h.responseMs < 100 ? 'text-emerald-300' : h.responseMs < 500 ? 'text-amber-300' : 'text-rose-300',
                            )}>
                              {h.responseMs}ms
                            </div>
                          )}
                          <div className={cn(
                            'text-[10px] font-medium uppercase',
                            isRunning && isHealthy === true ? 'text-emerald-400' :
                            isRunning && isHealthy === false ? 'text-rose-400' :
                            isRemote ? 'text-indigo-400' :
                            h.status === 'stopped' ? 'text-slate-500' : 'text-amber-400',
                          )}>
                            {isRunning && isHealthy === true ? 'healthy' : isRunning && isHealthy === false ? 'unhealthy' : isRemote ? 'on node' : h.status}
                          </div>
                        </div>
                      </div>

                      {/* Live Telemetry Badges if running. '—' until the first
                          snapshot — a fake 0.0% read as "idle" during a storm
                          on first paint (r409). */}
                      {isRunning && (
                        <div className="mt-2.5 flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300 ring-1 ring-inset ring-indigo-500/20">
                            <Cpu size={10} className="text-indigo-400" /> {liveStat ? `${liveStat.cpuPct.toFixed(1)}%` : '—'}
                          </span>
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                            <MemoryStick size={10} className="text-emerald-400" /> {liveStat ? `${liveStat.memMb.toFixed(1)} MiB` : '—'}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Health bar */}
                    <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/5">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          isRunning && isHealthy ? 'w-full bg-emerald-500' :
                          isRunning && !isHealthy ? 'w-1/4 bg-rose-500 animate-pulse' :
                          h.status === 'stopped' ? 'w-0' : 'w-1/2 bg-amber-500',
                        )}
                      />
                    </div>
                  </Card>
                  </Link>
                  <ServiceDomainLauncher serviceId={h.serviceId} serviceName={h.name} className="absolute bottom-2.5 right-3 z-10 h-7" />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent deployments */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Recent Activity</h2>
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {data.recentDeploys.length === 0 ? (
                <tr><td className="px-5 py-6 text-center text-slate-500">No deployments yet.</td></tr>
              ) : (
                data.recentDeploys.map((d) => (
                  <tr key={d.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-3">
                      <span className="inline-flex items-center gap-2">
                        <Link to={`/services/${d.serviceId}`} className="font-medium text-slate-200 hover:text-indigo-300">{d.serviceName}</Link>
                        <ServiceDomainLauncher serviceId={d.serviceId} serviceName={d.serviceName} className="h-6 px-2" />
                      </span>
                      <span className="ml-2 font-mono text-[10px] text-slate-500">#{d.id} · {d.commitSha ?? '—'}</span>
                    </td>
                    <td className="px-5 py-3 text-xs">
                      <span className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                        d.status === 'running' ? 'bg-emerald-500/15 text-emerald-300' :
                        d.status === 'failed' ? 'bg-rose-500/15 text-rose-300' :
                        d.status === 'building' || d.status === 'queued' ? 'bg-amber-500/15 text-amber-300' :
                        'bg-slate-500/15 text-slate-400',
                      )}>{d.status}</span>
                    </td>
                    <td className="px-5 py-3 text-right text-[10px] text-slate-600">
                      {d.finishedAt ? formatDateTime(d.finishedAt) : formatDateTime(d.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: number; sub: string; tone: string }) {
  const tones: Record<string, string> = {
    indigo: 'text-indigo-300 bg-indigo-500/10',
    emerald: 'text-emerald-300 bg-emerald-500/10',
    sky: 'text-sky-300 bg-sky-500/10',
    amber: 'text-amber-300 bg-amber-500/10',
    violet: 'text-violet-300 bg-violet-500/10',
    slate: 'text-slate-300 bg-slate-500/10',
  };
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2">
        <span className={cn('grid h-7 w-7 place-items-center rounded-lg', tones[tone]!)}>{icon}</span>
        <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <div className="mt-1.5 text-xl font-bold tabular-nums text-slate-100">{value}</div>
      <div className="text-[10px] text-slate-500">{sub}</div>
    </Card>
  );
}

/**
 * Thin brand-colored bar pinned to the viewport top while dashboard data is
 * in flight — the skeleton covers only the first load; this covers background
 * re-fetches (health probes can take a second).
 */
function FetchBar({ show }: { show: boolean }) {
  if (!show) return null;
  return <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-0.5 animate-pulse bg-[var(--nd-accent)]" />;
}
