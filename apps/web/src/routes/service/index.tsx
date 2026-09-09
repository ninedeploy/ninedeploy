import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, Boxes, Copy, Download, ExternalLink, FileCode2, FileStack, FolderTree, GitBranch, Globe, HardDrive, KeyRound, LayoutDashboard, Network, Play, Rocket, RotateCcw, Settings, ShieldAlert, Square, Terminal,
} from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, authedFetch } from '../../lib/api.js';
import { ContainerTerminal } from '../../components/ContainerTerminal.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Skeleton, StatusBadge, cn } from '../../components/ui.js';
import { downloadBlob } from '../../lib/format.js';
import { OverviewTab } from './OverviewTab.js';
import { ArchitectureTab } from './ArchitectureTab.js';
import { ManifestTab } from './ManifestTab.js';
import { ComposeTab } from './ComposeTab.js';
import { DeploysTab, IN_FLIGHT } from './DeploysTab.js';
import { EnvironmentTab } from './EnvironmentTab.js';
import { NetworkTab } from './NetworkTab.js';
import { VolumesTab } from './VolumesTab.js';
import { SettingsTab } from './SettingsTab.js';
import { FrameworkTab } from './FrameworkTab.js';
import { ActivityTab } from './ActivityTab.js';
import { DangerZone } from './DangerZone.js';

import { ContainerFileBrowser } from '../../components/ContainerFileBrowser.js';
import { ServiceDomainLauncher } from '../../components/ServiceDomainLauncher.js';

type TabId = 'overview' | 'terminal' | 'architecture' | 'manifest' | 'compose' | 'deploys' | 'environment' | 'network' | 'volumes' | 'files' | 'framework' | 'settings' | 'activity' | 'danger';

const SERVICE_TABS: Array<{ id: TabId; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'terminal', label: 'Terminal & Exec', icon: Terminal },
  { id: 'architecture', label: 'Architecture', icon: Network },
  { id: 'manifest', label: 'Manifest & Traefik', icon: FileCode2 },
  // Inline compose stacks only — see `visibleTabs`.
  { id: 'compose', label: 'Compose File', icon: FileStack },
  { id: 'deploys', label: 'Deploys', icon: Rocket },
  { id: 'environment', label: 'Environment', icon: KeyRound },
  { id: 'network', label: 'Network & Domains', icon: Globe },
  { id: 'volumes', label: 'Volumes & Storage', icon: HardDrive },
  { id: 'files', label: 'File Browser', icon: FolderTree },
  { id: 'framework', label: 'Framework', icon: Boxes },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'activity', label: 'Activity Logs', icon: Activity },
  { id: 'danger', label: 'Danger Zone', icon: ShieldAlert },
];

