import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Cloud, KeyRound, Server } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody } from '../../components/ui.js';

// Vault reference examples (escaped so linters don't read them as template placeholders).
const REF_INFISICAL = '\u0024\u007B\u007Binfisical:KEY\u007D\u007D';
const REF_DOPPLER = '\u0024\u007B\u007Bdoppler:KEY\u007D\u007D';

/** Integrations: vault providers (deploy-time secrets) + Cloudflare + Namecheap DNS records. */
export function IntegrationsSection() {
  return (
    <>
      <VaultCard />
      <CloudflareCard />
      <NamecheapCard />
    </>
  );
}

// ── Vault provider ─────────────────────────────────────────────────────────
function VaultCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
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
      toast('Vault settings saved', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Save failed', 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.settings.vault.test(),
    onSuccess: (res) => toast(`Connected — ${res.secrets} secrets reachable`, 'success'),
    onError: (err) => toast(err instanceof Error ? err.message : 'Connection failed', 'error'),
  });

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <KeyRound size={14} /> Vault provider
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          Resolve env values from an external secret store at deploy time with{' '}
          <code className="rounded bg-white/5 px-1 font-mono text-[10px]">{REF_INFISICAL}</code> /
          <code className="ml-1 rounded bg-white/5 px-1 font-mono text-[10px]">{REF_DOPPLER}</code> references.
          Resolved values are never stored.
        </p>
        <div className="grid max-w-md gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">Provider</span>
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
              API token {vault.data?.hasToken ? '(stored — leave blank to keep)' : ''}
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Universal Auth / service token"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">
                {provider === 'infisical' ? 'Workspace ID' : 'Project'}
              </span>
              <input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">
                {provider === 'infisical' ? 'Environment' : 'Config'}
              </span>
              <input
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                placeholder={provider === 'infisical' ? 'default' : 'dev'}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || (!vault.data?.hasToken && !token)}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !initialized}>
              {test.isPending ? 'Testing…' : 'Test connection'}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ── Cloudflare DNS records ────────────────────────────────────────────────
function CloudflareCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
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
      toast('DNS records settings saved', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Save failed', 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.settings.dnsRecords.test(),
    onSuccess: (res) => {
      if (res.ok) toast(`Token valid (${res.status ?? 'active'})`, 'success');
      else toast(res.error ?? 'Token invalid', 'error');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Connection failed', 'error'),
  });

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Cloud size={14} /> Cloudflare DNS records
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          When enabled, adding a domain to a service automatically creates the matching Cloudflare record
          (A for an IP, CNAME for a hostname); deleting the domain removes it.
        </p>
        <div className="grid max-w-md gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={isOn}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-indigo-500"
            />
            Enable automatic record creation
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">
              API token {dns.data?.hasToken ? '(stored — leave blank to keep)' : ''}
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Zone:DNS:Edit-capable token"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">Record content (blank = auto-detect public IP)</span>
            <input
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="203.0.113.10 or cname.example.com"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
            />
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || (isOn && !dns.data?.hasToken && !token)}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => test.mutate()} disabled={test.isPending || !(dns.data?.hasToken || token)}>
              {test.isPending ? 'Testing…' : 'Test token'}
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
      toast('Namecheap credentials saved', 'success');
    },
    onError: (err) => toast(err instanceof Error ? err.message : 'Save failed', 'error'),
  });

  const canSave = !!apiUser.trim() && !!apiKey.trim() && !!clientIp.trim() && /^\d{1,3}(\.\d{1,3}){3}$/.test(clientIp.trim());

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Server size={14} /> Namecheap DNS records
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          Connect a Namecheap account so adding a domain to a service can create the matching
          host record via Namecheap&apos;s setHosts API. The public IP below must already be
          whitelisted on the Namecheap account panel.
        </p>
        <div className="grid max-w-md gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">API user (account owner)</span>
            <input
              value={apiUser}
              onChange={(e) => setApiUser(e.target.value)}
              placeholder="account-owner-username"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">
              API key {nc.data?.hasKey ? '(re-enter to rotate — the server requires a non-empty value on every save)' : ''}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Namecheap API key"
              autoComplete="off"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">Whitelisted public IPv4</span>
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
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          <p className="text-[10px] text-slate-600">
            Activate this provider by setting <code className="font-mono">dns_records_provider=namecheap</code>{' '}
            in Settings → DNS.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
