import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { apiUrl } from '../../lib/apiUrl.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, ConfirmDialog, Field, Input, Textarea } from '../../components/ui.js';

/**
 * Settings → SSO (G3.6): SAML identity providers. The IdP gets this panel's
 * metadata URL; the panel gets the IdP's metadata XML and the email domains
 * whose accounts may sign in through it. Operators only (the API refuses
 * everyone else).
 */
export function SamlProvidersCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useQuery({ queryKey: ['sso-providers'], queryFn: () => api.sso.listProviders(), retry: false });
  const [name, setName] = useState('');
  const [metadata, setMetadata] = useState('');
  const [domains, setDomains] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: number; name: string } | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.sso.addProvider({
        type: 'saml',
        name: name.trim(),
        config: { idpMetadataXml: metadata, emailDomains: domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean) },
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast(res.error ?? t('Could not add the SAML provider'), 'error');
        return;
      }
      setName('');
      setMetadata('');
      setDomains('');
      void qc.invalidateQueries({ queryKey: ['sso-providers'] });
      toast(t('SAML provider added'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.sso.removeProvider(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sso-providers'] }),
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (list.isError || !list.data) return null;
  const saml = list.data.providers.filter((p) => p.type === 'saml');
  const metadataUrl = (id: number) => new URL(apiUrl(`/v1/auth/saml/${id}/metadata`), window.location.origin).toString();

  return (
    <Card className="space-y-4 p-6">
      <div>
        <div className="flex items-center gap-2">
          <KeyRound size={18} className="text-indigo-400" />
          <h2 className="text-base font-semibold text-white">{t('SAML identity providers')}</h2>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          {t('Sign in through a SAML IdP. Give the IdP the metadata URL shown for the provider; accounts must already exist here, and only emails of the listed domains are accepted.')}
        </p>
      </div>
      {saml.length > 0 && (
        <ul className="space-y-2">
          {saml.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-black/20 px-3 py-2 text-xs">
              <span className="font-medium text-slate-200">{p.name}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400" title={metadataUrl(p.id)}>
                {metadataUrl(p.id)}
              </code>
              <Button size="sm" variant="ghost" onClick={() => setPendingDelete({ id: p.id, name: p.name })} aria-label={t('Delete {name}', { name: p.name })}>
                <Trash2 size={13} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="h-9 text-xs" />
        </Field>
        <Field label={t('Email domains')} hint={t('e.g. example.com, one or more')}>
          <Input value={domains} onChange={(e) => setDomains(e.target.value)} className="h-9 font-mono text-xs" />
        </Field>
      </div>
      <Field label={t('IdP metadata XML')}>
        <Textarea value={metadata} onChange={(e) => setMetadata(e.target.value)} rows={5} className="font-mono text-xs" placeholder={'<EntityDescriptor entityID="…">…</EntityDescriptor>'} />
      </Field>
      <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending || !name.trim() || !metadata.trim() || !domains.trim()}>
        {t('Add SAML provider')}
      </Button>
      <ConfirmDialog
        open={pendingDelete != null}
        title={t('Delete SSO provider')}
        message={t('Delete {name}? Everyone signing in through it falls back to password login; linked accounts keep their data.', { name: String(pendingDelete?.name) })}
        confirmLabel={t('Delete')}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </Card>
  );
}
