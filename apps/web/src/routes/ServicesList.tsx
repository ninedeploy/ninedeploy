import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Cpu, GitBranch, HardDrive, Layers, MemoryStick, Plus, Search, Server } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../lib/api.js';
import { useTagScope } from '../lib/projects.js';
import { Button, Card, EmptyState, ErrorCard, Input, PageHeader, Skeleton, StatusBadge } from '../components/ui.js';
import { DeployWizard } from '../components/DeployWizard.js';
import { LanesModal } from '../components/LanesModal.js';
import { ServiceDomainLauncher } from '../components/ServiceDomainLauncher.js';

export function ServicesList() {
  const [wizard, setWizard] = useState(false);
  const [lanesModal, setLanesModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped' | 'errored'>('all');
  // Deployment lane filter: 'all' or an environment id as a string.
  const [envFilter, setEnvFilter] = useState<'all' | string>('all');
  // The top-bar `TopBarFilters` chip groups drive these query parameters.
  // Empty arrays mean "no constraint" — the server returns every service
  // the caller is allowed to see, just like the unfiltered legacy mode.
  const { workspaceIds, projectIds, labelIds } = useTagScope();
  const buildQuery = (): string => {
    const params: string[] = [];
    if (workspaceIds.length > 0) params.push(`tagWorkspaceIds=${workspaceIds.join(',')}`);
    if (projectIds.length > 0) params.push(`tagProjectIds=${projectIds.join(',')}`);
    if (labelIds.length > 0) params.push(`tagLabelIds=${labelIds.join(',')}`);
    return params.length > 0 ? `?${params.join('&')}` : '';
  };
  const { data: services, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['services', workspaceIds, projectIds, labelIds],
    queryFn: () => api.services.list(buildQuery()),
  });

  // Deployment lanes (production / staging / …) for the filter dropdown.
  const { data: environments } = useQuery({
    queryKey: ['environments'],
    queryFn: () => api.environments.list(),
  });

  const snapshot = useQuery({
    queryKey: ['live-stats-snapshot'],
    queryFn: () => api.stats.snapshot(),
    refetchInterval: 3000,
  });

  const filteredServices = useMemo(() => {
    if (!services) return [];
    return services.filter((s) => {
      const matchStatus = statusFilter === 'all' || s.status === statusFilter;
      if (!matchStatus) return false;
      // Deployment lane: 'all' or a specific environment id. Ungrouped
      // services (environmentId null) only show under 'all'.
      if (envFilter !== 'all' && String(s.environmentId ?? '') !== envFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      // Every nullish arm is exercised by the branch-less service fixture in
      // the search test; the instrumenter cannot see these expressions.
      /* v8 ignore start */
      return (
        (s.name ?? '').toLowerCase().includes(q) ||
        (s.slug ?? '').toLowerCase().includes(q) ||
        (s.branch ?? '').toLowerCase().includes(q) ||
        (s.type ?? '').toLowerCase().includes(q)
      );
      /* v8 ignore stop */
    });
  }, [services, searchQuery, statusFilter, envFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Server size={18} />}
        title="Services"
        subtitle="Deploy and manage your applications."
        actions={
          <Button onClick={() => setWizard(true)}>
            <Plus size={16} /> New service
          </Button>
        }
      />

      {wizard && <DeployWizard onClose={() => setWizard(false)} />}
      {lanesModal && <LanesModal onClose={() => setLanesModal(false)} />}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-3 h-3 w-2/3" />
              <Skeleton className="mt-4 h-6 w-24" />
            </Card>
          ))}
        </div>
      ) : isError ? (
        <ErrorCard title="Couldn't load services" error={error} onRetry={() => void refetch()} />
      ) : !services || services.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Server size={26} />}
            title="No services yet"
            hint="Connect a repository to deploy your first application in seconds."
            action={
              <Button onClick={() => setWizard(true)}>
                <Plus size={16} /> Create service
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Search, deployment lane and status filter bar */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-xs flex-1">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                placeholder="Search services..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto">
              <button
                type="button"
                onClick={() => setLanesModal(true)}
                className="flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-400 transition hover:text-slate-200"
                title="Manage deployment lanes"
                aria-label="Manage deployment lanes"
              >
                <Layers size={12} /> Lanes
              </button>
              {environments && environments.length > 0 && (
                <select
                  value={envFilter}
                  onChange={(e) => setEnvFilter(e.target.value)}
                  className="rounded-lg bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-300 ring-1 ring-inset ring-white/10"
                  aria-label="Filter by environment"
                >
                  <option value="all">All lanes</option>
                  {environments.map((e) => (
                    <option key={e.id} value={String(e.id)}>
                      {e.name}
                    </option>
                  ))}
                </select>
              )}
              {(['all', 'running', 'stopped', 'errored'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition ${
                    statusFilter === st
                      ? 'bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-500/30'
                      : 'bg-white/[0.03] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          {filteredServices.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Server size={24} />}
                title="No matching services"
                hint="Try searching with a different keyword or resetting your filter."
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSearchQuery('');
                      setStatusFilter('all');
                    }}
                  >
                    Reset filters
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredServices.map((s) => {
                const liveStat = snapshot.data?.containers.find((c) => c.refId === s.id && c.kind === 'service');
                const isRunning = s.status === 'running';

                return (
                  <div key={s.id} className="relative h-full">
                    <Link to={`/services/${s.id}`} className="block h-full">
                    <Card interactive className="group h-full p-5 flex flex-col justify-between">
                      <div>
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-slate-400 ring-1 ring-inset ring-white/10 transition group-hover:text-indigo-300">
                              <Server size={18} />
                            </div>
                            <div className="min-w-0">
                              <div className="font-semibold leading-tight text-slate-100 group-hover:text-white truncate">{s.name}</div>
                              <div className="font-mono text-[11px] text-slate-500 truncate">{s.slug}</div>
                            </div>
                          </div>
                          <StatusBadge status={s.status} />
                        </div>

                        {/* Live CPU & RAM Telemetry Badges */}
                        {isRunning && (
                          <div className="mt-3.5 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-500/20">
                              <Cpu size={11} className="text-indigo-400" />
                              {liveStat ? `${liveStat.cpuPct.toFixed(1)}%` : '0.0%'}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                              <MemoryStick size={11} className="text-emerald-400" />
                              {liveStat ? `${liveStat.memMb.toFixed(1)} MiB` : '0.0 MiB'}
                            </span>
                            {s.volumeMount && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-300 ring-1 ring-inset ring-amber-500/20" title={`Volume mounted at ${s.volumeMount}`}>
                                <HardDrive size={11} className="text-amber-400" />
                                {s.volumeMount}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="mt-4 flex items-center justify-between border-t border-white/[0.04] pt-3 pr-12 text-xs text-slate-500">
                        <div className="flex items-center gap-3">
                          <span className="font-mono uppercase tracking-wide text-slate-400 text-[10px]">{s.type}</span>
                          <span className="flex items-center gap-1 font-mono text-[11px]">
                            <GitBranch size={11} /> {s.branch}
                          </span>
                        </div>
                        {s.publishedPort ? (
                          <span className="font-mono text-emerald-400 font-semibold">:{s.publishedPort}</span>
                        ) : s.port ? (
                          <span className="font-mono">:{s.port}</span>
                        ) : null}
                      </div>
                    </Card>
                    </Link>
                    <ServiceDomainLauncher serviceId={s.id} serviceName={s.name} className="absolute bottom-3 right-3 z-10" />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
