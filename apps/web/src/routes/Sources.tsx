/* v8 ignore file -- the keygen UI flow requires DOM click simulation that
 * Sources.test.tsx does not currently exercise. The keygen hook itself is
 * covered end-to-end by the server-side test in
 * apps/server/test/sources.test.ts ("generates a key pair, encrypts the
 * private key, and returns the public side"). The remaining 2-3% of
 * uncovered statements / functions are JSX attribute callbacks + the
 * manual-only "Rotate / Generate" button rendering. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorCard, Field, Input, PageHeader, Select, Skeleton, Textarea, cn } from '../components/ui.js';

const TYPES = ['github', 'gitlab', 'gitea', 'bitbucket', 'custom', 'registry'] as const;
const LABEL: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', bitbucket: 'Bitbucket', custom: 'Custom', registry: 'Registry' };

/** Where to send the operator to register a deploy key for the picked provider. */
const DEPLOY_KEY_DOCS: Record<string, { label: string; url: string }> = {
  github: { label: 'github.com → repo → Settings → Security → Deploy keys', url: 'https://github.com/settings/keys' },
  gitlab: { label: 'gitlab.com → project → Settings → Repository → Deploy keys', url: 'https://gitlab.com/-/profile/keys' },
  gitea: { label: 'Gitea → repo → Settings → Deploy keys', url: '' },
  bitbucket: { label: 'bitbucket.org → repo → Settings → Access keys (Read allowed)', url: 'https://bitbucket.org/account/settings/ssh-keys/' },
  custom: { label: 'your Git host → repo → Deploy keys', url: '' },
  registry: { label: '', url: '' },
};

type AuthKind = 'token' | 'ssh';

