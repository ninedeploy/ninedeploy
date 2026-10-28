import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Cloud, KeyRound, Server } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { fill, useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, ErrorCard } from '../../components/ui.js';
import { SecretManagersCard } from './SecretManagersCard.js';
import { DnsProviderCard } from './DnsProviderCard.js';
import { DnsRecordCard } from './DnsRecordCard.js';

// Vault reference examples (escaped so linters don't read them as template placeholders).
const REF_INFISICAL = '\u0024\u007B\u007Binfisical:KEY\u007D\u007D';
const REF_DOPPLER = '\u0024\u007B\u007Bdoppler:KEY\u007D\u007D';

/** Integrations: vault providers and secret managers (deploy-time secrets) + DNS records (Cloudflare, Namecheap, Route 53, OVH, Porkbun, Hetzner). */
export function IntegrationsSection() {
  return (
    <>
      <VaultCard />
      <SecretManagersCard />
      <CloudflareCard />
      <NamecheapCard />
      <DnsProviderCard />
      {/* G1.5: the domain-presets apply route, by hand. */}
      <DnsRecordCard />
    </>
  );
}

// ── Vault provider ─────────────────────────────────────────────────────────
function VaultCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const vault = useQuery({ queryKey: ['settings-vault'], queryFn: () => api.settings.vault.get() });
  const [provider, setProvider] = useState<'' | 'infisical' | 'doppler'>('infisical');
  const [token, setToken] = useState('');
  const [projectId, setProjectId] = useState('');
  const [environment, setEnvironment] = useState('');
  // r206: prefill from the stored config once it loads. The form used to start
  // blank with provider=infisical, so re-saving (say, to rotate the token)
  // switched a Doppler setup to Infisical — dropping its token — and wiped
  // the stored project/environment.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !vault.data) return;
    if (vault.data.provider === 'infisical' || vault.data.provider === 'doppler') setProvider(vault.data.provider);
    setProjectId(vault.data.projectId ?? '');
    setEnvironment(vault.data.environment ?? '');
    setPrefilled(true);
  }, [vault.data, prefilled]);
  const initialized =
    provider === (vault.data?.provider ?? '') && (vault.data?.hasToken || token.length > 0);

  const save = useMutation({
    mutationFn: () =>
      api.settings.vault.set({
        provider,
        ...(token ? { token } : {}),
        // Doppler reads the project too (`?project=`); it was never sent.
        projectId,
        environment: environment || (provider === 'infisical' ? 'default' : 'dev'),
      }),
    onSuccess: () => {
      setToken('');
      qc.invalidateQueries({ queryKey: ['settings-vault'] });
      toast(t('Vault settings saved'), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Save failed'), 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.settings.vault.test(),
    onSuccess: (res) => toast(t('Connected — {n} secrets reachable', { n: res.secrets }), 'success'),
    onError: (err) => toast(err instanceof Error ? err.message : t('Connection failed'), 'error'),
  });

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <KeyRound size={14} /> {t('Vault provider')}
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          {fill(
            t('Resolve env values from an external secret store at deploy time with {infisical} /{doppler} references. Resolved values are never stored.'),
            {
              infisical: <code className="rounded bg-white/5 px-1 font-mono text-[10px]">{REF_INFISICAL}</code>,
              doppler: <code className="ml-1 rounded bg-white/5 px-1 font-mono text-[10px]">{REF_DOPPLER}</code>,
            },
          )}
        </p>
        <div className="grid max-w-md gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">{t('Provider')}</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as '' | 'infisical' | 'doppler')}
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            >
              <option value="infisical">Infisical</option>
              <option value="doppler">Doppler</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">
              {t('API token')} {vault.data?.hasToken ? t('(stored — leave blank to keep)') : ''}
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('Universal Auth / service token')}
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">
                {provider === 'infisical' ? t('Workspace ID') : t('Project')}
              </span>
              <input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">
                {provider === 'infisical' ? t('Environment') : t('Config')}
              </span>
              <input
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                placeholder={provider === 'infisical' ? 'default' : 'dev'}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
              />
            </label>
          </div>
          {/* r562: the r206 prefill only runs once the stored config loads.
              Saved without it (a failed load), a token rotation wrote
              provider=infisical with a blank project over a Doppler setup. */}
          {vault.isError && !vault.data && (
            <ErrorCard title={t('Could not load the vault settings')} error={vault.error} onRetry={() => void vault.refetch()} />
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !vault.data || (!vault.data.hasToken && !token)}>
              {save.isPending ? t('Saving…') : t('Save')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !initialized}>
              {test.isPending ? t('Testing…') : t('Test connection')}
            </Button>
          </div>
        </div>
        <VaultAllowlist />
      </CardBody>
    </Card>
  );
}