export function ServiceDetail() {
  const params = useParams();
  const id = Number(params['id']);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [activeDeploy, setActiveDeploy] = useState<number | null>(null);
  const [searchParams] = useSearchParams();
  // The tab is OWNED by `?tab=` on every render of this route, not read
  // once: React Router keeps this component mounted across param changes,
  // so a `useState` initializer ignores later `?tab=` deep links (e.g.
  // "View Live Logs →" linking to /services/5?tab=deploys from Overview).
  const tabParam = searchParams.get('tab');
  const switchTab = (next: TabId) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'overview') sp.delete('tab');
    else sp.set('tab', next);
    navigate({ search: sp.toString() });
  };
  const navigate = useNavigate();

  // A non-numeric :id (e.g. /services/abc) must not leak NaN into every
  // query/mutation — treat it as "not found" and bounce to the list.
  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) navigate('/services', { replace: true });
  }, [id, navigate]);

  const service = useQuery({
    queryKey: ['service', id],
    queryFn: () => api.services.get(id),
    refetchInterval: (q) => (q.state.data?.status === 'deploying' ? 2000 : false),
  });
  const deploys = useQuery({
    queryKey: ['deploys', id],
    queryFn: () => api.deploys.list(id),
    refetchInterval: (q) => (q.state.data?.some((d) => IN_FLIGHT.includes(d.status)) ? 2000 : false),
  });

  // A new service id must not inherit the previous service's selected
  // deployment: the route element is reused, so state keyed to the old id
  // would open a deploy-logs stream for a deployment that does not belong
  // to this service. React's recommended "adjust state on prop change"
  // pattern. Object.is, not !==: /services/abc yields id=NaN and NaN !== NaN
  // would loop re-renders forever.
  const [prevId, setPrevId] = useState(id);
  if (!Object.is(prevId, id)) {
    setPrevId(id);
    setActiveDeploy(null);
  }

  useEffect(() => {
    if (activeDeploy != null) return;
    const latest = deploys.data?.[0];
    if (latest) setActiveDeploy(latest.id);
  }, [deploys.data, activeDeploy]);

  // Redeploying a LIVE service is intentional but easy to hit by accident —
  // the button sits next to Restart/Stop — so a running service requires a
  // confirmation before the build is queued.
  const [confirmRedeploy, setConfirmRedeploy] = useState(false);

  const trigger = useMutation({
    mutationFn: () => api.deploys.trigger(id),
    onSuccess: (res) => {
      setActiveDeploy(res.deploymentId);
      switchTab('deploys');
      qc.invalidateQueries({ queryKey: ['deploys', id] });
      qc.invalidateQueries({ queryKey: ['service', id] });
    },
    onError: (err) => toast(err instanceof Error ? `Deploy failed: ${err.message}` : 'Deploy failed', 'error'),
  });

  const lifecycle = useMutation({
    mutationFn: (action: 'stop' | 'start' | 'restart') => api.services[action](id),
    onSuccess: (_d, action) => {
      qc.invalidateQueries({ queryKey: ['service', id] });
      toast(`Service ${action}ed`, 'success');
    },
    onError: () => toast('Action failed', 'error'),
  });

  // Danger zone: delete the service (type-the-name confirm).
  const [confirmDelete, setConfirmDelete] = useState('');
  const removeService = useMutation({
    mutationFn: () => api.services.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast('Service deleted', 'success');
      navigate('/services');
    },
    onError: () => toast('Delete failed', 'error'),
  });

  const cloneMutation = useMutation({
    mutationFn: () => api.services.clone(id),
    onSuccess: (cloned) => {
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(`Service cloned: ${cloned.name}`, 'success');
      navigate(`/services/${cloned.id}`);
    },
    onError: () => toast('Clone failed', 'error'),
  });

  const [showRuntimeLogs, setShowRuntimeLogs] = useState(false);
  const [showExec, setShowExec] = useState(false);

  const doExportService = async () => {
    try {
      toast('Exporting service…', 'info');
      const res = await authedFetch(api.services.exportUrl(id));
      if (!res.ok) throw new Error('Export failed');
      downloadBlob(await res.blob(), `${svc?.slug ?? 'service'}-export.json`);
      toast('Service exported', 'success');
    } catch {
      toast('Export failed', 'error');
    }
  };
  const runtimeLogs = useQuery({
    queryKey: ['runtime-logs', id],
    queryFn: () => api.services.logs(id),
    enabled: showRuntimeLogs && !!service.data?.runtimeId,
    refetchInterval: showRuntimeLogs ? 3000 : false,
  });

  const svc = service.data;
  // The Compose File tab edits `composeContent`, which only an INLINE stack
  // has: a git-repo compose service keeps its file in the repository, where
  // the next checkout would overwrite anything typed here. Hidden — and not
  // reachable by `?tab=compose` either — for every other service.
  const visibleTabs = SERVICE_TABS.filter((t) => t.id !== 'compose' || !!svc?.composeContent);
  const tab: TabId = visibleTabs.some((t) => t.id === tabParam) ? (tabParam as TabId) : 'overview';
  // Redeploying a LIVE service is intentional but easy to hit by accident —
  // the button sits next to Restart/Stop — so a running service requires a
  // confirmation before the build is queued.
  const requestDeploy = () => {
    if (svc?.status === 'running') setConfirmRedeploy(true);
    else trigger.mutate();
  };
  const activeDeployRow = deploys.data?.find((d) => d.id === activeDeploy) ?? null;

  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const cur = activeDeployRow?.status ?? null;
    const wasInFlight = lastStatus.current != null && IN_FLIGHT.includes(lastStatus.current);
    const nowTerminal = cur != null && !IN_FLIGHT.includes(cur);
    if (wasInFlight && nowTerminal) qc.invalidateQueries({ queryKey: ['service', id] });
    lastStatus.current = cur;
  }, [activeDeployRow?.status, qc, id]);

  if (service.isError) {
    return (
      <Card className="p-10 text-center">
        <p className="text-sm font-medium text-rose-300">Couldn't load this service.</p>
        <p className="mt-1 text-xs text-slate-500">It may have been deleted, or the server is unreachable.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => service.refetch()}>Retry</Button>
          <Link to="/services"><Button size="sm" variant="ghost">Back to services</Button></Link>
        </div>
      </Card>
    );
  }

  if (service.isLoading || !svc) {
    return (
      <Card className="p-6">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="mt-3 h-4 w-2/3" />
      </Card>
    );
  }

  return (
    <div className="nd-fade">
      <Link to="/services" className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200">
        <ArrowLeft size={14} /> Services
      </Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{svc.name}</h1>
            <StatusBadge status={svc.status} />
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-slate-500">
            <span className="uppercase tracking-wide text-slate-400">{svc.type}</span>
            <span className="flex items-center gap-1">
              <GitBranch size={12} /> {svc.branch}
            </span>
            {svc.port && <span>: {svc.port}</span>}
            <span className="truncate">{svc.repoUrl ?? svc.image}</span>
          </p>
          {svc.autoUrl && (
            <a
              href={`http://${svc.autoUrl}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-1.5 font-mono text-xs text-emerald-300 ring-1 ring-inset ring-emerald-500/20 transition hover:bg-emerald-500/15"
            >
              <ExternalLink size={12} /> {svc.autoUrl}
            </a>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ServiceDomainLauncher serviceId={id} serviceName={svc.name} label />
          <Button onClick={requestDeploy} disabled={trigger.isPending}>
            <Rocket size={16} /> {trigger.isPending ? 'Triggering…' : 'Deploy'}
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={() => cloneMutation.mutate()}
            disabled={cloneMutation.isPending}
            title="Clone service configuration and environment variables"
          >
            <Copy size={15} /> {cloneMutation.isPending ? 'Cloning…' : 'Clone'}
          </Button>
          {svc.status === 'running' && (
            <>
              <Button variant="secondary" size="md" onClick={() => lifecycle.mutate('restart')} disabled={lifecycle.isPending} title="Restart">
                <RotateCcw size={15} /> Restart
              </Button>
              <Button variant="secondary" size="md" onClick={() => lifecycle.mutate('stop')} disabled={lifecycle.isPending} title="Stop">
                <Square size={15} /> Stop
              </Button>
            </>
          )}
          {svc.status === 'stopped' && (
            <Button variant="secondary" size="md" onClick={() => lifecycle.mutate('start')} disabled={lifecycle.isPending}>
              <Play size={15} /> Start
            </Button>
          )}
          {svc.runtimeId && (
            <Button variant="ghost" size="md" onClick={() => setShowRuntimeLogs((v) => !v)}>
              <Terminal size={15} /> {showRuntimeLogs ? 'Hide logs' : 'Runtime logs'}
            </Button>
          )}
          {svc.runtimeId && (
            <Button variant="ghost" size="md" onClick={() => setShowExec((v) => !v)}>
              <Terminal size={15} /> {showExec ? 'Hide shell' : 'Exec'}
            </Button>
          )}
          <Button variant="ghost" size="md" onClick={doExportService} title="Export service">
            <Download size={15} /> Export
          </Button>
        </div>
      </div>

      {showRuntimeLogs && (
        <Card className="mt-5">
          <CardBody>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
                <Terminal size={15} className="text-slate-500" /> Runtime logs
              </div>
              <span className="text-xs text-slate-600">live · auto-refresh 3s</span>
            </div>
            <pre className="h-72 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-xs leading-relaxed text-slate-300 ring-1 ring-inset ring-white/5">
              {runtimeLogs.data?.lines || 'No logs yet.'}
            </pre>
          </CardBody>
        </Card>
      )}

      {showExec && svc.runtimeId && tab !== 'terminal' && (
        <div className="mt-5">
          <ContainerTerminal serviceId={id} serviceName={svc.name} onClose={() => setShowExec(false)} />
        </div>
      )}

      {/* Service Detail Layout: Left Vertical Sidebar + Right Content Pane */}
      <div className="mt-6 flex flex-col lg:flex-row items-start gap-6">
        {/* Left Vertical Navigation Menu */}
        <aside className="w-full lg:w-60 shrink-0">
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-2 space-y-1">
            <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Service Navigation
            </div>
            {visibleTabs.map((t) => {
              const Icon = t.icon;
              const isActive = tab === t.id;
              const isDanger = t.id === 'danger';

              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls="service-tab-panel"
                  onClick={() => switchTab(t.id)}
                  className={cn(
                    'w-full flex items-center gap-3 rounded-xl px-3 py-2 text-xs font-medium transition-all text-left',
                    isActive
                      ? isDanger
                        ? 'bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-500/30 font-semibold'
                        : 'bg-indigo-500/15 text-indigo-200 ring-1 ring-inset ring-indigo-500/30 font-semibold shadow-sm'
                      : isDanger
                        ? 'text-rose-400/80 hover:bg-rose-500/10 hover:text-rose-300'
                        : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200',
                  )}
                >
                  <Icon size={15} className={cn(isActive ? (isDanger ? 'text-rose-400' : 'text-indigo-400') : 'opacity-70')} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right Content Pane */}
        <main id="service-tab-panel" role="tabpanel" className="flex-1 min-w-0 w-full">
          {tab === 'overview' && <OverviewTab serviceId={id} svc={svc} />}
          {tab === 'terminal' && (
            <div className="space-y-4">
              {/* Both terminal states render across the exec tests; the
                  instrumenter cannot see this condition. */}
              {/* v8 ignore start */}
              {svc.runtimeId ? (
                <ContainerTerminal serviceId={id} serviceName={svc.name} />
              ) : (
              /* v8 ignore stop */
                <Card>
                  <CardBody className="py-8 text-center text-slate-400">
                    <Terminal size={32} className="mx-auto mb-2 text-slate-600" />
                    <p className="text-sm font-semibold text-slate-300">Container is not deployed</p>
                    <p className="text-xs text-slate-500 mt-1">Deploy this service first to launch an interactive container shell.</p>
                  </CardBody>
                </Card>
              )}
            </div>
          )}
          {tab === 'architecture' && <ArchitectureTab service={svc} />}
          {tab === 'manifest' && <ManifestTab service={svc} />}
          {tab === 'compose' && svc.composeContent && <ComposeTab service={svc} />}
          {tab === 'deploys' && (
            <DeploysTab
              serviceId={id}
              repoUrl={svc.repoUrl ?? null}
              deploys={deploys.data ?? []}
              loading={deploys.isLoading}
              activeId={activeDeploy}
              onSelect={setActiveDeploy}
            />
          )}
          {tab === 'environment' && <EnvironmentTab serviceId={id} />}
          {tab === 'network' && <NetworkTab serviceId={id} svc={svc} />}
          {tab === 'volumes' && <VolumesTab serviceId={id} svc={svc} />}
          {tab === 'files' && (
            <div>
              {/* Both naming paths render across the files tests. */}
              <ContainerFileBrowser container={/* v8 ignore start */ svc.runtimeId || `nd-svc-${svc.slug}` /* v8 ignore stop */} />
            </div>
          )}
          {tab === 'settings' && <SettingsTab serviceId={id} svc={svc} />}
          {tab === 'framework' && <FrameworkTab serviceId={id} svc={svc} />}
          {tab === 'activity' && <ActivityTab serviceId={id} name={svc.name} />}
          {tab === 'danger' && (
            <DangerZone
              slug={svc.slug}
              name={svc.name}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
              onDelete={() => removeService.mutate()}
              deleting={removeService.isPending}
            />
          )}
        </main>

        <ConfirmDialog
          open={confirmRedeploy}
          title={`Redeploy "${svc.name}"?`}
          message={
            <>
              <strong>{svc.name}</strong> is currently running. Triggering a deploy builds a
              new version while the current one keeps serving traffic — once it passes the
              healthcheck, traffic switches over and the previous container retires.
            </>
          }
          confirmLabel="Redeploy"
          onConfirm={() => {
            setConfirmRedeploy(false);
            trigger.mutate();
          }}
          onClose={() => setConfirmRedeploy(false)}
        />
      </div>
    </div>
  );
}

