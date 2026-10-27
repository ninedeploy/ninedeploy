import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Boxes, Container, FileArchive, FileCode, GitBranch, GitPullRequest, Globe, Layers, type LucideIcon, Plus, Search, Sparkles, Terminal,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import type { Template } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { type DeployKind, useOpenDeploy } from '../lib/deployLauncher.js';
import { DatabaseWizard, type DatabaseEngineId, ENGINES } from '../components/DatabaseWizard.js';
import { DeployWizard } from '../components/DeployWizard.js';
import { UploadSourceModal } from '../components/UploadSource.js';
import { useToast } from '../components/Toast.js';
import { Card, PageHeader, cn } from '../components/ui.js';
import { fill, msg, useT } from '../lib/i18n.js';

type Category = 'all' | 'apps' | 'databases' | 'services';

interface AppSource {
  /** `upload` (0.16.1) opens the archive upload, not the Deploy Wizard. */
  kind: DeployKind | 'upload';
  title: string;
  hint: string;
  icon: LucideIcon;
  keywords: string;
  operatorOnly?: boolean;
}

/** The ways to bring an application in — Coolify's "Applications" column. */
const APP_SOURCES: AppSource[] = [
  { kind: 'git', title: msg('Git repository'), hint: msg('A public URL, or a private repo with a saved token or deploy key'), icon: GitBranch, keywords: 'github gitlab gitea bitbucket public private repo nixpacks railpack buildpacks paketo heroku node python go php ruby' },
  { kind: 'github-app', title: msg('GitHub App'), hint: msg('Private repos, push-to-deploy, PR previews and commit statuses'), icon: GitPullRequest, keywords: 'github app installation webhook preview pull request', operatorOnly: true },
  { kind: 'image', title: msg('Docker image'), hint: msg('Run any image from Docker Hub, GHCR or a private registry'), icon: Container, keywords: 'docker image registry ghcr dockerhub container prebuilt' },
  { kind: 'dockerfile', title: msg('Dockerfile'), hint: msg('Build the Dockerfile in your repository'), icon: FileCode, keywords: 'dockerfile docker build repo' },
  { kind: 'upload', title: msg('Upload source'), hint: msg('No Git repo? Upload a .zip or .tar.gz of your project folder'), icon: FileArchive, keywords: 'upload zip tar archive folder local drop no git' },
  { kind: 'static', title: msg('Static site'), hint: msg('Vite, Astro, Hugo, Next export… built, then served by nginx'), icon: Globe, keywords: 'static spa html vite astro hugo jekyll gatsby nginx' },
  { kind: 'compose', title: msg('Docker Compose'), hint: msg('Paste a multi-container stack; magic variables generate secrets'), icon: Layers, keywords: 'compose docker-compose yaml stack multi container', operatorOnly: true },
  { kind: 'pm2', title: msg('PM2 process'), hint: msg('Run a Node.js app directly on the host, without a container'), icon: Terminal, keywords: 'pm2 node host process bare metal', operatorOnly: true },
];

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'all', label: msg('All') },
  { id: 'apps', label: msg('Applications') },
  { id: 'databases', label: msg('Databases') },
  { id: 'services', label: msg('One-click apps') },
];

const matches = (q: string, ...fields: (string | undefined)[]) => {
  if (!q) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
};

/**
 * 0.16.1 `/new`: one place to start anything — Coolify's New Resource page.
 * Every "New" button in the shell leads here. Applications open the Deploy
 * Wizard pre-set for their source, databases open the Database Wizard on
 * their engine, and one-click apps open the wizard with the template.
 */