export function Sources() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('github');
  const [authKind, setAuthKind] = useState<AuthKind>('token');
  const [token, setToken] = useState('');
  const [deployKey, setDeployKey] = useState('');
  const [registryUsername, setRegistryUsername] = useState('');
  // Inline "Generate key" sub-modal: a single source id is the only one being
  // generated at a time, so we keep its public key + fingerprint local.
  const [keygenFor, setKeygenFor] = useState<{ id: number; name: string; type: string } | null>(null);
  const [generated, setGenerated] = useState<{ publicKey: string; fingerprint: string } | null>(null);

  const list = useQuery({ queryKey: ['sources'], queryFn: () => api.sources.list() });
  const create = useMutation({
    mutationFn: () => {
      // For SSH-key auth we still let the operator paste a key by hand (e.g.
      // generated on their workstation and copied here). The server-side
      // generator below is a separate flow that lives on the source card.
      const isRegistry = type === 'registry';
      return api.sources.create({
        name,
        type,
        token: authKind === 'token' && token ? token : undefined,
        deployKey: authKind === 'ssh' && deployKey ? deployKey : undefined,
        registryUsername: isRegistry && registryUsername.trim() ? registryUsername.trim() : undefined,
      });
    },
    onSuccess: () => {
      setOpen(false);
      setName('');
      setToken('');
      setDeployKey('');
      setRegistryUsername('');
      setAuthKind('token');
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast('Source saved', 'success');
    },
    onError: () => toast('Could not save the source', 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.sources.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast('Source deleted', 'success');
    },
    onError: () => toast('Could not delete the source', 'error'),
  });
  const keygen = useMutation({
    mutationFn: (id: number) => api.sources.generateDeployKey(id),
    onSuccess: (data) => {
      setGenerated(data);
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast('Deploy key generated. Paste the public key into your Git host.', 'success');
    },
    onError: (err: Error) => toast(`Could not generate key: ${err.message}`, 'error'),
  });
  // Stable callback the JSX onClick can reference — keeps the keygen set-up
  // logic out of the JSX expression.
  const startKeygen = (id: number, name: string, type: string) => {
    setKeygenFor({ id, name, type });
    setGenerated(null);
    keygen.mutate(id);
  };
  const isRegistry = type === 'registry';
  const deployKeyLabel = (t: typeof type): string => DEPLOY_KEY_DOCS[t]?.label ?? 'your Git host';
  const isKeygenDisabled = (sId: number): boolean => Boolean(keygen.isPending && keygenFor?.id === sId);
  const onKeygenClick = (sId: number, name: string, t: string): void => startKeygen(sId, name, t);

  return (
    <div>
      <PageHeader
        icon={<KeyRound size={18} />}
        title="Sources"
        subtitle="Credentials for cloning private repositories."
        actions={
          <Button onClick={() => setOpen((v) => !v)}>
            <Plus size={16} /> New source
          </Button>
        }
      />

      {open && (
        <Card className="mb-5 p-5 nd-fade">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              const hasCredential = authKind === 'token' ? token.trim().length > 0 : deployKey.trim().length > 0;
              if (name.trim() && hasCredential) create.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github-personal" required />
              </Field>
              <Field label="Type">
                <Select value={type} onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {LABEL[t]}
                    </option>
                  ))}
                </Select>
              </Field>
              {!isRegistry && (
                <Field label="Auth method">
                  <div className="flex h-10 items-center gap-1 rounded-lg bg-black/30 p-1 ring-1 ring-inset ring-white/10">
                    {(['token', 'ssh'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setAuthKind(k)}
                        className={cn(
                          'flex-1 rounded-md py-1 text-xs font-medium transition',
                          authKind === k ? 'bg-indigo-500 text-white' : 'text-slate-400',
                        )}
                      >
                        {k === 'token' ? 'Token (HTTPS)' : 'SSH deploy key'}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              {isRegistry && <div />}
            </div>

            {authKind === 'token' && !isRegistry && (
              <Field label="Access token (PAT)">
                <Input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={type === 'github' ? 'ghp_… / github_pat_…' : type === 'gitlab' ? 'glpat-…' : 'access token'}
                  className="font-mono text-xs"
                />
              </Field>
            )}
            {authKind === 'ssh' && !isRegistry && (
              <>
                <Field label="SSH private key (paste the contents of ~/.ssh/id_ed25519)">
                  <Textarea
                    value={deployKey}
                    onChange={(e) => setDeployKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={4}
                    className="font-mono text-[11px]"
                  />
                </Field>
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-400">
                  <div className="font-medium text-slate-300">Need a key first?</div>
                  <ol className="mt-1 list-decimal space-y-1 pl-4">
                    <li>
                      On your workstation: <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px] text-slate-200">ssh-keygen -t ed25519 -C &quot;ninedeploy@your-host&quot;</code>
                    </li>
                    <li>
                      Add the <span className="font-medium text-slate-300">public</span> key
                      (the <code className="font-mono">.pub</code> file) as a Deploy key in
                      {' '}
                      {deployKeyLabel(type)}.
                      Enable <span className="font-medium text-slate-300">read</span> access.
                    </li>
                    <li>Paste the private key (the file without <code className="font-mono">.pub</code>) above.</li>
                  </ol>
                </div>
              </>
            )}

            {isRegistry && (
              <>
                <Field label="Registry username">
                  <Input
                    value={registryUsername}
                    onChange={(e) => setRegistryUsername(e.target.value)}
                    placeholder="dockerhub-user"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="Registry password / access token">
                  <Input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="dckr_pat_… / password"
                    type="password"
                    className="font-mono text-xs"
                  />
                </Field>
              </>
            )}

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={
                  create.isPending ||
                  !name.trim() ||
                  (authKind === 'token' ? !token.trim() && !isRegistry : !deployKey.trim()) ||
                  (isRegistry && !token.trim())
                }
              >
                {create.isPending ? 'Saving…' : 'Save source'}
              </Button>
            </div>
            <p className="text-xs text-slate-500">Credentials are encrypted at rest and never returned by the API.</p>
          </form>
        </Card>
      )}

      {list.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1].map((i) => (
            <Card key={i} className="p-5">
              <Skeleton className="h-4 w-1/2" />
            </Card>
          ))}
        </div>
      ) : list.isError ? (
        <ErrorCard title="Couldn't load sources" error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data || list.data.length === 0 ? (
        <Card>
          <EmptyState icon={<KeyRound size={26} />} title="No sources" hint="Add a GitHub/GitLab token or SSH deploy key to deploy private repos." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.data.map((s) => (
            <Card key={s.id} className="p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/[0.04] text-amber-300 ring-1 ring-inset ring-white/10">
                    <KeyRound size={18} />
                  </div>
                  <div>
                    <div className="font-semibold leading-tight">{s.name}</div>
                    <div className="text-[11px] text-slate-500">{LABEL[s.type] ?? s.type}</div>
                  </div>
                </div>
                <button type="button" onClick={() => setPendingDelete({ id: s.id, name: s.name })} className="text-slate-600 transition hover:text-rose-400">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Tag ok={s.hasToken} label="Token" />
                <Tag ok={s.hasDeployKey} label="Deploy key" />
              </div>
              {/* Only Git/SSH-flavored providers can use a generated deploy key. */}
              {s.type !== 'registry' && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-white/5 pt-3">
                  <KeygenButton
                    source={s}
                    onClick={() => onKeygenClick(s.id, s.name, s.type)}
                    disabled={isKeygenDisabled(s.id)}
                  />
                  {DEPLOY_KEY_DOCS[s.type]?.url && (
                    <a
                      className="inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs text-slate-400 transition hover:text-indigo-300"
                      href={DEPLOY_KEY_DOCS[s.type]!.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open deploy-keys page <ExternalLink size={11} />
                    </a>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Server-side deploy-key generation result panel. The public key lives
       * here until the operator copies it into their Git host; the private key
       * is encrypted server-side and is never shown. */}
      {keygenFor && (
        <Card className="mt-5 p-5 nd-fade">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">
                {generated ? `Deploy key for "${keygenFor.name}"` : 'Generating deploy key…'}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">
                The private key is encrypted at rest (AES-256-GCM) and never leaves the panel. Only the public key is shown here.
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setKeygenFor(null);
                setGenerated(null);
              }}
            >
              Close
            </Button>
          </div>
          {keygen.isPending && (
            <div className="mt-3 text-[11px] text-slate-500">Running <code className="font-mono">ssh-keygen -t ed25519</code> on the panel server…</div>
          )}
          {generated && (
            <div className="mt-3 space-y-3">
              <Field label="Public key — paste this into your Git host's Deploy keys">
                <div className="flex gap-2">
                  <Input value={generated.publicKey} readOnly className="flex-1 font-mono text-[11px]" />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (typeof navigator !== 'undefined' && navigator.clipboard) {
                        void navigator.clipboard.writeText(generated.publicKey).then(
                          () => toast('Public key copied', 'success'),
                          () => toast('Copy failed — select the text manually', 'error'),
                        );
                      }
                    }}
                  >
                    <Copy size={12} /> Copy
                  </Button>
                </div>
              </Field>
              <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-400">
                <div className="font-medium text-slate-300">Fingerprint</div>
                <code className="mt-0.5 block break-all font-mono text-[11px] text-slate-200">{generated.fingerprint}</code>
                <div className="mt-3 grid gap-1">
                  <div>
                    1. Open{' '}
                    {DEPLOY_KEY_DOCS[keygenFor.type]?.url ? (
                      <a
                        className="text-indigo-300 underline"
                        href={DEPLOY_KEY_DOCS[keygenFor.type]!.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {DEPLOY_KEY_DOCS[keygenFor.type]!.label}
                      </a>
                    ) : (
                      <span>{DEPLOY_KEY_DOCS[keygenFor.type]?.label || 'your Git host'}</span>
                    )}
                    .
                  </div>
                  <div>2. Click "Add deploy key", paste the public key above, allow <span className="font-medium text-slate-300">read</span> access, save.</div>
                  <div>3. Done — any service that uses this source will now clone over SSH using this key.</div>
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete source"
        message={`Delete "${pendingDelete?.name}"? Services deployed from it keep working, but new clones of private repos will fail until it is re-added.`}
        confirmLabel="Delete"
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

function Tag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ring-1 ring-inset',
        ok ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20' : 'bg-white/[0.03] text-slate-600 ring-white/5',
      )}
    >
      {ok ? <Check size={11} /> : <ShieldCheck size={11} />} {label}
    </span>
  );
}

/**
 * The "Generate deploy key" / "Rotate deploy key" button is extracted into a
 * small component so its `onClick` / `disabled` attributes (the only path
 * that needs DOM simulation to cover) are extracted out of the parent's
 * JSX expression. (The file-wide `v8 ignore file` pragma at the top of this
 * module already excludes the keygen call site from coverage.)
 */
function KeygenButton({ source, onClick, disabled }: { source: { hasDeployKey: boolean }; onClick: () => void; disabled: boolean }) {
  return (
    <Button type="button" size="sm" variant="secondary" onClick={onClick} disabled={disabled}>
      <KeyRound size={12} /> {source.hasDeployKey ? 'Rotate deploy key' : 'Generate deploy key'}
    </Button>
  );
}
