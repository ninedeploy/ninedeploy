import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import type { DnsCredentialProviderName } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody } from '../../components/ui.js';
import { msg, useT } from '../../lib/i18n.js';

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

/** The fields each provider needs; mirrors the server's `DNS_CREDENTIAL_SCHEMAS`. */
const PROVIDERS: Record<DnsCredentialProviderName, { label: string; help: string; fields: Field[] }> = {
  route53: {
    label: 'Amazon Route 53',
    help: msg('An IAM access key allowed route53:ListHostedZones and route53:ChangeResourceRecordSets on your public hosted zones.'),
    fields: [
      { key: 'accessKeyId', label: msg('Access key ID'), placeholder: 'AKIA…' },
      { key: 'secretAccessKey', label: msg('Secret access key'), secret: true },
    ],
  },
  ovh: {
    label: 'OVHcloud',
    help: msg('Create an application and a consumer key at the API token page of your region, granting GET/POST/DELETE on /domain/zone/*.'),
    fields: [
      {
        key: 'endpoint',
        label: msg('Region'),
        options: [
          { value: 'ovh-eu', label: msg('Europe (eu.api.ovh.com)') },
          { value: 'ovh-ca', label: msg('Canada (ca.api.ovh.com)') },
          { value: 'ovh-us', label: msg('United States (api.us.ovhcloud.com)') },
        ],
      },
      { key: 'applicationKey', label: msg('Application key') },
      { key: 'applicationSecret', label: msg('Application secret'), secret: true },
      { key: 'consumerKey', label: msg('Consumer key'), secret: true },
    ],
  },
  porkbun: {
    label: 'Porkbun',
    help: msg('Create an API key pair under Account → API Access, then switch on API access for each domain in its Details.'),
    fields: [
      { key: 'apiKey', label: msg('API key'), placeholder: 'pk1_…', secret: true },
      { key: 'secretApiKey', label: msg('Secret API key'), placeholder: 'sk1_…', secret: true },
    ],
  },
  hetzner: {
    label: 'Hetzner DNS',
    help: msg('A Hetzner Cloud API token (Read & Write) of the project that holds your DNS zones.'),
    fields: [{ key: 'token', label: msg('API token'), secret: true }],
  },
};

const INPUT = 'w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500';

/** G3.5: Route 53, OVH, Porkbun and Hetzner DNS record automation (operator-only section). */
export function DnsProviderCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const q = useQuery({ queryKey: ['settings-dns-provider'], queryFn: () => api.settings.dnsProvider.get() });
  const [provider, setProvider] = useState<DnsCredentialProviderName>('route53');
  const [values, setValues] = useState<Record<string, string>>({ endpoint: 'ovh-eu' });
  const [prefilled, setPrefilled] = useState(false);
  const [zones, setZones] = useState<string | null>(null);

  useEffect(() => {
    if (prefilled || !q.data) return;
    if (q.data.configured) {
      setProvider(q.data.configured);
      setValues((v) => ({ ...v, ...q.data.fields }));
    }
    setPrefilled(true);
  }, [q.data, prefilled]);

  const spec = PROVIDERS[provider];
  const active = q.data?.configured && q.data.provider === q.data.configured ? q.data.configured : null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings-dns-provider'] });

  const save = useMutation({
    mutationFn: () =>
      api.settings.dnsProvider.set({
        provider,
        credentials: Object.fromEntries(spec.fields.map((f) => [f.key, (values[f.key] ?? '').trim()])),
      }),
    onSuccess: () => {
      setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !spec.fields.find((f) => f.key === k)?.secret)));
      setZones(null);
      refresh();
      toast(t('{provider} is now the DNS record provider', { provider: spec.label }), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Save failed'), 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.settings.dnsProvider.test(),
    onSuccess: (r) => {
      if (r.ok) setZones(r.zoneCount ? t('{count} zone(s): {zones}', { count: r.zoneCount, zones: (r.zones ?? []).join(', ') }) : t('No zones visible to these credentials'));
      else toast(r.error ?? t('Test failed'), 'error');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Test failed'), 'error'),
  });

  const clear = useMutation({
    mutationFn: () => api.settings.dnsProvider.clear(),
    onSuccess: () => {
      setZones(null);
      refresh();
      toast(t('DNS record provider switched off'), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Could not switch it off'), 'error'),
  });

  const canSave = spec.fields.every((f) => !!(values[f.key] ?? '').trim());

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Globe size={14} /> {t('DNS records: Route 53, OVH, Porkbun, Hetzner')}
        </h2>
        <p className="mb-2 text-xs text-slate-500">
          {t('When a domain goes live, NineDeploy creates its A, AAAA or CNAME record in the zone that owns it, and deletes the record with the domain. Records that already exist are left alone. One DNS record provider is active at a time: saving here replaces Cloudflare, DNSimple or Namecheap.')}
        </p>
        <p className="mb-4 text-xs" data-testid="dns-provider-status">
          {active ? (
            <span className="text-emerald-400">{t('Active: {provider}', { provider: PROVIDERS[active].label })}</span>
          ) : q.data?.provider ? (
            <span className="text-slate-500">{t('Active provider: {provider} (configured on its own card)', { provider: q.data.provider })}</span>
          ) : (
            <span className="text-slate-500">{t('No DNS record provider is active.')}</span>
          )}
        </p>
        <div className="grid max-w-md gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">{t('Provider')}</span>
            <select
              aria-label={t('DNS provider')}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as DnsCredentialProviderName);
                setZones(null);
              }}
              className={INPUT}
            >
              {(Object.keys(PROVIDERS) as DnsCredentialProviderName[]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDERS[p].label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[11px] text-slate-500">{t(spec.help)}</p>
          {spec.fields.map((f) => (
            <label key={f.key} className="block">
              <span className="mb-1 block text-xs text-slate-500">{t(f.label)}</span>
              {f.options ? (
                <select aria-label={t(f.label)} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} className={INPUT}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {t(o.label)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={t(f.label)}
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  placeholder={f.secret && active === provider ? t('saved; re-enter to change') : f.placeholder}
                  className={INPUT}
                />
              )}
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
              {save.isPending ? t('Saving…') : t('Save and activate')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !active}>
              {test.isPending ? t('Testing…') : t('List zones')}
            </Button>
            {q.data?.configured && (
              <Button size="sm" variant="ghost" onClick={() => clear.mutate()} disabled={clear.isPending}>
                {t('Switch off')}
              </Button>
            )}
          </div>
          {zones && <p className="text-[11px] text-slate-400">{zones}</p>}
        </div>
      </CardBody>
    </Card>
  );
}