/**
 * r510: which tenants may resolve vault references. Services owned by an
 * instance operator always may; everyone else only through a workspace
 * ticked here (or, for legacy un-tagged services, a grandfathered entry the
 * upgrade seeded). Each toggle saves immediately.
 */
function VaultAllowlist() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const vault = useQuery({ queryKey: ['settings-vault'], queryFn: () => api.settings.vault.get() });
  const allowlist = vault.data?.allowlist;
  const save = useMutation({
    mutationFn: (next: { workspaceIds: number[]; serviceIds: number[] }) => api.settings.vault.setAllowlist(next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-vault'] }),
    onError: (err) => toast(err instanceof Error ? err.message : t('Save failed'), 'error'),
  });
  if (!allowlist) return null;
  const toggle = (list: number[], id: number, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  return (
    <div className="mt-5 max-w-md border-t border-slate-800 pt-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('Allowed workspaces')}</h3>
      <p className="mb-3 text-xs text-slate-500">
        {t('Secret references (Infisical, Doppler, Vault and AWS Secrets Manager) resolve with instance-wide credentials, so only services owned by an operator — or tagged into a workspace ticked here — may use them.')}
      </p>
      {(vault.data?.workspaces ?? []).length === 0 ? (
        <p className="text-xs text-slate-500">{t('No workspaces yet.')}</p>
      ) : (
        <ul className="grid gap-1.5">
          {(vault.data?.workspaces ?? []).map((w) => (
            <li key={w.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowlist.workspaceIds.includes(w.id)}
                  disabled={save.isPending}
                  onChange={(e) =>
                    save.mutate({ ...allowlist, workspaceIds: toggle(allowlist.workspaceIds, w.id, e.target.checked) })
                  }
                />
                {w.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      {(vault.data?.allowedServices ?? []).length > 0 && (
        <>
          <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('Grandfathered services')}
          </h3>
          <p className="mb-2 text-xs text-slate-500">
            {t('Un-tagged services that used vault references before the upgrade. Untick to revoke.')}
          </p>
          <ul className="grid gap-1.5">
            {(vault.data?.allowedServices ?? []).map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked
                    disabled={save.isPending}
                    onChange={() => save.mutate({ ...allowlist, serviceIds: toggle(allowlist.serviceIds, s.id, false) })}
                  />
                  {s.name}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Cloudflare DNS records ────────────────────────────────────────────────
function CloudflareCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const dns = useQuery({ queryKey: ['settings-dns-records'], queryFn: () => api.settings.dnsRecords.get() });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [content, setContent] = useState('');
  const isOn = enabled ?? dns.data?.enabled ?? false;
  // r206: prefill the stored record content — the field started blank and a
  // blank save clears it server-side, so every save (even just toggling the
  // feature) silently reverted a custom CNAME/IP to auto-detect.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !dns.data) return;
    setContent(dns.data.content ?? '');
    setPrefilled(true);
  }, [dns.data, prefilled]);

  const save = useMutation({
    mutationFn: () =>
      api.settings.dnsRecords.set({
        enabled: isOn,
        ...(token ? { token } : {}),
        content: content.trim(),
      }),
    onSuccess: () => {
      setToken('');
      qc.invalidateQueries({ queryKey: ['settings-dns-records'] });
      toast(t('DNS records settings saved'), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Save failed'), 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.settings.dnsRecords.test(),
    onSuccess: (res) => {
      if (res.ok) toast(t('Token valid ({status})', { status: res.status ?? t('active') }), 'success');
      else toast(res.error ?? t('Token invalid'), 'error');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Connection failed'), 'error'),
  });

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Cloud size={14} /> {t('Cloudflare DNS records')}
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          {t('When enabled, adding a domain to a service automatically creates the matching Cloudflare record (A for an IP, CNAME for a hostname); deleting the domain removes it.')}
        </p>
        <div className="grid max-w-md gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={isOn}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-indigo-500"
            />
            {t('Enable automatic record creation')}
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">
              {t('API token')} {dns.data?.hasToken ? t('(stored — leave blank to keep)') : ''}
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('Zone:DNS:Edit-capable token')}
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">{t('Record content (blank = auto-detect public IP)')}</span>
            <input
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t('203.0.113.10 or cname.example.com')}
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
            />
          </label>
          {/* r562: unloaded, the switch reads "off" and the content blank — one
              Save turned automatic records off and cleared a custom value. */}
          {dns.isError && !dns.data && (
            <ErrorCard title={t('Could not load the DNS record settings')} error={dns.error} onRetry={() => void dns.refetch()} />
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !dns.data || (isOn && !dns.data.hasToken && !token)}>
              {save.isPending ? t('Saving…') : t('Save')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !(dns.data?.hasToken || token)}>
              {test.isPending ? t('Testing…') : t('Test token')}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Namecheap DNS records (G-07 PR-B) ────────────────────────────────────
function NamecheapCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const nc = useQuery({ queryKey: ['settings-dns-records-namecheap'], queryFn: () => api.settings.namecheap.get() });
  // The form starts with the current values from the API so the
  // operator can just edit one field and re-save. The apiKey field
  // is intentionally NOT pre-populated — the server's zod schema
  // requires a non-empty key on every PUT, so the operator must
  // re-enter it. (A future PR could split the schema into an
  // `update` patch that omits the key, mirroring the Cloudflare
  // form's "leave blank to keep" affordance.)
  const [apiUser, setApiUser] = useState(nc.data?.apiUser ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clientIp, setClientIp] = useState(nc.data?.clientIp ?? '');
  // r206: `useState(nc.data?.…)` only reads the FIRST render, when the query
  // has not resolved yet — the promised prefill never happened.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !nc.data) return;
    setApiUser(nc.data.apiUser ?? '');
    setClientIp(nc.data.clientIp ?? '');
    setPrefilled(true);
  }, [nc.data, prefilled]);

  const save = useMutation({
    mutationFn: () =>
      api.settings.namecheap.set({
        apiUser: apiUser.trim(),
        apiKey: apiKey.trim(),
        clientIp: clientIp.trim(),
      }),
    onSuccess: () => {
      setApiKey('');
      qc.invalidateQueries({ queryKey: ['settings-dns-records-namecheap'] });
      toast(t('Namecheap credentials saved'), 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : t('Save failed'), 'error'),
  });

  const canSave = !!apiUser.trim() && !!apiKey.trim() && !!clientIp.trim() && /^\d{1,3}(\.\d{1,3}){3}$/.test(clientIp.trim());

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Server size={14} /> {t('Namecheap DNS records')}
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          {t("Connect a Namecheap account so adding a domain to a service can create the matching host record via Namecheap's setHosts API. The public IP below must already be whitelisted on the Namecheap account panel.")}
        </p>
        <div className="grid max-w-md gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">{t('API user (account owner)')}</span>
            <input
              value={apiUser}
              onChange={(e) => setApiUser(e.target.value)}
              placeholder="account-owner-username"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">
              {t('API key')} {nc.data?.hasKey ? t('(re-enter to rotate — the server requires a non-empty value on every save)') : ''}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t('Namecheap API key')}
              autoComplete="off"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">{t('Whitelisted public IPv4')}</span>
            <input
              value={clientIp}
              onChange={(e) => setClientIp(e.target.value)}
              placeholder="203.0.113.10"
              pattern="^\d{1,3}(\.\d{1,3}){3}$"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
            />
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
              {save.isPending ? t('Saving…') : t('Save')}
            </Button>
          </div>
          <p className="text-[10px] text-slate-600">
            {fill(t('Activate this provider by setting {setting} in Settings → DNS.'), {
              setting: <code className="font-mono">dns_records_provider=namecheap</code>,
            })}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
