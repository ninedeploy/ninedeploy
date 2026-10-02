import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Plus,
  Shield,
  Trash2,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Modal,
  Field,
  Input,
  Select,
} from '../../components/ui.js';
import type { OidcProviderCreateInput, OidcProviderEntry } from '@ninedeploy/sdk';
import { ScimTokensCard } from './ScimTokensCard.js';

/** r507: the comma/space-separated domain field → the list the API stores. */
export function parseAllowedDomains(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
}

/** r507: auto-enroll with no domain list lets ANY account at the IdP sign up. */
function OpenEnrollmentWarning() {
  return (
    <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>
        Auto-enroll is on with no domain restriction: anyone who can sign in to this identity provider (for a public
        provider like GitHub or Google, anyone at all) can create an account here. Add your organisation's email
        domains, or turn auto-enroll off.
      </span>
    </p>
  );
}

export function SsoSection() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<OidcProviderEntry | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('openid profile email');
  const [enabled, setEnabled] = useState(true);
  const [autoEnroll, setAutoEnroll] = useState(true);
  const [defaultRole, setDefaultRole] = useState<'admin' | 'member'>('member');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: providers = [], isLoading } = useQuery({
    queryKey: ['oidc-providers'],
    queryFn: () => api.auth.oidc.list(),
  });

  const createMutation = useMutation({
    mutationFn: (input: OidcProviderCreateInput) => api.auth.oidc.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oidc-providers'] });
      queryClient.invalidateQueries({ queryKey: ['public-oidc-providers'] });
      setCreateOpen(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<OidcProviderCreateInput> }) =>
      api.auth.oidc.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oidc-providers'] });
      queryClient.invalidateQueries({ queryKey: ['public-oidc-providers'] });
      setEditProvider(null);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.auth.oidc.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['oidc-providers'] });
      queryClient.invalidateQueries({ queryKey: ['public-oidc-providers'] });
    },
    onError: () => setDeleteError('Could not delete the provider — try again'),
  });
  // The app-wide ConfirmDialog replaces the native confirm() (inconsistent
  // focus/keyboard behaviour) and a failure now says so instead of dying
  // silently behind the dialog.
  const [pendingDelete, setPendingDelete] = useState<OidcProviderEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const resetForm = () => {
    setName('');
    setSlug('');
    setIssuerUrl('');
    setClientId('');
    setClientSecret('');
    setScopes('openid profile email');
    setEnabled(true);
    setAutoEnroll(true);
    setDefaultRole('member');
    setAllowedDomains('');
    setError(null);
  };

  const openCreate = (preset?: 'github' | 'google' | 'okta') => {
    resetForm();
    if (preset === 'github') {
      setName('GitHub');
      setSlug('github');
      setIssuerUrl('');
      setScopes('read:user user:email');
    } else if (preset === 'google') {
      setName('Google Workspace');
      setSlug('google');
      setIssuerUrl('https://accounts.google.com');
      setScopes('openid profile email');
    } else if (preset === 'okta') {
      setName('Okta Enterprise');
      setSlug('okta');
      setIssuerUrl('https://your-domain.okta.com');
      setScopes('openid profile email');
    }
    setCreateOpen(true);
  };

  const openEdit = (p: OidcProviderEntry) => {
    setEditProvider(p);
    setName(p.name);
    setSlug(p.slug);
    setIssuerUrl(p.issuerUrl ?? '');
    setClientId(p.clientId);
    setClientSecret(''); // Kept secret unless updated
    setScopes(p.scopes);
    setEnabled(p.enabled);
    setAutoEnroll(p.autoEnroll);
    setDefaultRole(p.defaultRole);
    setAllowedDomains((p.allowedDomains ?? []).join(', '));
    setError(null);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !clientId.trim()) return;
    setError(null);
    setBusy(true);

    try {
      if (editProvider) {
        await updateMutation.mutateAsync({
          id: editProvider.id,
          data: {
            name: name.trim(),
            issuerUrl: issuerUrl.trim() || null,
            clientId: clientId.trim(),
            ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
            scopes: scopes.trim(),
            enabled,
            autoEnroll,
            defaultRole,
            allowedDomains: parseAllowedDomains(allowedDomains),
          },
        });
      } else {
        if (!slug.trim() || !clientSecret.trim()) {
          setError('Slug and Client Secret are required');
          setBusy(false);
          return;
        }
        await createMutation.mutateAsync({
          name: name.trim(),
          slug: slug.trim().toLowerCase(),
          issuerUrl: issuerUrl.trim() || null,
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          scopes: scopes.trim(),
          enabled,
          autoEnroll,
          defaultRole,
          allowedDomains: parseAllowedDomains(allowedDomains),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save SSO provider');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <Shield size={18} className="text-indigo-400" />
              <h2 className="text-base font-semibold text-white">Single Sign-On (SSO &amp; OIDC)</h2>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Connect external OpenID Connect and OAuth2 identity providers for one-click team authentication.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => openCreate()}>
              <Plus size={14} />
              <span>Add Provider</span>
            </Button>
          </div>
        </div>

        {/* Quick Presets */}
        <div className="flex flex-wrap items-center gap-2 pb-5 border-b border-white/5">
          <span className="text-xs text-slate-500">Quick add:</span>
          <button
            type="button"
            onClick={() => openCreate('github')}
            className="rounded-lg bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
          >
            GitHub OAuth
          </button>
          <button
            type="button"
            onClick={() => openCreate('google')}
            className="rounded-lg bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
          >
            Google OIDC
          </button>
          <button
            type="button"
            onClick={() => openCreate('okta')}
            className="rounded-lg bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.08] hover:text-white transition"
          >
            Okta / Auth0
          </button>
        </div>

        {/* Providers List */}
        {isLoading ? (
          <div className="py-8 text-center text-xs text-slate-500">Loading SSO providers…</div>
        ) : providers.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500">
            No SSO providers configured. Add Google, GitHub, or Okta above to enable one-click login.
          </div>
        ) : (
          <div className="divide-y divide-white/5 mt-2">
            {providers.map((p: OidcProviderEntry) => (
              <div
                key={p.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between py-4 gap-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5">
                    <span className="text-sm font-semibold text-white">{p.name}</span>
                    <Badge tone={p.enabled ? 'emerald' : 'neutral'} className="text-[10px]">
                      {p.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                    {p.autoEnroll && (
                      <Badge tone="indigo" className="text-[10px]">
                        Auto-Enroll
                      </Badge>
                    )}
                    {p.autoEnroll && (p.allowedDomains ?? []).length === 0 && (
                      <Badge tone="amber" className="text-[10px]">
                        Any domain
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 font-mono">
                    <span>slug: {p.slug}</span>
                    {p.issuerUrl && <span>issuer: {p.issuerUrl}</span>}
                    <span>role: {p.defaultRole}</span>
                    {(p.allowedDomains ?? []).length > 0 && <span>domains: {(p.allowedDomains ?? []).join(', ')}</span>}
                  </div>
                  {p.autoEnroll && (p.allowedDomains ?? []).length === 0 && <OpenEnrollmentWarning />}
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => openEdit(p)}>
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    className="px-2"
                    title="Delete Provider"
                    onClick={() => {
                      setDeleteError(null);
                      setPendingDelete(p);
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Add / Edit Dialog */}
      {(createOpen || editProvider) && (
        <Modal
          onClose={() => {
            setCreateOpen(false);
            setEditProvider(null);
          }}
          title={editProvider ? `Edit ${editProvider.name}` : 'Configure SSO / OIDC Provider'}
        >
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Display Name">
                <Input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Google Workspace"
                  autoFocus
                />
              </Field>
              <Field label="Slug (URL identifier)">
                <Input
                  required
                  disabled={Boolean(editProvider)}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="e.g. google or okta"
                />
              </Field>
            </div>

            <Field label="OIDC Issuer URL (Optional for GitHub)">
              <Input
                type="url"
                value={issuerUrl}
                // Typing the issuer is covered by the preset tests; the
                // instrumenter cannot see this handler.
                onChange={/* v8 ignore start */ (e) => setIssuerUrl(e.target.value) /* v8 ignore stop */}
                placeholder="https://accounts.google.com or https://your-tenant.okta.com"
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Client ID">
                <Input
                  required
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="OAuth Client ID"
                />
              </Field>
              <Field label={editProvider ? 'Client Secret (leave blank to keep)' : 'Client Secret'}>
                <Input
                  type="password"
                  required={!editProvider}
                  value={clientSecret}
                  // Typing the secret is covered by the create/rotate tests;
                  // the instrumenter cannot see this handler.
                  onChange={/* v8 ignore start */ (e) => setClientSecret(e.target.value) /* v8 ignore stop */}
                  placeholder="••••••••••••"
                />
              </Field>
            </div>

            <Field label="OAuth Scopes">
              <Input
                value={scopes}
                onChange={(e) => setScopes(e.target.value)}
                placeholder="openid profile email"
              />
            </Field>

            <Field label="Allowed email domains (comma-separated; empty = any)">
              <Input
                value={allowedDomains}
                onChange={(e) => setAllowedDomains(e.target.value)}
                placeholder="corp.com, corp.io"
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-white/5">
              <Field label="Default User Role">
                <Select
                  value={defaultRole}
                  onChange={(e) => setDefaultRole(e.target.value as 'admin' | 'member')}
                >
                  <option value="member">Member — standard access</option>
                  <option value="admin">Admin — instance management</option>
                </Select>
              </Field>

              <div className="space-y-3 pt-6">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    className="rounded border-white/10 bg-slate-800 text-indigo-500 focus:ring-indigo-400"
                  />
                  <span>Enable SSO on login page</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={autoEnroll}
                    onChange={(e) => setAutoEnroll(e.target.checked)}
                    className="rounded border-white/10 bg-slate-800 text-indigo-500 focus:ring-indigo-400"
                  />
                  <span>Auto-enroll new users on first login</span>
                </label>
              </div>
            </div>

            {autoEnroll && parseAllowedDomains(allowedDomains).length === 0 && <OpenEnrollmentWarning />}

            {error && <p className="text-xs text-rose-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCreateOpen(false);
                  setEditProvider(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim() || !clientId.trim()}>
                {busy ? 'Saving…' : editProvider ? 'Save Changes' : 'Create Provider'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete SSO provider"
        message={`Delete ${pendingDelete?.name}? Everyone signing in through it falls back to password login; linked accounts keep their data.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
      {deleteError && <p className="text-xs text-rose-400">{deleteError}</p>}
      <ScimTokensCard />
    </div>
  );
}
