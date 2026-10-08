import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ExternalLink, GitBranch, KeyRound, Plus, RefreshCw, Trash2, Webhook } from 'lucide-react';
import type { GithubApp, GithubAppInstallation, Source } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, ConfirmDialog, Field, Input, Textarea, cn } from '../../components/ui.js';

/**
 * 0.13: GitHub App registration on the Sources page (operator-only, like the
 * page). One-click setup goes through GitHub's manifest flow: the panel asks
 * the server for a signed manifest, then POSTs it to GitHub in a hidden form;
 * GitHub sends the browser back to `/github-apps/callback`. Installations
 * show up as generated `github_app` sources.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The browser hop to GitHub's "Create GitHub App" page: a top-level form POST
 * with one `manifest` field (GitHub reads the manifest from the form body,
 * and `state` from the URL). An object so tests can observe it, as jsdom
 * cannot submit a form.
 */
export const manifestNavigation = {
  submit(postUrl: string, manifest: Record<string, unknown>): void {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = postUrl;
    form.style.display = 'none';
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'manifest';
    field.value = JSON.stringify(manifest);
    form.appendChild(field);
    document.body.appendChild(form);
    form.submit();
  },
};

type Target = 'user' | 'org';

export function GithubAppsPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [panel, setPanel] = useState<'none' | 'create' | 'manual'>('none');
  const apps = useQuery({ queryKey: ['github-apps'], queryFn: () => api.githubApps.list() });
  // Shared key with the Sources list above: installations render as their generated sources.
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.sources.list() });

  const toggle = (next: 'create' | 'manual') => setPanel((cur) => (cur === next ? 'none' : next));

  return (
    <section className="mt-8" aria-label="GitHub Apps">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <GitBranch size={15} /> GitHub Apps
          </h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-slate-500">
            Recommended over personal access tokens: short-lived, repository-scoped clone tokens, one webhook for every linked
            service, commit statuses and PR comments. Each installation becomes a source you can pick in the Deploy Wizard.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => toggle('create')}>
            <Plus size={14} /> Create GitHub App
          </Button>
          <Button size="sm" variant="secondary" onClick={() => toggle('manual')}>
            Add manually (GHES)
          </Button>
        </div>
      </div>

      {panel === 'create' && <CreateAppForm onCancel={() => setPanel('none')} />}
      {panel === 'manual' && (
        <ManualAppForm
          onDone={() => {
            setPanel('none');
            qc.invalidateQueries({ queryKey: ['github-apps'] });
            toast('GitHub App registered', 'success');
          }}
        />
      )}

      {apps.isError ? (
        <Card className="p-4 text-xs text-rose-300">Could not load GitHub Apps: {errorText(apps.error)}</Card>
      ) : apps.data && apps.data.length > 0 ? (
        <div className="space-y-3">
          {apps.data.map((app) => (
            <AppCard key={app.id} app={app} sources={sources.data ?? []} />
          ))}
        </div>
      ) : apps.isSuccess ? (
        <Card className="p-4 text-xs text-slate-500">No GitHub App registered yet.</Card>
      ) : null}
    </section>
  );
}

