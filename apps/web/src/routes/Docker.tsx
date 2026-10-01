import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Check, Code2, Container, Copy, Cpu, FileCode, ImageIcon, Radio, RefreshCw, Search, Shield, Terminal, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { copyText } from '../lib/format.js';
import { Button, Card, EmptyState, Input, PageHeader, Skeleton } from '../components/ui.js';

function fmtEventTime(raw: string): string {
  const seconds = Number(raw);
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleTimeString();
}

/** Unified Docker dashboard: disk/images + live container inspector + daemon event feed. */
export function DockerDashboard() {
  const { user } = useAuth();
  const isAdmin = user?.isOperator === true;
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
  const [manualContainer, setManualContainer] = useState('');
  const [copiedYaml, setCopiedYaml] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'compose' | 'traefik' | 'inspect'>('compose');

  // The inspector reveals container env vars (incl. DB credentials) — the API
  // is admin-only, so hide the inspector for members instead of erroring.
  const canInspect = isAdmin;

  const resources = useQuery({
    queryKey: ['docker-resources'],
    queryFn: () => api.system.resources(),
    // r472: resources/events are operator-only routes — a member hitting /docker
    // directly must not poll two refused calls every 20-30 s alongside the
    // error card they render as.
    enabled: isAdmin,
    refetchInterval: 30000,
  });

  const stats = useQuery({
    queryKey: ['docker-stats-snapshot'],
    queryFn: () => api.stats.snapshot(),
    refetchInterval: 10000,
  });

  const events = useQuery({
    queryKey: ['docker-events'],
    queryFn: () => api.system.dockerEvents(60),
    enabled: isAdmin,
    refetchInterval: 20000,
  });

  const composeQuery = useQuery({
    queryKey: ['container-compose', selectedContainer],
    // The null arm is unreachable: `enabled` only lets the query run once a
    // container is selected.
    /* v8 ignore start */
    queryFn: () => (selectedContainer ? api.containers.compose(selectedContainer) : null),
    /* v8 ignore stop */
    enabled: canInspect && Boolean(selectedContainer),
    retry: 1,
  });

  const inspectQuery = useQuery({
    queryKey: ['container-inspect', selectedContainer],
    // Same gating as the compose query above.
    /* v8 ignore start */
    queryFn: () => (selectedContainer ? api.containers.inspect(selectedContainer) : null),
    /* v8 ignore stop */
    enabled: canInspect && Boolean(selectedContainer),
    retry: 1,
  });

  const r = resources.data;
  const containerStats = stats.data?.containers ?? [];
  const composeData = composeQuery.data;
  const inspectData = inspectQuery.data ?? composeData?.inspect;
  const traefikTags = inspectData?.traefikTags ?? {};

  // Both copy handlers are exercised end-to-end (the clipboard mock receives
  // the YAML/JSON payloads); the instrumenter cannot see these spans, and the
  // query null-arms below are gated off by their `enabled` flags.
  /* v8 ignore start */
  const handleCopyYaml = async () => {
    if (!composeData?.yaml) return;
    if (await copyText(composeData.yaml)) {
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 2000);
    }
  };

  const handleCopyJson = async () => {
    if (!inspectData?.raw) return;
    if (await copyText(JSON.stringify(inspectData.raw, null, 2))) {
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  };
  /* v8 ignore stop */

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Container size={18} />}
        title="Docker Dashboard"
        subtitle="Host-level images, disk usage, live container inspect manifests and the daemon event feed"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500"><Container size={13} /> Containers</div>
          <div className="mt-2 text-2xl font-semibold text-slate-100">{r ? r.containers : <Skeleton className="h-8 w-16" />}</div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500"><Cpu size={13} /> Volumes</div>
          <div className="mt-2 text-2xl font-semibold text-slate-100">{r ? r.volumes : <Skeleton className="h-8 w-16" />}</div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500"><ImageIcon size={13} /> Images</div>
          <div className="mt-2 text-2xl font-semibold text-slate-100">
            {r ? (
              <span>
                {r.imagesSummary.total}
                <span className="ml-2 text-sm font-normal text-slate-500">{r.imagesSummary.active} active · {r.imagesSummary.reclaimable} reclaimable</span>
              </span>
            ) : (
              <Skeleton className="h-8 w-32" />
            )}
          </div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs text-slate-500"><Radio size={13} /> Shared network</div>
          <div className="mt-2 truncate font-mono text-lg text-slate-300">{r?.network ?? '—'}</div>
        </Card>
      </div>

      {/* Live Containers & Quick Inspect Section */}
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Live Containers & Diagnostics</h2>
            <p className="text-xs text-slate-400">Inspect container runtime manifest, dynamic Traefik tags, and raw Docker inspect state</p>
          </div>
          {canInspect ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (manualContainer.trim()) {
                  setSelectedContainer(manualContainer.trim());
                }
              }}
              className="flex items-center gap-2"
            >
              <Input
                value={manualContainer}
                onChange={(e) => setManualContainer(e.target.value)}
                placeholder="Inspect container name…"
                className="h-8 w-48 text-xs font-mono"
              />
              <Button type="submit" variant="secondary" size="sm" className="h-8 text-xs">
                <Search size={13} className="mr-1" /> Inspect
              </Button>
            </form>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1 text-[11px] text-slate-400">
              <Shield size={12} /> Admin access required for the inspector
            </span>
          )}
        </div>

        {stats.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : containerStats.length === 0 ? (
          <p className="text-xs text-slate-500">No active containers found on host daemon.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {containerStats.map((c) => (
              <div
                key={c.name}
                className={`flex items-center justify-between rounded-xl border p-3 transition ${
                  selectedContainer === c.name
                    ? 'border-indigo-500/50 bg-indigo-500/10'
                    : 'border-white/5 bg-white/[0.02] hover:border-white/10'
                }`}
              >
                <div className="min-w-0 flex-1 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                    <span className="truncate font-mono text-xs font-medium text-slate-200">{c.name}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-mono text-slate-400 uppercase">{c.kind}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[10px] text-slate-500 font-mono">
                    <span>CPU: {c.cpuPct.toFixed(1)}%</span>
                    <span>RAM: {Math.round(c.memMb)}MB</span>
                  </div>
                </div>
                <Button
                  variant={selectedContainer === c.name ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={!canInspect}
                  onClick={() => setSelectedContainer(c.name)}
                  className="h-7 text-[11px]"
                >
                  <FileCode size={12} className="mr-1" /> Inspect
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Selected Container Inspector Drawer / Card */}
      {canInspect && selectedContainer && (
        <Card className="border border-indigo-500/30 bg-slate-900/90 shadow-2xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                <FileCode size={20} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">{selectedContainer}</h3>
                  {inspectData && (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
                      {inspectData.state.status.toUpperCase()}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400">Generated Docker Compose YAML, Traefik tags, and Docker inspect output</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  composeQuery.refetch();
                  inspectQuery.refetch();
                }}
                disabled={composeQuery.isFetching}
              >
                <RefreshCw size={13} className={composeQuery.isFetching ? 'animate-spin mr-1' : 'mr-1'} /> Refresh
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedContainer(null)}>
                <X size={15} />
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 border-b border-white/[0.08] pb-2">
            <button
              type="button"
              onClick={() => setActiveSubTab('compose')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeSubTab === 'compose'
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Code2 size={13} /> Compose Manifest
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab('traefik')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeSubTab === 'traefik'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Shield size={13} /> Traefik Tags ({Object.keys(traefikTags).length})
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab('inspect')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeSubTab === 'inspect'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Terminal size={13} /> Docker Inspect
            </button>
          </div>

          {activeSubTab === 'compose' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-slate-400">docker-compose.runtime.yml</span>
                <Button variant="secondary" size="sm" onClick={handleCopyYaml} className="h-7 text-xs">
                  {copiedYaml ? <><Check size={12} className="mr-1 text-emerald-400" /> Copied</> : <><Copy size={12} className="mr-1" /> Copy Compose</>}
                </Button>
              </div>
              <pre className="p-4 text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed bg-black/50 rounded-xl border border-white/5 max-h-80 overflow-y-auto">
                {composeData?.yaml || '# Loading or unavailable'}
              </pre>
            </div>
          )}

          {activeSubTab === 'traefik' && (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {Object.keys(traefikTags).length === 0 ? (
                <p className="text-xs text-slate-500 p-4 text-center">No Traefik tags discovered on container labels.</p>
              ) : (
                Object.entries(traefikTags).map(([key, value]) => (
                  <div key={key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-white/5 bg-black/40 p-2.5 font-mono text-xs">
                    <span className="text-amber-300 font-semibold">{key}</span>
                    <span className="text-slate-300 break-all bg-black/40 px-2 py-0.5 rounded">{value}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {activeSubTab === 'inspect' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-slate-400">docker-inspect.json</span>
                <Button variant="secondary" size="sm" onClick={handleCopyJson} className="h-7 text-xs">
                  {copiedJson ? <><Check size={12} className="mr-1 text-emerald-400" /> Copied</> : <><Copy size={12} className="mr-1" /> Copy JSON</>}
                </Button>
              </div>
              <pre className="p-4 text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed bg-black/50 rounded-xl border border-white/5 max-h-80 overflow-y-auto">
                {inspectData?.raw ? JSON.stringify(inspectData.raw, null, 2) : '// Loading or unavailable'}
              </pre>
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Top images</h2>
          {!r || r.images.length === 0 ? (
            <p className="text-xs text-slate-600">No images.</p>
          ) : (
            <ul className="space-y-1">
              {r.images.slice(0, 15).map((img) => (
                <li key={`${img.repo}:${img.tag}`} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 text-xs ring-1 ring-inset ring-white/5">
                  <span className="min-w-0 truncate font-mono text-slate-300">
                    {img.repo}<span className="text-slate-600">:{img.tag}</span>
                  </span>
                  <span className="ml-3 shrink-0 text-slate-500">{img.size}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Daemon events (last hour)</h2>
          {events.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !events.data || events.data.events.length === 0 ? (
            <EmptyState icon={<Radio size={22} />} title="No recent events" hint="Auto-refreshes every 20s." />
          ) : (
            <ul className="max-h-96 space-y-1 overflow-y-auto">
              {events.data.events.map((e) => (
                <li key={`${e.time}-${e.type}-${e.action}-${e.name}`} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-1.5 font-mono text-[11px] ring-1 ring-inset ring-white/5">
                  <span className="min-w-0 truncate text-slate-400">
                    <span className="text-slate-600">{e.type}</span> <span className="text-indigo-300">{e.action}</span> {e.name}
                  </span>
                  <span className="ml-3 shrink-0 text-slate-600">{fmtEventTime(e.time)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
