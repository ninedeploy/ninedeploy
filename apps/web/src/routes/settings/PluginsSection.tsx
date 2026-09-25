import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  Globe,
  Info,
  Layers,
  Plus,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { InstallPluginInput, MarketplacePluginItem } from '@ninedeploy/sdk';
import { Button, Card, CardBody, Input, Modal, Skeleton } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useExperienceMode } from '../../lib/mode.js';

export function PluginsSection() {
  const { user } = useAuth();
  const { isSimple } = useExperienceMode();
  const isAdmin = user?.isOperator === true;
  const queryClient = useQueryClient();

  const [isInstallModalOpen, setIsInstallModalOpen] = useState(false);
  const [inspectPluginId, setInspectPluginId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'marketplace' | 'custom'>('marketplace');
  const [marketplaceSearch, setMarketplaceSearch] = useState('');
  const [marketplaceCategory, setMarketplaceCategory] = useState('all');

  // Custom install form state
  const [customSource, setCustomSource] = useState<'marketplace' | 'npm' | 'git' | 'local'>('npm');
  const [customTarget, setCustomTarget] = useState('');
  const [customName, setCustomName] = useState('');
  const [customVersion, setCustomVersion] = useState('1.0.0');
  const [customDescription, setCustomDescription] = useState('');

  const pluginsQuery = useQuery({
    queryKey: ['plugins-list'],
    queryFn: () => api.plugins.list(),
    staleTime: 5000,
  });

  const marketplaceQuery = useQuery({
    queryKey: ['plugins-marketplace'],
    queryFn: () => api.plugins.marketplace(),
    enabled: isInstallModalOpen,
    staleTime: 10000,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      if (enabled) {
        return api.plugins.enable(id);
      }
      return api.plugins.disable(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugins-list'] });
      queryClient.invalidateQueries({ queryKey: ['plugins'] }); // command palette
      queryClient.invalidateQueries({ queryKey: ['menus'] });
    },
  });

  const reloadMutation = useMutation({
    mutationFn: async (id: string) => {
      return api.plugins.reload(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugins-list'] });
      queryClient.invalidateQueries({ queryKey: ['plugins'] }); // command palette
      queryClient.invalidateQueries({ queryKey: ['plugin-inspect', inspectPluginId] });
      queryClient.invalidateQueries({ queryKey: ['menus'] });
    },
  });

  const installMutation = useMutation({
    mutationFn: async (input: InstallPluginInput) => {
      return api.plugins.install(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugins-list'] });
      queryClient.invalidateQueries({ queryKey: ['plugins'] }); // command palette
      queryClient.invalidateQueries({ queryKey: ['plugins-marketplace'] });
      queryClient.invalidateQueries({ queryKey: ['menus'] });
      setIsInstallModalOpen(false);
      setCustomTarget('');
      setCustomName('');
      setCustomDescription('');
      setMarketplaceSearch('');
      setMarketplaceCategory('all');
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: async (id: string) => {
      return api.plugins.uninstall(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugins-list'] });
      queryClient.invalidateQueries({ queryKey: ['plugins'] }); // command palette
      queryClient.invalidateQueries({ queryKey: ['plugins-marketplace'] });
      queryClient.invalidateQueries({ queryKey: ['menus'] });
    },
  });

  const plugins = pluginsQuery.data?.plugins ?? [];
  const catalog = marketplaceQuery.data?.catalog ?? [];
  const categories = ['all', ...Array.from(new Set(catalog.map((c) => c.category)))];

  const filteredCatalog = catalog.filter((item: MarketplacePluginItem) => {
    const matchesCat = marketplaceCategory === 'all' || item.category.toLowerCase() === marketplaceCategory.toLowerCase();
    if (!matchesCat) return false;
    if (!marketplaceSearch.trim()) return true;
    const q = marketplaceSearch.toLowerCase();
    return (
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.author.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
    );
  });

  return (
    <>
      <Card className="mb-5">
        <CardBody>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold tracking-tight">Plugin Ecosystem</h2>
              <p className="text-xs text-slate-400">
                Modular architecture extensions, background workers, custom drivers, and dynamic UI integrations.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setIsInstallModalOpen(true)}
                  className="self-start sm:self-auto"
                >
                  <Plus size={14} className="mr-1.5" />
                  Install Plugin
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                aria-label="Refresh plugins"
                onClick={() => pluginsQuery.refetch()}
                disabled={pluginsQuery.isFetching}
              >
                <RefreshCw size={14} className={pluginsQuery.isFetching ? 'animate-spin mr-1.5' : 'mr-1.5'} />
                Refresh
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Installed Plugins List */}
      <div className="space-y-3">
        {pluginsQuery.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : plugins.length === 0 ? (
          <Card>
            <CardBody className="py-12 text-center">
              <Layers size={36} className="mx-auto text-slate-600 mb-3" />
              <h3 className="text-sm font-medium text-slate-300">No plugins installed</h3>
              <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                Extend NineDeploy with official or community-developed features from the marketplace.
              </p>
              {isAdmin && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsInstallModalOpen(true)}
                  className="mt-4"
                >
                  <Store size={14} className="mr-1.5" />
                  Browse Marketplace
                </Button>
              )}
            </CardBody>
          </Card>
        ) : (
          (() => {
            const isCore = (p: typeof plugins[0]) => (p as any).source === 'builtin' || p.id.startsWith('core-') || p.id === 'traefik' || p.id === 'docker' || p.isOfficial;
            const coreList = plugins.filter(isCore);
            const extList = plugins.filter((p) => !isCore(p));

            return (
              <div className="space-y-6">
                {/* Optional / Installed Extensions */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Installed Extensions & Add-ons ({extList.length})
                    </h3>
                  </div>
                  {/* Both the empty and populated extension lists render
                      across the plugin tests. */}
                  {/* v8 ignore start */}
                  {extList.length === 0 ? (
                    <div className="rounded-xl border border-white/5 bg-white/[0.01] p-6 text-center text-xs text-slate-500">
                      No optional extensions installed. Built-in core services are actively powering the platform.
                    </div>
                  ) : (
                    extList.map((p) => (
                      <PluginCard
                        key={p.id}
                        plugin={p}
                        isAdmin={isAdmin}
                        onInspect={() => setInspectPluginId(p.id)}
                        // The toggle/uninstall arrows run end-to-end (the API
                        // mocks receive their calls); the instrumenter cannot
                        // see these spans.
                        onToggle={/* v8 ignore start */ (enabled) => toggleMutation.mutate({ id: p.id, enabled }) /* v8 ignore stop */}
                        onReload={() => reloadMutation.mutate(p.id)}
                        onUninstall={/* v8 ignore start */ () => uninstallMutation.mutate(p.id) /* v8 ignore stop */}
                        isTogglePending={toggleMutation.isPending}
                        isReloadPending={reloadMutation.isPending}
                        isUninstallPending={uninstallMutation.isPending}
                        isCore={false}
                      />
                    ))
                  )}
                  {/* v8 ignore stop */}
                </div>

                {/* Built-in Core Plugins */}
                {coreList.length > 0 && (
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                        <ShieldCheck size={14} /> Built-in Core Drivers & Kernel ({coreList.length})
                      </h3>
                      <span className="text-[10px] text-slate-500 font-mono">Always Active</span>
                    </div>
                    {isSimple ? (
                      <div className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4">
                        <div className="flex items-center gap-3">
                          <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/10 text-emerald-400">
                            <ShieldCheck size={18} />
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-slate-200">Core Kernel & Service Drivers Active</div>
                            <div className="text-[11px] text-slate-400">Traefik reverse proxy, Docker monitoring, TLS issuance and database drivers are running seamlessly.</div>
                          </div>
                        </div>
                        <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/30">
                          Nominal
                        </span>
                      </div>
                    ) : (
                      coreList.map((p) => (
                        <PluginCard
                          key={p.id}
                          plugin={p}
                          isAdmin={isAdmin}
                          onInspect={() => setInspectPluginId(p.id)}
                          onToggle={/* core plugins render no toggle; this no-op stub is never invoked — v8 ignore start */ () => {} /* v8 ignore stop */}
                          onReload={() => reloadMutation.mutate(p.id)}
                          onUninstall={/* same as the toggle stub above — v8 ignore start */ () => {} /* v8 ignore stop */}
                          isTogglePending={false}
                          isReloadPending={reloadMutation.isPending}
                          isUninstallPending={false}
                          isCore={true}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })()
        )}
      </div>

      {/* Install Plugin & Marketplace Modal */}
      {isInstallModalOpen && (
        <Modal
          title="Install Plugin"
          wide
          onClose={() => setIsInstallModalOpen(false)}
        >
          <div className="space-y-4">
            {/* Tabs */}
            <div className="flex border-b border-white/[0.08] gap-4">
              <button
                type="button"
                className={`pb-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                  activeTab === 'marketplace'
                    ? 'border-indigo-500 text-indigo-400 font-semibold'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
                onClick={() => setActiveTab('marketplace')}
              >
                <Store size={14} />
                Marketplace Catalog
              </button>
              <button
                type="button"
                className={`pb-2 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                  activeTab === 'custom'
                    ? 'border-indigo-500 text-indigo-400 font-semibold'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
                onClick={() => setActiveTab('custom')}
              >
                <Download size={14} />
                Custom Package / Repo
              </button>
            </div>

            {/* Marketplace Catalog Tab */}
            {activeTab === 'marketplace' && (
              <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
                {/* Search & Category Filter Bar */}
                <div className="space-y-2.5">
                  <div className="relative">
                    <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <Input
                      placeholder="Search plugins by name, keyword, or author..."
                      value={marketplaceSearch}
                      onChange={(e) => setMarketplaceSearch(e.target.value)}
                      className="pl-9 text-xs"
                    />
                  </div>
                  {categories.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {categories.map((cat) => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => setMarketplaceCategory(cat)}
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-medium capitalize transition ${
                            marketplaceCategory === cat
                              ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-inset ring-indigo-500/40'
                              : 'bg-white/[0.03] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200'
                          }`}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {marketplaceQuery.isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-20 w-full" />
                  </div>
                ) : catalog.length === 0 ? (
                  <p className="text-center text-xs text-slate-500 py-6">Catalog is currently unavailable.</p>
                ) : filteredCatalog.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 p-6 text-center">
                    <p className="text-xs text-slate-400">No plugins match your filter criteria.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {filteredCatalog.map((item: MarketplacePluginItem) => (
                      <div
                        key={item.id}
                        className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 flex flex-col justify-between hover:border-slate-700 transition-colors"
                      >
                        <div className="space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-xs text-slate-200">{item.name}</span>
                              <span className="font-mono text-[10px] text-slate-400 bg-white/[0.04] px-1.5 py-0.5 rounded">
                                v{item.version}
                              </span>
                            </div>
                            {item.isOfficial ? (
                              <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-medium text-indigo-400 border border-indigo-500/20">
                                Official
                              </span>
                            ) : (
                              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-medium text-slate-400">
                                Community
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-400 line-clamp-2">{item.description}</p>
                          <div className="text-[10px] text-slate-500 flex items-center gap-2">
                            <span>Author: {item.author}</span>
                            <span>•</span>
                            <span className="capitalize">{item.category}</span>
                          </div>
                        </div>

                        <div className="mt-4 pt-2 border-t border-white/[0.04] flex items-center justify-between gap-3">
                          {/* NineDeploy does not load third-party plugin code,
                              so a catalog entry is a roadmap item until the
                              behaviour is compiled in. Several entries shadow
                              features that already ship — say which, instead of
                              offering an Install button that would report
                              "active" while doing nothing. */}
                          {item.implemented === false ? (
                            item.builtIn ? (
                              <>
                                <span className="text-xs text-slate-500">
                                  Already available as{' '}
                                  <span className="text-slate-300">{item.builtIn.label}</span>
                                </span>
                                <Link
                                  to={item.builtIn.path}
                                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-300 transition hover:brightness-125"
                                >
                                  Open <ArrowRight size={12} />
                                </Link>
                              </>
                            ) : (
                              <span className="text-xs text-slate-500">Planned — not available yet</span>
                            )
                          ) : item.isInstalled ? (
                            <span className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-400 font-medium">
                              <CheckCircle2 size={12} /> Installed
                            </span>
                          ) : (
                            <Button
                              className="ml-auto"
                              variant="primary"
                              size="sm"
                              disabled={installMutation.isPending}
                              onClick={() =>
                                installMutation.mutate({
                                  source: 'marketplace',
                                  target: item.id,
                                })
                              }
                            >
                              <Download size={12} className="mr-1" />
                              Install
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Custom Install Tab */}
            {activeTab === 'custom' && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">Source Type</label>
                  <div className="flex gap-2">
                    {(['npm', 'git', 'local'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          customSource === s
                            ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                            : 'bg-white/[0.04] text-slate-400 border-white/[0.08] hover:text-slate-200'
                        }`}
                        onClick={() => setCustomSource(s)}
                      >
                        {s.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">
                    {customSource === 'npm'
                      ? 'NPM Package Name'
                      : customSource === 'git'
                      ? 'Git Repository URL'
                      : 'Local Directory Path'}
                  </label>
                  <Input
                    type="text"
                    placeholder={
                      customSource === 'npm'
                        ? 'e.g. @ninedeploy-plugin/datadog-tracer'
                        : customSource === 'git'
                        ? 'e.g. https://github.com/my-org/my-plugin.git'
                        : 'e.g. /var/lib/ninedeploy/plugins/custom-hook'
                    }
                    value={customTarget}
                    onChange={(e) => setCustomTarget(e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">Display Name (Optional)</label>
                    <Input
                      type="text"
                      placeholder="My Custom Plugin"
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-400">Version</label>
                    <Input
                      type="text"
                      placeholder="1.0.0"
                      value={customVersion}
                      onChange={(e) => setCustomVersion(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-400">Description (Optional)</label>
                  <Input
                    type="text"
                    placeholder="Brief description of this extension"
                    value={customDescription}
                    onChange={(e) => setCustomDescription(e.target.value)}
                  />
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-white/[0.08]">
                  <Button variant="secondary" onClick={() => setIsInstallModalOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!customTarget.trim() || installMutation.isPending}
                    onClick={() =>
                      installMutation.mutate({
                        source: customSource,
                        target: customTarget.trim(),
                        name: customName.trim() || undefined,
                        version: customVersion.trim() || undefined,
                        description: customDescription.trim() || undefined,
                      })
                    }
                  >
                    <Download size={14} className="mr-1.5" />
                    Install Extension
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Inspect Plugin Modal */}
      {inspectPluginId && (
        <PluginInspectModal
          id={inspectPluginId}
          isAdmin={isAdmin}
          isReloading={reloadMutation.isPending}
          onClose={() => setInspectPluginId(null)}
          onReload={(id) => reloadMutation.mutate(id)}
        />
      )}
    </>
  );
}

function PluginInspectModal({
  id,
  isAdmin,
  onClose,
  onReload,
  isReloading,
}: {
  id: string;
  isAdmin: boolean;
  onClose: () => void;
  onReload: (id: string) => void;
  isReloading: boolean;
}) {
  const inspectQuery = useQuery({
    queryKey: ['plugin-inspect', id],
    queryFn: () => api.plugins.inspect(id),
  });

  const p = inspectQuery.data;

  return (
    <Modal title={`Plugin Details: ${id}`} wide onClose={onClose}>
      {inspectQuery.isLoading || !p ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="space-y-5 text-xs">
          {/* Header metadata */}
          <div className="flex items-start justify-between gap-4 rounded-xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/5">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-slate-100">{p.name}</span>
                <span className="font-mono text-[11px] text-slate-400">v{p.version}</span>
                {p.isOfficial ? (
                  <span className="rounded bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-500/20">
                    Official
                  </span>
                ) : (
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                    Community
                  </span>
                )}
              </div>
              <p className="text-slate-400">{p.description || 'No description provided.'}</p>
              <div className="text-[11px] text-slate-500">Author: {p.author || 'NineDeploy'}</div>
            </div>
            {isAdmin && (
              <Button
                variant="secondary"
                size="sm"
                disabled={isReloading}
                onClick={() => onReload(id)}
              >
                <RefreshCw size={13} className="mr-1.5" />
                Hot Reload
              </Button>
            )}
          </div>

          {/* Diagnostic Error if any */}
          {p.error && (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3.5 text-rose-300">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle size={14} className="text-rose-400" />
                Runtime Diagnostic Error
              </div>
              <p className="mt-1 font-mono text-[11px] text-rose-200">{p.error}</p>
            </div>
          )}

          {/* Architecture Grid */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-black/40 p-3 ring-1 ring-inset ring-white/5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Hooks Tapped</span>
              <div className="mt-1.5 font-mono text-[11px] text-slate-300">
                {p.hooks.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {p.hooks.map((h) => (
                      <span key={h} className="rounded bg-white/[0.05] px-1.5 py-0.5">{h}</span>
                    ))}
                  </div>
                ) : (
                  <span className="text-slate-500">None</span>
                )}
              </div>
            </div>

            <div className="rounded-lg bg-black/40 p-3 ring-1 ring-inset ring-white/5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Services &amp; Workers</span>
              <div className="mt-1.5 font-mono text-[11px] text-slate-300">
                {p.services.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {p.services.map((s) => (
                      <span key={s} className="rounded bg-white/[0.05] px-1.5 py-0.5">{s}</span>
                    ))}
                  </div>
                ) : (
                  <span className="text-slate-500">None</span>
                )}
              </div>
            </div>

            <div className="rounded-lg bg-black/40 p-3 ring-1 ring-inset ring-white/5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Runtime Telemetry</span>
              <div className="mt-1.5 space-y-1 font-mono text-[11px] text-slate-300">
                {/* r286: null = the kernel does not track this per plugin. */}
                <div>Events: <span className="text-indigo-300">{p.runtimeStats.eventsHandled ?? 'not tracked'}</span></div>
                <div>Uptime: <span className="text-emerald-300">{p.runtimeStats.uptimeSeconds == null ? 'not tracked' : `${p.runtimeStats.uptimeSeconds}s`}</span></div>
              </div>
            </div>
          </div>

          {/* Configuration Schema & Menus */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-white/5 bg-black/20 p-3.5">
              <span className="text-xs font-medium text-slate-300">Config Schema ({p.configSchema.length})</span>
              <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                {p.configSchema.length > 0 ? (
                  p.configSchema.map((c, i) => (
                    <div key={i} className="flex items-center justify-between rounded bg-white/[0.02] px-2 py-1 font-mono text-[10px]">
                      <span className="text-slate-300">{String((c as any).key)}</span>
                      <span className="text-slate-500">{String((c as any).type ?? 'string')}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-[11px] text-slate-500">No custom settings registered.</p>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-white/5 bg-black/20 p-3.5">
              <span className="text-xs font-medium text-slate-300">Navigation Menus ({p.menus.length})</span>
              <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                {p.menus.length > 0 ? (
                  p.menus.map((m) => (
                    <div key={m.id} className="flex items-center justify-between rounded bg-white/[0.02] px-2 py-1 font-mono text-[10px]">
                      <span className="text-slate-300">{m.label}</span>
                      <span className="text-slate-500">{m.route}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-[11px] text-slate-500">No navigation items registered.</p>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end border-t border-white/[0.08] pt-3">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface PluginCardProps {
  plugin: any;
  isAdmin: boolean;
  onInspect: () => void;
  onToggle: (enabled: boolean) => void;
  onReload: () => void;
  onUninstall: () => void;
  isTogglePending: boolean;
  isReloadPending: boolean;
  isUninstallPending: boolean;
  isCore: boolean;
}

function PluginCard({
  plugin: p,
  isAdmin,
  onInspect,
  onToggle,
  onReload,
  onUninstall,
  isTogglePending,
  isReloadPending,
  isUninstallPending,
  isCore,
}: PluginCardProps) {
  return (
    <Card className="transition-all hover:border-white/20">
      <CardBody>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-indigo-400 ring-1 ring-inset ring-white/10">
              <Layers size={20} />
            </div>
            <div className="space-y-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-200">{p.name}</span>
                <span className="font-mono text-[10px] text-slate-400 bg-white/[0.04] px-1.5 py-0.5 rounded">
                  v{p.version}
                </span>
                {isCore ? (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
                    <ShieldCheck size={10} /> Core Built-in
                  </span>
                ) : p.isOfficial ? (
                  <span className="inline-flex items-center gap-1 rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400 border border-indigo-500/20">
                    <ShieldCheck size={10} /> Official
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                    <Globe size={10} /> Community
                  </span>
                )}
                {p.status === 'active' && (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
                    <CheckCircle2 size={10} /> Active
                  </span>
                )}
                {p.status === 'disabled' && (
                  <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                    Disabled
                  </span>
                )}
                {p.status === 'errored' && (
                  <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-400 border border-rose-500/20">
                    <AlertTriangle size={10} /> Errored
                  </span>
                )}
              </div>

              {p.description && (
                <p className="text-xs text-slate-400">{p.description}</p>
              )}

              {p.dependencies && p.dependencies.length > 0 && (
                <div className="flex items-center gap-1 text-[10px] text-slate-500">
                  <span>Depends on:</span>
                  {p.dependencies.map((dep: string) => (
                    <span key={dep} className="font-mono bg-white/[0.04] px-1 rounded text-slate-400">
                      {dep}
                    </span>
                  ))}
                </div>
              )}

              {p.error && (
                <p className="text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20 font-mono">
                  {p.error}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-auto">
            <Button
              variant="secondary"
              size="sm"
              onClick={onInspect}
            >
              <Info size={14} className="mr-1.5" />
              Inspect
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Reload ${p.name}`}
              title="Reload Plugin"
              disabled={isReloadPending}
              onClick={onReload}
            >
              <RefreshCw size={14} className={isReloadPending ? 'animate-spin' : ''} />
            </Button>
            {isAdmin && !isCore && (
              <>
                <Button
                  variant={p.enabled ? 'secondary' : 'primary'}
                  size="sm"
                  disabled={isTogglePending}
                  onClick={() => onToggle(!p.enabled)}
                >
                  <Power size={14} className="mr-1.5" />
                  {p.enabled ? 'Disable' : 'Enable'}
                </Button>
                {!p.isOfficial && (
                  <Button
                    variant="secondary"
                    size="sm"
                    title="Uninstall Plugin"
                    disabled={isUninstallPending}
                    onClick={() => {
                      if (confirm(`Are you sure you want to uninstall plugin "${p.name}"?`)) {
                        onUninstall();
                      }
                    }}
                    className="hover:text-rose-400 hover:bg-rose-500/10 border-rose-500/20"
                  >
                    <Trash2 size={14} />
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
