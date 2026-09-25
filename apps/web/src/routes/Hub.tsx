import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import {
  CheckCircle2, Download, ExternalLink,
  Layers, Package, RefreshCw, Rocket, Search, ShieldCheck, Sparkles, Store, X,
} from 'lucide-react';
import type { Template } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Card, EmptyState, ErrorCard, Input, PageHeader, Skeleton, cn, useEscapeToClose } from '../components/ui.js';
import { DeployWizard } from '../components/DeployWizard.js';

export function Hub() {
  const [activeTab, setActiveTab] = useState<'templates' | 'marketplace'>('templates');
  const list = useQuery({ queryKey: ['templates'], queryFn: () => api.templates.list() });
  const marketplace = useQuery({
    queryKey: ['plugins-marketplace'],
    queryFn: () => api.plugins.marketplace(),
    enabled: activeTab === 'marketplace',
  });

  // Surface when the registry comes from a custom source (Settings → Hub).
  const settings = useQuery({ queryKey: ['instance-settings'], queryFn: () => api.settings.get(), staleTime: 60_000 });
  const customSource = settings.data?.templatesSource ?? null;

  const [category, setCategory] = useState('All');
  const [verification, setVerification] = useState<'all' | 'verified' | 'community'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [wizardTpl, setWizardTpl] = useState<Template | null>(null);

  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.isOperator === true;

  const [installingId, setInstallingId] = useState<string | null>(null);

  const installMutation = useMutation({
    mutationFn: async (target: string) => {
      setInstallingId(target);
      return api.plugins.install({
        source: 'marketplace',
        target,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      queryClient.invalidateQueries({ queryKey: ['plugins-marketplace'] });
      queryClient.invalidateQueries({ queryKey: ['menus'] });
      setInstallingId(null);
    },
    onError: () => {
      setInstallingId(null);
    },
  });

  const categories = useMemo(() => {
    const set = new Set<string>(['All']);
    (list.data ?? []).forEach((t) => {
      set.add(t.category);
    });
    return Array.from(set);
  }, [list.data]);

  const filteredTemplates = (list.data ?? []).filter(
    (t) =>
      (category === 'All' || t.category === category) &&
      (verification === 'all' || (verification === 'verified' ? t.runtimeVerified === true : t.runtimeVerified !== true)) &&
      ((t.name ?? '').toLowerCase().includes(query.toLowerCase()) || (t.tagline ?? '').toLowerCase().includes(query.toLowerCase())),
  );
  const verifiedCount = (list.data ?? []).filter((t) => t.runtimeVerified === true).length;
  const communityCount = (list.data ?? []).length - verifiedCount;

  const filteredMarketplace = (marketplace.data?.catalog ?? []).filter(
    (m) =>
      (m.name ?? '').toLowerCase().includes(query.toLowerCase()) ||
      (m.description ?? '').toLowerCase().includes(query.toLowerCase()) ||
      (m.category ?? '').toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div>
      <PageHeader
        icon={<Sparkles size={18} />}
        title="Hub"
        subtitle="Curated one-click apps with transparent runtime certification."
        actions={
          customSource ? (
            <span
              className="rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-[10px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-500/20"
              title={`Custom registry: ${customSource}`}
            >
              custom registry
            </span>
          ) : undefined
        }
      />

      {/* Main Tab Switcher */}
      <div className="mb-6 flex border-b border-white/[0.08]">
        <button
          type="button"
          onClick={() => {
            setActiveTab('templates');
            setQuery('');
          }}
          className={cn(
            'flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition',
            activeTab === 'templates'
              ? 'border-indigo-400 text-indigo-300'
              : 'border-transparent text-slate-400 hover:text-slate-200',
          )}
        >
          <Rocket size={15} />
          <span>App Templates</span>
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-400">
            {list.data?.length ?? 0}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('marketplace');
            setQuery('');
          }}
          className={cn(
            'flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition',
            activeTab === 'marketplace'
              ? 'border-indigo-400 text-indigo-300'
              : 'border-transparent text-slate-400 hover:text-slate-200',
          )}
        >
          <Store size={15} />
          <span>Extension Marketplace</span>
          {marketplace.data?.catalog && (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-400">
              {marketplace.data.catalog.length}
            </span>
          )}
        </button>
      </div>

      {/* Search & Filter Controls */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-xs flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={activeTab === 'templates' ? 'Search templates…' : 'Search extensions…'}
            className="h-9 pl-8"
          />
        </div>
        {activeTab === 'templates' && (
          <div className="flex flex-wrap items-center gap-1.5">
            {([
              ['all', `All ${list.data?.length ?? 0}`],
              ['verified', `Verified ${verifiedCount}`],
              ['community', `Community ${communityCount}`],
            ] as const).map(([value, label]) => (
              <button
                type="button"
                key={value}
                onClick={() => setVerification(value)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition',
                  verification === value
                    ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-inset ring-emerald-500/30'
                    : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]',
                )}
              >
                {label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-white/10" />
            {categories.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setCategory(c)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition',
                  category === c ? 'bg-indigo-500 text-white' : 'bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content Rendering: Templates Tab */}
      {activeTab === 'templates' &&
        (list.isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="p-5">
                <Skeleton className="h-16 w-full" />
              </Card>
            ))}
          </div>
        ) : list.isError ? (
          <ErrorCard title="Couldn't load templates" error={list.error} onRetry={() => list.refetch()} />
        ) : filteredTemplates.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Search size={26} />}
              title="No templates match"
              hint={
                query
                  ? `Nothing matches "${query}" in ${category === 'All' ? 'any category' : category}.`
                  : `No templates in ${category}.`
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredTemplates.map((t) => (
              <Card
                key={t.id}
                interactive
                role="button"
                tabIndex={0}
                onClick={() => setSelected(t.id)}
                // r292: role="button" promises keyboard activation too.
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelected(t.id);
                  }
                }}
                className="group p-5"
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/[0.05] text-slate-400 ring-1 ring-inset ring-white/10">
                    <Package size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100">{t.name}</span>
                      {t.runtimeVerified ? (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                          <ShieldCheck size={9} /> verified
                        </span>
                      ) : (
                        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase text-amber-300 ring-1 ring-inset ring-amber-500/20">
                          community
                        </span>
                      )}
                      {t.featured && (
                        <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase text-indigo-300">
                          featured
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{t.tagline}</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="rounded-md bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-400">
                    {t.category}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-indigo-300 opacity-0 transition group-hover:opacity-100">
                    <Rocket size={12} /> Deploy
                  </span>
                </div>
              </Card>
            ))}
          </div>
        ))}

      {/* Content Rendering: Marketplace Tab */}
      {activeTab === 'marketplace' &&
        (marketplace.isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-5">
                <Skeleton className="h-20 w-full" />
              </Card>
            ))}
          </div>
        ) : marketplace.isError ? (
          <ErrorCard title="Couldn't load marketplace" error={marketplace.error} onRetry={() => marketplace.refetch()} />
        ) : filteredMarketplace.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Store size={26} />}
              title="No extensions match"
              hint={query ? `Nothing matches "${query}" in extensions.` : 'No extensions found.'}
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredMarketplace.map((m) => (
              <Card key={m.id} className="flex flex-col justify-between p-5">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 ring-1 ring-inset ring-indigo-500/20">
                        <Layers size={18} />
                      </div>
                      <div>
                        <h3 className="font-semibold text-slate-100">{m.name}</h3>
                        <span className="text-[11px] text-slate-500">v{m.version} · {m.author}</span>
                      </div>
                    </div>
                    {m.isOfficial ? (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                        <ShieldCheck size={10} /> Official
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 ring-1 ring-inset ring-white/10">
                        Community
                      </span>
                    )}
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-slate-400">{m.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1">
                    <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-400">{m.category}</span>
                    {m.configSchema && m.configSchema.length > 0 && (
                      <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-400">
                        {m.configSchema.length} settings
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-end border-t border-white/[0.06] pt-3">
                  {m.isInstalled ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                      <CheckCircle2 size={13} /> Installed
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={!isAdmin || installMutation.isPending}
                      onClick={() => installMutation.mutate(m.id)}
                    >
                      {installingId === m.id ? (
                        <>
                          <RefreshCw size={12} className="animate-spin" /> Installing…
                        </>
                      ) : (
                        <>
                          <Download size={12} /> Install
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ))}

      {selected && (
        <TemplateDetail
          id={selected}
          onClose={() => setSelected(null)}
          onDeploy={(t) => {
            setSelected(null);
            setWizardTpl(t);
          }}
        />
      )}
      {wizardTpl && <DeployWizard template={wizardTpl} onClose={() => setWizardTpl(null)} />}
    </div>
  );
}

export function generateComposeYaml(t: Template): string {
  const serviceName = t.id.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  const lines = [
    'services:',
    `  ${serviceName}:`,
    `    image: ${t.image}`,
    '    restart: unless-stopped',
  ];
  if (t.port) {
    lines.push('    ports:');
    lines.push(`      - "${t.port}:${t.port}"`);
  }
  if (t.volumeMount) {
    lines.push('    volumes:');
    lines.push(`      - ${serviceName}_data:${t.volumeMount}`);
  }
  if (t.env && t.env.length > 0) {
    lines.push('    environment:');
    for (const e of t.env) {
      lines.push(`      - ${e.key}=${e.secret ? 'CHANGE_ME' : e.value}`);
    }
  }
  if (t.volumeMount) {
    lines.push('volumes:', `  ${serviceName}_data:`);
  }
  return lines.join('\n');
}

function TemplateDetail({
  id,
  onClose,
  onDeploy,
}: {
  id: string;
  onClose: () => void;
  onDeploy: (t: Template) => void;
}) {
  const detail = useQuery({ queryKey: ['template', id], queryFn: () => api.templates.get(id) });
  const [subTab, setSubTab] = useState<'overview' | 'compose'>('overview');
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  useEscapeToClose(onClose);

  const copyCompose = (yaml: string) => {
    navigator.clipboard?.writeText(yaml);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <button
        type="button"
        aria-label="Close template details"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={detail.data ? titleId : undefined}
        aria-label={detail.data ? undefined : 'Template details'}
        className="nd-fade relative w-full max-w-lg overflow-hidden rounded-t-2xl border border-white/10 bg-slate-950 shadow-2xl sm:rounded-2xl"
      >
        {detail.isLoading || !detail.data ? (
          <div className="p-6">
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-white/5 p-5">
              <div className="flex items-start gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-xl bg-white/[0.05] text-slate-400 ring-1 ring-inset ring-white/10">
                  <Package size={22} />
                </span>
                <div>
                  <h2 id={titleId} className="text-lg font-semibold">{detail.data.name}</h2>
                  <p className="text-xs text-slate-400">{detail.data.tagline}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-300"
              >
                <X size={16} />
              </button>
            </div>

            {/* Modal Subtabs */}
            <div className="flex border-b border-white/5 px-5 pt-2">
              <button
                type="button"
                onClick={() => setSubTab('overview')}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-xs font-medium transition',
                  subTab === 'overview'
                    ? 'border-indigo-400 text-indigo-300'
                    : 'border-transparent text-slate-400 hover:text-slate-200',
                )}
              >
                Overview
              </button>
              <button
                type="button"
                onClick={() => setSubTab('compose')}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-3 pb-2.5 text-xs font-medium transition',
                  subTab === 'compose'
                    ? 'border-indigo-400 text-indigo-300'
                    : 'border-transparent text-slate-400 hover:text-slate-200',
                )}
              >
                Compose YAML
              </button>
            </div>

            <div className="max-h-[50vh] space-y-4 overflow-auto p-5">
              {!detail.data.runtimeVerified && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.08] p-3 text-xs leading-relaxed text-amber-200">
                  Community template: its manifest is validated and curated, but this exact image has not yet passed NineDeploy's isolated runtime smoke test. Review the image, environment and requirements before deploying.
                </div>
              )}
              {subTab === 'overview' ? (
                <>
                  <p className="text-sm leading-relaxed text-slate-300">{detail.data.description}</p>

                  {detail.data.requires && (
                    <p className="rounded-lg bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200 ring-1 ring-inset ring-amber-500/20">
                      {detail.data.requires}
                    </p>
                  )}

                  <div className="grid grid-cols-3 gap-3 text-center">
                    <Spec label="Image" value={detail.data.image.split('/').pop()!} />
                    <Spec label="Port" value={`:${detail.data.port}`} />
                    <Spec label="Persist" value={detail.data.volumeMount ? 'Volume' : 'Ephemeral'} />
                  </div>

                  {detail.data.env && detail.data.env.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">Environment</p>
                      <div className="space-y-1">
                        {detail.data.env.map((e) => (
                          <div
                            key={e.key}
                            className="flex items-center justify-between rounded-md bg-black/30 px-2.5 py-1.5 font-mono text-xs"
                          >
                            <span className="text-slate-300">{e.key}</span>
                            <span className={cn(e.secret ? 'text-amber-400/80' : 'text-slate-500')}>
                              {e.secret ? '••• secret' : e.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {detail.data.website && (
                    <a
                      href={detail.data.website}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                    >
                      <ExternalLink size={12} /> {detail.data.website.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                </>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-400">docker-compose.yml preview</span>
                    <button
                      type="button"
                      onClick={() => copyCompose(generateComposeYaml(detail.data))}
                      className="flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
                    >
                      {copied ? 'Copied!' : 'Copy YAML'}
                    </button>
                  </div>
                  <pre className="overflow-x-auto rounded-lg bg-black/50 p-3 font-mono text-xs text-slate-300 ring-1 ring-inset ring-white/5">
                    <code>{generateComposeYaml(detail.data)}</code>
                  </pre>
                </div>
              )}
            </div>

            <div className="border-t border-white/5 p-4">
              <Button
                className="w-full"
                onClick={() => detail.data && onDeploy(detail.data)}
                disabled={!detail.data}
              >
                <Rocket size={16} /> Configure &amp; deploy
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-2 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 truncate font-mono text-xs text-slate-200">{value}</div>
    </div>
  );
}