/** One-click setup: personal account or organization, then off to GitHub. */
function CreateAppForm({ onCancel }: { onCancel: () => void }) {
  const { toast } = useToast();
  const [target, setTarget] = useState<Target>('user');
  const [org, setOrg] = useState('');
  const start = useMutation({
    mutationFn: () => api.githubApps.manifest(target === 'org' ? { target, org: org.trim() } : { target }),
    onSuccess: (res) => manifestNavigation.submit(res.postUrl, res.manifest),
    onError: (err) => toast(`Could not start the GitHub App setup: ${errorText(err)}`, 'error'),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (target === 'user' || org.trim()) start.mutate();
  };
  return (
    <Card className="mb-4 p-5 nd-fade">
      <form onSubmit={onSubmit} className="space-y-4" aria-label="Create GitHub App">
        <Field label="Owner">
          <div className="flex h-10 items-center gap-1 rounded-lg bg-black/30 p-1 ring-1 ring-inset ring-white/10">
            {(['user', 'org'] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={target === t}
                onClick={() => setTarget(t)}
                className={cn('flex-1 rounded-md py-1 text-xs font-medium transition', target === t ? 'bg-indigo-500 text-white' : 'text-slate-400')}
              >
                {t === 'user' ? 'Personal account' : 'Organization'}
              </button>
            ))}
          </div>
        </Field>
        {target === 'org' && (
          <Field label="Organization login">
            <Input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="acme" required />
          </Field>
        )}
        <p className="text-[11px] leading-relaxed text-slate-500">
          GitHub opens with the App pre-filled (contents and metadata read, pull requests and commit statuses write, push and
          pull request events). After you confirm, it returns here and the App is saved. The panel needs a public domain:
          GitHub must reach its webhook URL.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={start.isPending || (target === 'org' && !org.trim())}>
            {start.isPending ? 'Opening GitHub…' : 'Continue on GitHub'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Manual entry: an existing App, or one on GitHub Enterprise Server. */
function ManualAppForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: '', appId: '', privateKey: '', webhookSecret: '', webBaseUrl: '', apiBaseUrl: '' });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const create = useMutation({
    mutationFn: () => {
      const web = form.webBaseUrl.trim();
      const apiBase = form.apiBaseUrl.trim();
      return api.githubApps.create({
        name: form.name.trim(),
        appId: Number(form.appId),
        privateKey: form.privateKey.trim(),
        ...(form.webhookSecret ? { webhookSecret: form.webhookSecret } : {}),
        ...(web || apiBase ? { webBaseUrl: web, apiBaseUrl: apiBase } : {}),
      });
    },
    onSuccess: onDone,
    onError: (err) => toast(`Could not register the GitHub App: ${errorText(err)}`, 'error'),
  });
  const valid = !!form.name.trim() && Number.isInteger(Number(form.appId)) && Number(form.appId) > 0 && !!form.privateKey.trim();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) create.mutate();
  };
  return (
    <Card className="mb-4 p-5 nd-fade">
      <form onSubmit={onSubmit} className="space-y-4" aria-label="Add GitHub App manually">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={set('name')} placeholder="NineDeploy (GHES)" />
          </Field>
          <Field label="App ID">
            <Input value={form.appId} onChange={set('appId')} placeholder="123456" inputMode="numeric" />
          </Field>
        </div>
        <Field label="Private key (.pem)">
          <Textarea value={form.privateKey} onChange={set('privateKey')} placeholder="-----BEGIN RSA PRIVATE KEY-----" rows={4} className="font-mono text-[11px]" />
        </Field>
        <Field label="Webhook secret" hint="optional: left empty, the panel generates one and points the App's webhook here">
          <Input value={form.webhookSecret} onChange={set('webhookSecret')} type="password" autoComplete="off" />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Web base URL" hint="GHES only">
            <Input value={form.webBaseUrl} onChange={set('webBaseUrl')} placeholder="https://github.example.com" />
          </Field>
          <Field label="API base URL" hint="GHES only">
            <Input value={form.apiBaseUrl} onChange={set('apiBaseUrl')} placeholder="https://github.example.com/api/v3" />
          </Field>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-500">
          Leave both base URLs empty for github.com. The panel proves the key with GitHub before saving. A GHES host on a private
          address is refused unless the server runs with <code className="font-mono">NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1</code>.
        </p>
        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending || !valid}>
            {create.isPending ? 'Verifying…' : 'Save GitHub App'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function AppCard({ app, sources }: { app: GithubApp; sources: Source[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [rotating, setRotating] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const installations = useQuery({ queryKey: ['github-app-installations', app.id], queryFn: () => api.githubApps.installations(app.id) });
  const refreshApps = () => qc.invalidateQueries({ queryKey: ['github-apps'] });

  const sync = useMutation({
    mutationFn: () => api.githubApps.syncInstallations(app.id),
    onSuccess: (res) => {
      qc.setQueryData(['github-app-installations', app.id], res.installations);
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast(
        `Installations synced: ${res.created} new, ${res.updated} updated, ${res.removed} removed${res.truncated ? ' (list truncated)' : ''}`,
        'success',
      );
    },
    onError: (err) => toast(`Sync failed: ${errorText(err)}`, 'error'),
  });
  const rotateKey = useMutation({
    mutationFn: () => api.githubApps.rotateKey(app.id, newKey.trim()),
    onSuccess: () => {
      setRotating(false);
      setNewKey('');
      refreshApps();
      toast('Private key replaced', 'success');
    },
    onError: (err) => toast(`Key rejected: ${errorText(err)}`, 'error'),
  });
  const webhookSync = useMutation({
    mutationFn: () => api.githubApps.webhookSync(app.id),
    onSuccess: () => toast('Webhook pointed at this panel', 'success'),
    onError: (err) => toast(`Webhook sync failed: ${errorText(err)}`, 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.githubApps.remove(app.id),
    onSuccess: () => {
      refreshApps();
      toast('GitHub App removed', 'success');
    },
    onError: (err) => toast(`Could not remove the GitHub App: ${errorText(err)}`, 'error'),
  });

  const enterprise = app.webBaseUrl.replace(/\/+$/, '') !== 'https://github.com';
  return (
    <Card className="p-5" data-testid={`github-app-${app.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold leading-tight">{app.name}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            App #{app.appId}
            {app.slug ? ` · ${app.slug}` : ''}
            {app.ownerLogin ? ` · owned by ${app.ownerLogin}` : ''}
            {enterprise ? ` · ${app.webBaseUrl}` : ''}
          </div>
          <div className="mt-1 break-all font-mono text-[10px] text-slate-500" title="Webhook URL">
            {app.webhookUrl}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {app.installUrl && (
            <a
              href={app.installUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1 rounded-md bg-indigo-500 px-3 text-xs font-medium text-white transition hover:bg-indigo-400"
            >
              Install <ExternalLink size={11} />
            </a>
          )}
          <Button size="sm" variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>
            <RefreshCw size={12} /> {sync.isPending ? 'Syncing…' : 'Sync'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setRotating((v) => !v)}>
            <KeyRound size={12} /> Rotate key
          </Button>
          <Button size="sm" variant="secondary" onClick={() => webhookSync.mutate()} disabled={webhookSync.isPending}>
            <Webhook size={12} /> Webhook sync
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={`Delete ${app.name}`}>
            <Trash2 size={12} /> Delete
          </Button>
        </div>
      </div>

      {rotating && (
        <form
          className="mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newKey.trim()) rotateKey.mutate();
          }}
        >
          <Field label="New private key (.pem)">
            <Textarea value={newKey} onChange={(e) => setNewKey(e.target.value)} rows={3} className="font-mono text-[11px]" placeholder="-----BEGIN RSA PRIVATE KEY-----" />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={rotateKey.isPending || !newKey.trim()}>
              {rotateKey.isPending ? 'Verifying…' : 'Replace key'}
            </Button>
          </div>
        </form>
      )}

      <div className="mt-4 border-t border-white/5 pt-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Installations</div>
        {installations.isError ? (
          <div className="text-[11px] text-rose-300">Could not load installations: {errorText(installations.error)}</div>
        ) : installations.data && installations.data.length > 0 ? (
          <ul className="space-y-1.5">
            {installations.data.map((inst) => (
              <InstallationRow key={inst.id} inst={inst} source={sources.find((s) => s.id === inst.sourceId)} />
            ))}
          </ul>
        ) : installations.isSuccess ? (
          <div className="text-[11px] text-slate-500">None yet. Install the App on GitHub, then press Sync.</div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete GitHub App"
        message={`Forget "${app.name}"? Its installation sources stay, but clones through them fail until the App is registered again. The App itself stays on GitHub.`}
        confirmLabel="Delete App"
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </Card>
  );
}

function InstallationRow({ inst, source }: { inst: GithubAppInstallation; source?: Source }) {
  const state = inst.removedAt ? 'removed' : inst.suspendedAt ? 'suspended' : 'active';
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid={`github-installation-${inst.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-200">{inst.accountLogin ?? `installation ${inst.installationId}`}</span>
        {inst.accountType && <span className="text-slate-500">({inst.accountType})</span>}
        <Badge tone={state === 'active' ? 'emerald' : 'amber'}>{state}</Badge>
        <span className="text-slate-500">{inst.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] text-slate-400">
          {source ? `source: ${source.name}` : inst.sourceId != null ? `source #${inst.sourceId}` : 'no source'}
        </span>
        {inst.configureUrl && (
          <a href={inst.configureUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-indigo-300">
            Configure <ExternalLink size={10} />
          </a>
        )}
      </div>
    </li>
  );
}
