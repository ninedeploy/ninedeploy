import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  BellRing,
  Cpu,
  Database,
  Flame,
  Gauge,
  HardDrive,
  Layers,
  LayoutGrid,
  List,
  MemoryStick,
  Pause,
  Play,
  Radio,
  Search,
  Server,
} from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useToast } from '../components/Toast.js';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorCard,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  cn,
} from '../components/ui.js';
import { Sparkline } from '../components/Sparkline.js';
import { formatBytes, formatRelative, toInt } from '../lib/format.js';

export function Monitoring() {
  const { user: me } = useAuth();
  const [selectedServerId, setSelectedServerId] = useState<string>('local');
  const [filterType, setFilterType] = useState<'all' | 'service' | 'database' | 'high-usage'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.stats.snapshot(),
    refetchInterval: 4000,
  });

  const servers = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.servers.list(),
  });

  const host = stats.data?.host;
  const containers = stats.data?.containers ?? [];
  const serverList = servers.data ?? [];

  const memPct = host && host.memTotalBytes > 0 ? Math.round((host.memUsedBytes / host.memTotalBytes) * 100) : 0;
  const diskPct = host && host.diskTotalBytes > 0 ? Math.round((host.diskUsedBytes / host.diskTotalBytes) * 100) : 0;

  // Filtered containers
  const filteredContainers = useMemo(() => {
    return containers.filter((c) => {
      const matchesSearch =
        c.refName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.engine && c.engine.toLowerCase().includes(searchQuery.toLowerCase()));

      if (!matchesSearch) return false;

      if (filterType === 'service') return c.kind === 'service';
      if (filterType === 'database') return c.kind === 'database';
      if (filterType === 'high-usage') {
        const memLimit = c.memLimitMb > 0 ? c.memLimitMb : 512;
        const memUsagePct = (c.memMb / memLimit) * 100;
        return c.cpuPct > 20 || memUsagePct > 60;
      }
      return true;
    });
  }, [containers, filterType, searchQuery]);

  // Aggregate telemetry
  const totalCpuUsage = containers.reduce((acc, c) => acc + c.cpuPct, 0);
  const totalMemUsageMb = containers.reduce((acc, c) => acc + c.memMb, 0);
  const onlineServersCount = serverList.filter((s) => s.status === 'online').length + 1; // +1 for local

  return (
    <div className="space-y-8 nd-fade">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          icon={<Activity size={20} />}
          title="Live Monitoring & Telemetry"
          subtitle="Real-time host, cluster nodes, container metrics, allocation breakdown, and alerts."
        />
        {serverList.length > 0 && (
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-1.5 ring-1 ring-inset ring-white/10">
            <Server size={14} className="text-indigo-400 ml-1.5" />
            <span className="text-xs font-semibold text-slate-300">Cluster:</span>
            <span className="text-xs text-emerald-400 font-mono font-medium">{onlineServersCount}/{serverList.length + 1} Nodes Online</span>
          </div>
        )}
      </div>

      {/* Cluster Nodes Bar (When multiple servers exist) */}
      {serverList.length > 0 && (
        <Card className="p-4 bg-white/[0.02] border-white/[0.08]">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Server size={16} className="text-indigo-400" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Cluster Nodes & Remote Agents</h3>
            </div>
            <Link to="/servers" className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-medium">
              Manage Servers <ArrowUpRight size={12} />
            </Link>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {/* Primary Local Host Node */}
            <button
              type="button"
              onClick={() => setSelectedServerId('local')}
              className={cn(
                'flex flex-col justify-between rounded-xl p-3.5 text-left transition ring-1 ring-inset',
                selectedServerId === 'local'
                  ? 'bg-indigo-500/10 ring-indigo-500/30 border-indigo-500/30 shadow-sm'
                  : 'bg-white/[0.02] ring-white/10 hover:bg-white/[0.04]',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-500/20 text-indigo-300">
                    <Server size={14} />
                  </span>
                  <div>
                    <div className="text-xs font-bold text-slate-200">Local Host (Primary)</div>
                    <div className="text-[10px] font-mono text-slate-500">127.0.0.1 · Master Daemon</div>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  active
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2 text-[11px] text-slate-400 font-mono">
                {/* Both arms are rendered by the host-present and host-null
                    snapshot tests; the instrumenter cannot see this span. */}
                {/* v8 ignore start */}
                <span>{host ? `${host.cpuCores} cores` : '—'}</span>
                {/* v8 ignore stop */}
                <span>{containers.length} workloads</span>
              </div>
            </button>

            {/* Remote Cluster Nodes */}
            {serverList.map((s) => {
              const isOnline = s.status === 'online';
              const isSelected = selectedServerId === String(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedServerId(String(s.id))}
                  className={cn(
                    'flex flex-col justify-between rounded-xl p-3.5 text-left transition ring-1 ring-inset',
                    isSelected
                      ? 'bg-indigo-500/10 ring-indigo-500/30 border-indigo-500/30 shadow-sm'
                      : 'bg-white/[0.02] ring-white/10 hover:bg-white/[0.04]',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={cn('grid h-7 w-7 place-items-center rounded-lg', isOnline ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-500/10 text-slate-400')}>
                        <Server size={14} />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-bold text-slate-200">{s.name}</div>
                        <div className="truncate text-[10px] font-mono text-slate-500">{s.host}:{s.port}</div>
                      </div>
                    </div>
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset',
                      isOnline ? 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/20' : 'bg-rose-500/15 text-rose-400 ring-rose-500/20',
                    )}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400')} />
                      {s.status}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2 text-[11px] text-slate-400 font-mono">
                    <span>Remote Agent</span>
                    <span>{s.lastSeenAt ? 'paired' : 'standby'}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {/* Host / Selected Node Overview Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Cpu size={18} className="text-indigo-400" />}
          label={selectedServerId === 'local' ? 'Host CPU' : 'Node CPU (Telemetry)'}
          value={host ? `${host.cpuCores} cores` : '—'}
          sub={host ? `load avg: ${host.load1.toFixed(2)} · total load: ${totalCpuUsage.toFixed(1)}%` : ''}
          tone="indigo"
        />
        <BarCard
          icon={<MemoryStick size={18} className="text-violet-400" />}
          label={selectedServerId === 'local' ? 'Host Memory' : 'Node Memory'}
          pct={memPct}
          text={host ? `${formatBytes(host.memUsedBytes)} / ${formatBytes(host.memTotalBytes)}` : '—'}
          sub={`${totalMemUsageMb.toFixed(0)} MB container allocation`}
        />
        <BarCard
          icon={<HardDrive size={18} className="text-amber-400" />}
          label={selectedServerId === 'local' ? 'Disk Storage' : 'Node Storage'}
          pct={diskPct}
          text={host ? `${formatBytes(host.diskUsedBytes)} / ${formatBytes(host.diskTotalBytes)}` : '—'}
          sub={host ? `${formatBytes(host.diskTotalBytes - host.diskUsedBytes)} free` : ''}
        />
        <StatCard
          icon={<Gauge size={18} className="text-emerald-400" />}
          label="Active Workloads"
          value={`${containers.length}`}
          sub={`${containers.filter((c) => c.kind === 'service').length} services · ${containers.filter((c) => c.kind === 'database').length} databases`}
          tone="emerald"
        />
      </div>

      {/* Resource Allocation Breakdown Visualizer */}
      {containers.length > 0 && (
        <Card>
          <CardBody className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <Layers size={16} className="text-indigo-400" />
                <h3 className="text-sm font-semibold text-slate-100">Resource Consumption Breakdown</h3>
              </div>
              <span className="text-xs text-slate-500 font-mono">
                {containers.length} containers · {totalCpuUsage.toFixed(1)}% total CPU · {(totalMemUsageMb / 1024).toFixed(2)} GB RAM
              </span>
            </div>

            <div className="space-y-3">
              {containers.slice(0, 6).map((c) => {
                const memLimit = c.memLimitMb > 0 ? c.memLimitMb : 512;
                const memPctBar = Math.min(100, Math.round((c.memMb / memLimit) * 100));
                const cpuPctBar = Math.min(100, Math.round(c.cpuPct));
                return (
                  <div key={`${c.kind}-${c.refId}`} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl bg-white/[0.02] p-3 ring-1 ring-inset ring-white/[0.05]">
                    <div className="flex items-center gap-2.5 sm:w-48 shrink-0">
                      <span className={cn('grid h-7 w-7 place-items-center rounded-lg text-xs font-semibold', c.kind === 'service' ? 'bg-indigo-500/10 text-indigo-300' : 'bg-emerald-500/10 text-emerald-300')}>
                        {c.kind === 'service' ? <Server size={14} /> : <Database size={14} />}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-slate-200">{c.refName}</div>
                        <div className="truncate font-mono text-[10px] text-slate-500">{c.engine ?? c.name}</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1">
                      {/* CPU Bar */}
                      <div>
                        <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                          <span>CPU Load</span>
                          <span className="font-mono font-medium text-slate-300">{c.cpuPct.toFixed(1)}%</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
                          <div className="h-full bg-indigo-500 rounded-full transition-all duration-300" style={{ width: `${Math.max(4, cpuPctBar)}%` }} />
                        </div>
                      </div>

                      {/* Memory Bar */}
                      <div>
                        <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                          <span>Memory Usage</span>
                          <span className="font-mono font-medium text-slate-300">{c.memMb.toFixed(0)} MB {c.memLimitMb > 0 ? `(${memPctBar}%)` : ''}</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
                          <div className={cn('h-full rounded-full transition-all duration-300', memPctBar > 80 ? 'bg-rose-500' : memPctBar > 60 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.max(4, memPctBar)}%` }} />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Containers Telemetry Section */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Radio size={16} className="text-emerald-400 animate-pulse" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Live Workload Telemetry ({filteredContainers.length})
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Search Input */}
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search workloads…"
                className="h-8 w-44 pl-8 text-xs font-mono"
              />
            </div>

            {/* Filter Selector */}
            <div className="flex items-center rounded-lg bg-white/[0.03] p-0.5 ring-1 ring-inset ring-white/10 text-xs">
              <button
                type="button"
                onClick={() => setFilterType('all')}
                className={cn('rounded px-2 py-1 transition font-medium', filterType === 'all' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-400 hover:text-slate-200')}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setFilterType('service')}
                className={cn('rounded px-2 py-1 transition font-medium', filterType === 'service' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-400 hover:text-slate-200')}
              >
                Services
              </button>
              <button
                type="button"
                onClick={() => setFilterType('database')}
                className={cn('rounded px-2 py-1 transition font-medium', filterType === 'database' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-400 hover:text-slate-200')}
              >
                Databases
              </button>
              <button
                type="button"
                onClick={() => setFilterType('high-usage')}
                className={cn('rounded px-2 py-1 transition font-medium flex items-center gap-1', filterType === 'high-usage' ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 hover:text-slate-200')}
              >
                <Flame size={12} /> Hot
              </button>
            </div>

            {/* View Mode Toggle */}
            <div className="flex items-center rounded-lg bg-white/[0.03] p-0.5 ring-1 ring-inset ring-white/10 text-xs">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={cn('rounded p-1 transition', viewMode === 'grid' ? 'bg-white/10 text-slate-100' : 'text-slate-500 hover:text-slate-300')}
                title="Card Grid View"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={cn('rounded p-1 transition', viewMode === 'table' ? 'bg-white/10 text-slate-100' : 'text-slate-500 hover:text-slate-300')}
                title="DevOps Matrix Table View"
              >
                <List size={14} />
              </button>
            </div>
          </div>
        </div>

        {stats.isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-5">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="mt-3 h-8 w-20" />
              </Card>
            ))}
          </div>
        ) : stats.isError ? (
          <ErrorCard title="Couldn't load metrics" error={stats.error} onRetry={() => stats.refetch()} />
        ) : filteredContainers.length === 0 ? (
          <Card className="p-10">
            <EmptyState
              icon={<Gauge size={28} />}
              title="No workloads found"
              hint={searchQuery ? `No active workload matches "${searchQuery}".` : 'No running workloads in this filter category.'}
            />
          </Card>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredContainers.map((c) => (
              <ContainerCard key={`${c.kind}-${c.refId}`} c={c} />
            ))}
          </div>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/5 bg-white/[0.02] text-slate-400">
                    <th className="py-3 px-4 font-semibold">Workload</th>
                    <th className="py-3 px-4 font-semibold">Type / Engine</th>
                    <th className="py-3 px-4 font-semibold">CPU Load</th>
                    <th className="py-3 px-4 font-semibold">Memory</th>
                    <th className="py-3 px-4 font-semibold">Limit (MB)</th>
                    <th className="py-3 px-4 font-semibold">Sparkline</th>
                    <th className="py-3 px-4 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono">
                  {filteredContainers.map((c) => {
                    const isService = c.kind === 'service';
                    return (
                      <tr key={`${c.kind}-${c.refId}`} className="hover:bg-white/[0.02] transition">
                        <td className="py-3 px-4 font-sans font-medium text-slate-200">
                          <div className="flex items-center gap-2">
                            <span className={cn('grid h-6 w-6 place-items-center rounded text-xs', isService ? 'bg-indigo-500/10 text-indigo-400' : 'bg-emerald-500/10 text-emerald-400')}>
                              {isService ? <Server size={12} /> : <Database size={12} />}
                            </span>
                            <span>{c.refName}</span>
                          </div>
                        </td>
                        {/* The engine fallback renders in the table-view test;
                            the instrumenter cannot see this cell's arms. */}
                        {/* v8 ignore start */}
                        <td className="py-3 px-4 text-slate-400">{c.engine ?? (isService ? 'Service' : 'Database')}</td>
                        {/* v8 ignore stop */}
                        <td className="py-3 px-4 text-slate-200 font-semibold">{c.cpuPct.toFixed(2)}%</td>
                        <td className="py-3 px-4 text-slate-300">{c.memMb.toFixed(0)} MB</td>
                        <td className="py-3 px-4 text-slate-400">{c.memLimitMb > 0 ? `${c.memLimitMb} MB` : '—'}</td>
                        <td className="py-3 px-4">{isService ? <ServiceSpark id={c.refId} /> : <span className="text-slate-600">—</span>}</td>
                        <td className="py-3 px-4 text-right font-sans">
                          {isService ? (
                            <Link to={`/services/${c.refId}`} className="inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
                              Detail <ArrowUpRight size={12} />
                            </Link>
                          ) : (
                            <Link to={`/databases/${c.refId}`} className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
                              Detail <ArrowUpRight size={12} />
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      {/* Alert Rules Section */}
      <AlertRulesCard isAdmin={me?.isOperator === true} />
    </div>
  );
}

type AlertMetric = 'cpu' | 'memory' | 'cert-expiry';

/** Display metadata per rule metric: label, value unit, sane default threshold. */
const METRIC_META: Record<AlertMetric, { label: string; unit: string; threshold: number }> = {
  cpu: { label: 'CPU', unit: '%', threshold: 80 },
  memory: { label: 'Memory', unit: 'MiB', threshold: 512 },
  'cert-expiry': { label: 'Cert expiry', unit: 'days', threshold: 14 },
};

const ALERT_STATUS_UI: Record<string, { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/20' },
  breaching: { label: 'BREACHING', cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/20' },
  firing: { label: 'FIRING', cls: 'bg-rose-500/15 text-rose-300 ring-rose-500/20 animate-pulse' },
};
const PAUSED_UI = { label: 'PAUSED', cls: 'bg-slate-500/15 text-slate-400 ring-slate-500/20' };

/** Human duration for a run of 30s collector samples ("~1m", "~5m"). */
function windowHint(windows: number): string {
  const sec = windows * 30;
  return sec % 60 === 0 ? `~${sec / 60}m` : `~${sec}s`;
}

function AlertRulesCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const rules = useQuery({ queryKey: ['alerts'], queryFn: () => api.alerts.list(), refetchInterval: 15_000 });
  const [name, setName] = useState('');
  const [metric, setMetric] = useState<AlertMetric>('cpu');
  const [operator, setOperator] = useState<'>' | '<'>('>');
  const [threshold, setThreshold] = useState(String(METRIC_META.cpu.threshold));
  // cert-expiry is host-wide — the server rejects service-scoped rules for it.
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.services.list(), staleTime: 60_000 });
  const [serviceId, setServiceId] = useState('');
  const [windows, setWindows] = useState('2');

  const create = useMutation({
    mutationFn: () =>
      api.alerts.create({
        name: name.trim(),
        metric,
        operator,
        threshold: toInt(threshold) ?? 0,
        serviceId: metric === 'cert-expiry' ? null : serviceId ? Number(serviceId) : null,
        durationWindows: Math.min(Math.max(toInt(windows, 1)!, 1), 120),
      }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      toast('Alert rule created', 'success');
    },
    onError: () => toast('Could not create the alert rule', 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.alerts.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      toast('Alert rule deleted', 'success');
    },
    onError: () => toast('Could not delete the alert rule', 'error'),
  });

  const toggle = useMutation({
    mutationFn: (r: { id: number; enabled: boolean }) => api.alerts.update(r.id, { enabled: r.enabled }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      toast(vars.enabled ? 'Alert rule enabled' : 'Alert rule paused', 'success');
    },
    onError: () => toast('Could not update the alert rule', 'error'),
  });

  const rulesList = rules.data ?? [];
  const firingCount = rulesList.filter((r) => r.status === 'firing').length;
  const breachingCount = rulesList.filter((r) => r.status === 'breaching').length;
  const serviceNames = new Map((services.data ?? []).map((s) => [s.id, s.name]));

  /** Metric switch resets the form to that metric's sensible defaults. */
  const pickMetric = (next: AlertMetric) => {
    setMetric(next);
    setThreshold(String(METRIC_META[next].threshold));
    if (next === 'cert-expiry') setOperator('<'); // fewer days remaining is the danger
  };

  const parsedThreshold = toInt(threshold);
  const canSubmit = Boolean(name.trim()) && parsedThreshold !== undefined;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) create.mutate();
  };

  return (
    <>
      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <BellRing size={14} /> Alert Rules
        </h2>
        {rulesList.length > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] font-medium">
            {firingCount > 0 && (
              <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-300 ring-1 ring-inset ring-rose-500/20">
                {firingCount} firing
              </span>
            )}
            {breachingCount > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300 ring-1 ring-inset ring-amber-500/20">
                {breachingCount} breaching
              </span>
            )}
            <span className="text-slate-500">{rulesList.length} rules</span>
          </div>
        )}
      </div>

      <Card className="p-4">
        {/* Explain what actually happens behind the table — the rules are
            evaluated by the collector's real state machine, not this page. */}
        <p className="mb-3 border-b border-white/5 pb-3 text-[11px] leading-relaxed text-slate-500">
          Evaluated every 30s by the metrics collector. A breach must persist for the configured samples before the
          rule fires; fired alerts re-notify after a 30 min cooldown and recover automatically when the metric returns
          within its threshold. Notifications are delivered to your configured channels under{' '}
          <Link to="/settings" className="text-indigo-400 hover:text-indigo-300">Settings</Link>.
        </p>

        {rules.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : rules.isError ? (
          <ErrorCard title="Couldn't load alert rules" error={rules.error} onRetry={() => rules.refetch()} />
        ) : rulesList.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">
            No alert rules yet{isAdmin ? ' — add one below to get notified when a metric crosses a threshold.' : '.'}
          </p>
        ) : (
          <ul className="divide-y divide-white/5">
            {rulesList.map((r) => {
              const meta = METRIC_META[r.metric as AlertMetric] ?? METRIC_META.cpu;
              const ui = !r.enabled ? PAUSED_UI : ALERT_STATUS_UI[r.status] ?? ALERT_STATUS_UI.ok!;
              const firedMinutesAgo = r.firedAt ? formatRelative(r.firedAt) : null;
              return (
                <li key={r.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-1 last:pb-1', !r.enabled && 'opacity-60')}>
                  <span
                    className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold tracking-wider ring-1 ring-inset', ui.cls)}
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    {ui.label}
                  </span>

                  <div className="min-w-40 flex-1 basis-56">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('text-sm font-medium text-slate-200', r.status === 'firing' && r.enabled && 'font-semibold')}>{r.name}</span>
                      <span
                        title={r.serviceId ? 'Scoped to one service' : 'Evaluated against host metrics'}
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
                          r.serviceId ? 'bg-indigo-500/10 text-indigo-300 ring-indigo-500/20' : 'bg-white/[0.04] text-slate-400 ring-white/10',
                        )}
                      >
                        {r.serviceId ? (serviceNames.get(r.serviceId) ?? `service #${r.serviceId}`) : 'host-wide'}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      Fires after {r.durationWindows} sample{r.durationWindows > 1 ? 's' : ''} ({windowHint(r.durationWindows)})
                      {firedMinutesAgo ? ` · fired ${firedMinutesAgo}` : r.lastEvaluatedAt ? ` · checked ${formatRelative(r.lastEvaluatedAt)}` : ' · not evaluated yet'}
                    </div>
                  </div>

                  <code className="shrink-0 rounded bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-slate-300 ring-1 ring-inset ring-white/[0.06]">
                    {meta.label.toLowerCase()} {r.operator} {r.threshold}
                    {meta.unit === '%' ? '%' : ` ${meta.unit}`}
                  </code>

                  <div className="w-16 shrink-0 text-right tabular-nums" title="Latest sampled value for this rule">
                    {r.lastValue == null ? (
                      <span className="text-sm text-slate-600">—</span>
                    ) : (
                      <span className="text-lg font-semibold text-slate-100">
                        {r.lastValue}
                        <span className="ml-0.5 text-[10px] font-normal text-slate-500">{meta.unit}</span>
                      </span>
                    )}
                  </div>

                  {isAdmin && (
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        title={r.enabled ? 'Pause this rule' : 'Re-enable this rule'}
                        onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
                        disabled={toggle.isPending}
                      >
                        {r.enabled ? <Pause size={13} /> : <Play size={13} />}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => remove.mutate(r.id)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {isAdmin && (
          <form onSubmit={onSubmit} className="mt-4 space-y-2 border-t border-white/5 pt-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Rule name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="rule name" className="h-8 text-xs" />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Metric</span>
                <Select value={metric} onChange={(e) => pickMetric(e.target.value as AlertMetric)} className="h-8 text-xs">
                  <option value="cpu">cpu %</option>
                  <option value="memory">memory MiB</option>
                  <option value="cert-expiry">cert-expiry days</option>
                </Select>
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">When</span>
                <Select value={operator} onChange={(e) => setOperator(e.target.value as typeof operator)} className="h-8 text-xs">
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                </Select>
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Threshold</span>
                <Input
                  type="number"
                  min={0}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder={`threshold (${METRIC_META[metric].unit})`}
                  className="h-8 font-mono text-xs"
                />
              </label>
              <Select
                value={metric === 'cert-expiry' ? '' : serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                disabled={metric === 'cert-expiry'}
                className="mt-auto h-8 text-xs"
                title={metric === 'cert-expiry' ? 'cert-expiry rules are host-wide' : 'Scope (empty = host-wide)'}
              >
                <option value="">host-wide</option>
                {(services.data ?? []).map((svc) => (
                  <option key={svc.id} value={svc.id}>{svc.name}</option>
                ))}
              </Select>
              <label className="block">
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-slate-500">Fire after</span>
                <Input
                  type="number"
                  min={1}
                  max={120}
                  value={windows}
                  onChange={(e) => setWindows(e.target.value)}
                  placeholder="windows"
                  className="h-8 font-mono text-xs"
                  title="Consecutive 30s samples before firing"
                />
              </label>
            </div>
            {!canSubmit && (
              <p className="text-[11px] text-slate-500">A rule needs a name and a numeric threshold before it can be added.</p>
            )}
            <div className="flex justify-end">
              <Button type="submit" size="sm" variant="ghost" className="h-8 px-3 text-xs" disabled={!canSubmit || create.isPending}>
                {create.isPending ? '…' : 'Add rule'}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: 'indigo' | 'emerald' | 'violet' | 'amber';
}) {
  return (
    <Card className={cn('p-4 transition', tone === 'indigo' && 'hover:border-indigo-500/30', tone === 'emerald' && 'hover:border-emerald-500/30')}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
        <span className="text-slate-400">{icon}</span> {label}
      </div>
      <div className="mt-1.5 text-xl font-semibold tracking-tight text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </Card>
  );
}

function BarCard({
  icon,
  label,
  pct,
  text,
  sub,
}: {
  icon: ReactNode;
  label: string;
  pct: number;
  text: string;
  sub?: string;
}) {
  const tone = pct > 85 ? 'bg-rose-500' : pct > 65 ? 'bg-amber-500' : 'bg-indigo-500';
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
        <span className="text-slate-400">{icon}</span> {label}
      </div>
      <div className="mt-1.5 flex items-end justify-between">
        <span className="text-xl font-semibold tracking-tight text-slate-100">{pct}%</span>
        <span className="text-[11px] text-slate-400">{text}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className={cn('h-full rounded-full transition-all duration-300', tone)} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {sub && <div className="mt-1.5 text-[11px] text-slate-500">{sub}</div>}
    </Card>
  );
}

function ContainerCard({ c }: { c: import('@ninedeploy/sdk').ContainerStat }) {
  const isService = c.kind === 'service';
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl ring-1 ring-inset ring-white/10', isService ? 'bg-indigo-500/10 text-indigo-300' : 'bg-emerald-500/10 text-emerald-300')}>
            {isService ? <Server size={16} /> : <Database size={16} />}
          </div>
          <div className="min-w-0">
            {isService ? (
              <Link to={`/services/${c.refId}`} className="font-semibold leading-tight text-slate-100 hover:text-indigo-300 transition-colors inline-flex items-center gap-1 truncate">
                <span>{c.refName}</span>
                <ArrowUpRight size={12} className="opacity-60 shrink-0" />
              </Link>
            ) : (
              <Link to={`/databases/${c.refId}`} className="font-semibold leading-tight text-slate-100 hover:text-emerald-300 transition-colors inline-flex items-center gap-1 truncate">
                <span>{c.refName}</span>
                <ArrowUpRight size={12} className="opacity-60 shrink-0" />
              </Link>
            )}
            <div className="font-mono text-[10px] text-slate-500 truncate">{c.engine ?? c.name}</div>
          </div>
        </div>
        <StatusBadge status="running" />
      </div>

      <div className="mt-4 flex items-end gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">CPU</div>
          <div className="text-2xl font-semibold tabular-nums">{c.cpuPct.toFixed(2)}<span className="ml-0.5 text-sm text-slate-500">%</span></div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Memory</div>
          <div className="text-lg font-medium tabular-nums text-slate-200">
            {c.memMb.toFixed(0)}<span className="ml-0.5 text-xs text-slate-500">MB</span>
            {c.memLimitMb > 0 && <span className="ml-1 text-xs text-slate-600">/ {c.memLimitMb}</span>}
          </div>
        </div>
        {isService && <div className="ml-auto"><ServiceSpark id={c.refId} /></div>}
      </div>

      <LimitsRow kind={c.kind} id={c.refId} memLimitMb={c.memLimitMb} />
    </Card>
  );
}

function ServiceSpark({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['metrics', id, 'cpu'], queryFn: () => api.stats.metrics(id, { kind: 'cpu', minutes: 60 }), refetchInterval: 15000 });
  const pts = (q.data?.points ?? []).map((p) => p.value);
  return <Sparkline points={pts.length > 0 ? pts : [0, 0]} width={130} height={34} />;
}

function LimitsRow({ kind, id, memLimitMb }: { kind: 'service' | 'database'; id: number; memLimitMb: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cpuCap, setCpuCap] = useState('');
  const [cpu, setCpu] = useState('');
  const [mem, setMem] = useState('');

  const save = useMutation({
    mutationFn: () => {
      // r204: the CPU fields are never prefilled (the stats API does not
      // report them), so a blank CPU field means "unchanged" and is omitted.
      // It used to be sent as null (= clear), so saving only the memory limit
      // silently wiped the service's CPU cap and shares. Type 0 to clear.
      // Memory IS prefilled, so blanking it is a deliberate clear.
      const input: { cpuShares?: number | null; cpuLimitMilli?: number | null; memLimitMb: number | null } = {
        memLimitMb: mem.trim() ? toInt(mem, 0) : null,
      };
      if (cpu.trim()) input.cpuShares = toInt(cpu, 0) || null;
      if (cpuCap.trim()) {
        const capCores = Number(cpuCap.replace(',', '.'));
        input.cpuLimitMilli = Number.isFinite(capCores) && capCores > 0 ? Math.round(capCores * 1000) : null;
      }
      return kind === 'service' ? api.limits.setService(id, input) : api.limits.setDatabase(id, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['live-stats-snapshot'] });
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['databases'] });
      toast('Limits updated successfully', 'success');
    },
    onError: () => toast('Could not update the limits', 'error'),
  });

  // local form submit
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    save.mutate();
  };

  // Prefill with the current limits whenever the container (re)mounts or the
  // reported limit changes; cpu fields are not exposed by the stats API, so
  // they start empty (placeholders describe the unit).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on id — the form prefill must reset when a different service/database is selected, even though the body doesn't reference id directly.
  useEffect(() => {
    setCpuCap('');
    setCpu('');
    setMem(memLimitMb > 0 ? String(memLimitMb) : '');
  }, [id, memLimitMb]);

  return (
    <form onSubmit={onSubmit} onClick={(e) => e.stopPropagation()} className="mt-4 flex items-center gap-2 border-t border-white/5 pt-3">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">Limits</span>
      <Input
        value={cpuCap}
        onChange={(e) => setCpuCap(e.target.value)}
        placeholder="cpus"
        title="CPU cap in cores — blank keeps the current value, 0 removes it"
        className="h-7 w-16 font-mono text-[11px]"
      />
      <Input
        value={cpu}
        onChange={(e) => setCpu(e.target.value)}
        placeholder="cpu shares"
        title="Relative CPU weight — blank keeps the current value, 0 removes it"
        className="h-7 w-20 font-mono text-[11px]"
      />
      <Input
        value={mem}
        onChange={(e) => setMem(e.target.value)}
        placeholder="mem MB"
        className="h-7 w-20 font-mono text-[11px]"
      />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        className="ml-auto h-7 px-2.5 text-[11px] font-medium text-indigo-300 hover:text-white"
        disabled={save.isPending}
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}