export function NewResource() {
  const t = useT();
  const { user } = useAuth();
  const isOperator = user?.isOperator === true;
  const navigate = useNavigate();
  const openDeploy = useOpenDeploy();
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [dbEngine, setDbEngine] = useState<DatabaseEngineId | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [uploading, setUploading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.templates.list() });
  // Operators see whether a GitHub App is connected yet; the card then
  // either deploys from it or leads to its one-click setup.
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.sources.list(), enabled: isOperator });
  const hasGithubApp = (sources.data ?? []).some((s) => s.type === 'github_app');

  const openTemplate = useMutation({
    mutationFn: (id: string) => api.templates.get(id),
    onSuccess: (item) => setTemplate(item),
    onError: (err: Error) => toast(t('Could not load the template: {error}', { error: err.message }), 'error'),
  });

  // `/` focuses the search, as on Coolify — unless the user is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const q = query.trim().toLowerCase();
  const apps = APP_SOURCES.filter((a) => (!a.operatorOnly || isOperator) && matches(q, a.title, a.hint, a.keywords));
  const dbs = ENGINES.filter((e) => matches(q, e.label, e.hint, e.id, 'database db'));
  const allTemplates = templates.data ?? [];
  const tpl = useMemo(() => {
    const list = (templates.data ?? []).filter((item) => matches(q, item.name, item.tagline, item.category, item.id));
    // Featured first, then verified — the catalog's own idea of a good start.
    const rank = (item: (typeof list)[number]) => (item.featured ? 0 : item.runtimeVerified ? 1 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [templates.data, q]);
  const tplShown = q ? tpl.slice(0, 48) : tpl.slice(0, 12);

  const show = (c: Exclude<Category, 'all'>) => category === 'all' || category === c;
  const nothing = (!show('apps') || apps.length === 0) && (!show('databases') || dbs.length === 0) && (!show('services') || tpl.length === 0);

  return (
    <div className="nd-fade space-y-6">
      <PageHeader icon={<Plus size={18} />} title={t('New resource')} subtitle={t('Deploy an application, start a database or install a one-click app.')} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            ref={searchRef}
            // biome-ignore lint/a11y/noAutofocus: the picker's whole job is search-then-pick; the user just asked for it.
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search: postgres, next.js, docker image, wordpress…')}
            aria-label={t('Search resources')}
            className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-12 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-500/60"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-500">/</kbd>
        </div>
        <div role="tablist" aria-label={t('Resource type')} className="flex gap-1 rounded-xl bg-white/[0.03] p-1 ring-1 ring-inset ring-white/10">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={category === c.id}
              onClick={() => setCategory(c.id)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition',
                category === c.id ? 'bg-indigo-500 text-white' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {t(c.label)}
            </button>
          ))}
        </div>
      </div>

      {show('apps') && apps.length > 0 && (
        <section aria-labelledby="new-apps">
          <h2 id="new-apps" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('Applications')}</h2>
          <div className="nd-stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((a) => (
              <AppSourceCard
                key={a.kind}
                source={a}
                needsSetup={a.kind === 'github-app' && sources.isSuccess && !hasGithubApp}
                onPick={() => (a.kind === 'upload' ? setUploading(true) : openDeploy(a.kind))}
              />
            ))}
          </div>
        </section>
      )}

      {show('databases') && dbs.length > 0 && (
        <section aria-labelledby="new-dbs">
          <h2 id="new-dbs" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('Databases')}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {dbs.map((e) => (
              <button key={e.id} type="button" onClick={() => setDbEngine(e.id)} className="group block text-left" aria-label={t('{engine} database', { engine: e.label })}>
                <Card interactive className="h-full p-3.5 transition group-hover:border-emerald-500/30">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xl leading-none" aria-hidden="true">{e.emoji}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">{e.label}</div>
                      <div className="truncate text-[11px] text-slate-500">{e.hint}</div>
                    </div>
                  </div>
                </Card>
              </button>
            ))}
          </div>
        </section>
      )}

      {show('services') && (
        <section aria-labelledby="new-services">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="new-services" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              {t('One-click apps')}{' '}
              {allTemplates.length > 0 && (
                <span className="font-normal normal-case text-slate-600">
                  · {t('{n} in the catalog', { n: allTemplates.length })}
                </span>
              )}
            </h2>
            <Link to="/hub" className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200">
              {t('Browse the Hub')} <ArrowRight size={12} />
            </Link>
          </div>
          {templates.isLoading ? (
            <p className="text-xs text-slate-500">{t('Loading the catalog…')}</p>
          ) : tplShown.length === 0 ? (
            !nothing && <p className="text-xs text-slate-500">{t('No one-click app matches “{query}”.', { query })}</p>
          ) : (
            <div className="nd-stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tplShown.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openTemplate.mutate(item.id)}
                  disabled={openTemplate.isPending}
                  className="group block text-left disabled:opacity-60"
                  aria-label={t('Deploy {name}', { name: item.name })}
                >
                  <Card interactive className="h-full p-3.5 transition group-hover:border-amber-500/30">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xl leading-none" aria-hidden="true">{item.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
                          <span className="truncate">{item.name}</span>
                          {item.runtimeVerified && <Sparkles size={11} className="shrink-0 text-emerald-400" aria-label={t('verified')} />}
                        </div>
                        <div className="truncate text-[11px] text-slate-500">{item.tagline}</div>
                      </div>
                      <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-500">{item.category}</span>
                    </div>
                  </Card>
                </button>
              ))}
            </div>
          )}
          {!q && tpl.length > tplShown.length && (
            <p className="mt-2 text-xs text-slate-500">{t('Search to see all {n}, or browse them by category in the Hub.', { n: tpl.length })}</p>
          )}
        </section>
      )}

      {nothing && (
        <Card className="p-8 text-center">
          <Boxes size={26} className="mx-auto text-slate-600" />
          <p className="mt-2 text-sm text-slate-300">{t('Nothing matches “{query}”.', { query })}</p>
          <p className="mt-1 text-xs text-slate-500">
            {fill(t('Anything that runs in a container can still be deployed: {image} or {git}.'), {
              image: (
                <button type="button" onClick={() => openDeploy('image')} className="text-indigo-300 hover:underline">
                  {t('deploy a Docker image')}
                </button>
              ),
              git: (
                <button type="button" onClick={() => openDeploy('git')} className="text-indigo-300 hover:underline">
                  {t('a Git repository')}
                </button>
              ),
            })}
          </p>
        </Card>
      )}

      {dbEngine && (
        <DatabaseWizard
          initialEngine={dbEngine}
          onClose={() => setDbEngine(null)}
          onCreated={(created) => navigate(`/databases/${created.id}`)}
        />
      )}
      {template && <DeployWizard template={template} onClose={() => setTemplate(null)} />}
      {uploading && <UploadSourceModal onClose={() => setUploading(false)} />}
    </div>
  );
}

function AppSourceCard({ source: a, needsSetup, onPick }: { source: AppSource; needsSetup: boolean; onPick: () => void }) {
  const t = useT();
  const Icon = a.icon;
  const body = (
    <Card interactive className="group h-full p-4 transition group-hover:border-indigo-500/30">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-500/10 text-indigo-300 ring-1 ring-inset ring-indigo-500/20">
          <Icon size={18} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
            {t(a.title)}
            {needsSetup && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">{t('set up')}</span>}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{t(a.hint)}</p>
        </div>
      </div>
    </Card>
  );
  // A GitHub App that is not connected yet leads to its one-click setup.
  return needsSetup ? (
    <Link to="/sources" className="group block text-left" aria-label={t('{source}: connect one first', { source: t(a.title) })}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onPick} className="group block text-left" aria-label={t(a.title)}>
      {body}
    </button>
  );
}
