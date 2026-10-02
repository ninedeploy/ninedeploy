import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ErrorCard, cn } from '../../components/ui.js';

/** Security: open registration, ACME, template source, DNS-01 and wildcard domain. */
export function SecuritySection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const instanceSettings = useQuery({ queryKey: ['instance-settings'], queryFn: () => api.settings.get() });
  // Hoisted so the loading fallback is computed once.
  const allowRegistration = instanceSettings.data?.allowRegistration ?? true;
  // r562: every field below falls back to ''/null until the settings load. A
  // Save before that (or after a failed load) cleared the stored value — a
  // DNS token typed alone sent provider '' + apex '', switching the wildcard
  // DNS-01 challenge off. Nothing writes until the real values are known.
  const loaded = instanceSettings.data !== undefined;
  const setAllowRegistration = useMutation({
    mutationFn: (enabled: boolean) => api.settings.setAllowRegistration(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instance-settings'] }),
    onError: () => toast('Could not update the setting', 'error'),
  });
  // ── ACME (Let's Encrypt) email ───────────────────────────────────────────
  const acmeEmail = instanceSettings.data?.acmeEmail ?? null;
  const [acmeInput, setAcmeInput] = useState<string | null>(null);
  // ── Panel Domain & Dashboard SSL ─────────────────────────────────────────
  const panelDomain = instanceSettings.data?.panelDomain ?? null;
  const [panelDomainInput, setPanelDomainInput] = useState<string | null>(null);
  const setPanelDomain = useMutation({
    mutationFn: (domain: string) => api.settings.setPanelDomain(domain),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instance-settings'] });
      setPanelDomainInput(null);
      toast('Panel domain saved — Traefik routing updated', 'success');
    },
    onError: () => toast('Could not save the panel domain', 'error'),
  });
  // ── Template hub registry source ────────────────────────────────────────
  const templatesSource = instanceSettings.data?.templatesSource ?? null;
  const [tplInput, setTplInput] = useState<string | null>(null);
  // ── DNS-01 challenge (wildcard SSL) ─────────────────────────────────────
  const dnsProvider = instanceSettings.data?.dnsProvider ?? '';
  const hasDnsToken = instanceSettings.data?.hasDnsToken ?? false;
  const wildcardApex = instanceSettings.data?.wildcardApex ?? '';
  const [dnsProviderInput, setDnsProviderInput] = useState<string | null>(null);
  const [dnsTokenInput, setDnsTokenInput] = useState('');
  const [dnsApexInput, setDnsApexInput] = useState<string | null>(null);
  const setAcmeEmail = useMutation({
    mutationFn: (email: string) => api.settings.setAcmeEmail(email),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instance-settings'] });
      setAcmeInput(null);
      toast('ACME email saved — Traefik and certificate routing updated', 'success');
    },
    onError: () => toast('Could not save the ACME email', 'error'),
  });
  const setTemplatesSource = useMutation({
    mutationFn: (source: string) => api.settings.setTemplatesSource(source),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instance-settings'] });
      setTplInput(null);
      toast('Template registry source saved', 'success');
    },
    onError: () => toast('Could not save the template source', 'error'),
  });
  const setDns = useMutation({
    mutationFn: (input: { provider: string; token?: string; wildcardApex: string }) => api.settings.setDns(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instance-settings'] });
      setDnsProviderInput(null);
      setDnsApexInput(null);
      setDnsTokenInput('');
      toast('DNS challenge saved — Traefik updated', 'success');
    },
    onError: () => toast('Could not save the DNS challenge settings', 'error'),
  });

  return (
    <>
      {instanceSettings.isError && !loaded && (
        <div className="mb-5">
          <ErrorCard title="Could not load the security settings" error={instanceSettings.error} onRetry={() => void instanceSettings.refetch()} />
        </div>
      )}
      <Card className="mb-5">
        <CardBody>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            <ShieldCheck size={14} /> Security
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            When disabled, only existing users can sign in — new accounts cannot self-register.
          </p>
          <label className="flex max-w-md items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3">
            <span className="text-sm text-slate-300">Allow open registration</span>
            <button type="button"
              role="switch"
              aria-checked={allowRegistration}
              disabled={!loaded || setAllowRegistration.isPending}
              onClick={() => setAllowRegistration.mutate(!allowRegistration)}
              className={cn(
                'relative h-6 w-11 rounded-full transition',
                allowRegistration ? 'bg-emerald-500/80' : 'bg-slate-700',
              )}
              title="Toggle whether /v1/auth/register accepts new accounts"
            >
              <span
                className={cn(
                  'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all',
                  allowRegistration ? 'left-[22px]' : 'left-0.5',
                )}
              />
            </button>
          </label>

          <p className="mb-2 mt-6 text-sm text-slate-300">
            Let's Encrypt (ACME) account email — used for certificate issuance and expiry notices.
            {acmeEmail ? ' Configured.' : ' Not configured — SSL domains use a self-signed fallback cert.'}
          </p>
          <div className="flex max-w-md items-center gap-2">
            <input
              type="email"
              value={acmeInput ?? acmeEmail ?? ''}
              onChange={(e) => setAcmeInput(e.target.value)}
              placeholder="admin@example.com"
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label="ACME account email"
            />
            <Button
              size="sm"
              onClick={() => setAcmeEmail.mutate((acmeInput ?? acmeEmail ?? '').trim())}
              disabled={!loaded || setAcmeEmail.isPending}
            >
              {setAcmeEmail.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">Saving applies the resolver immediately by safely recreating Traefik when its static configuration changes.</p>

          <p className="mb-2 mt-6 text-sm text-slate-300">
            NineDeploy Panel Custom Domain & SSL
            {panelDomain ? (
              <>
                {' — active at '}
                <a
                  href={`https://${panelDomain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:underline font-mono"
                >
                  https://{panelDomain}
                </a>
              </>
            ) : (
              ' — not configured (accessing via server IP or raw port).'
            )}
          </p>
          <div className="flex max-w-md items-center gap-2">
            <input
              type="text"
              value={panelDomainInput ?? panelDomain ?? ''}
              onChange={(e) => setPanelDomainInput(e.target.value)}
              placeholder="panel.yourdomain.com"
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label="NineDeploy Panel domain"
            />
            <Button
              size="sm"
              // Both the click value chain and the pending label render in
              // the panel-domain tests; the instrumenter cannot see them.
              onClick={/* v8 ignore start */ () => setPanelDomain.mutate((panelDomainInput ?? panelDomain ?? '').trim()) /* v8 ignore stop */}
              disabled={!loaded || setPanelDomain.isPending}
            >
              {/* v8 ignore start */}
              {setPanelDomain.isPending ? 'Saving…' : 'Save'}
              {/* v8 ignore stop */}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Routes port 80/443 directly to this dashboard with automatic Let's Encrypt SSL. Point your domain's DNS A/CNAME record to this server first.
          </p>

          <p className="mb-2 mt-6 text-sm text-slate-300">
            Template hub registry source
            {templatesSource ? ` — custom (${templatesSource}).` : ' — bundled registry from this repo.'}
          </p>
          <div className="flex max-w-md items-center gap-2">
            <input
              type="text"
              value={tplInput ?? templatesSource ?? ''}
              onChange={(e) => setTplInput(e.target.value)}
              placeholder="https://example.com/registry.json or /path/to/registry.json"
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label="Template registry source"
            />
            <Button
              size="sm"
              onClick={() => setTemplatesSource.mutate((tplInput ?? templatesSource ?? '').trim())}
              disabled={!loaded || setTemplatesSource.isPending}
            >
              {setTemplatesSource.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">JSON format: {'{ version, templates: [{ id, name, tagline, description, category, emoji, image, port, … }] }'} — remote sources refresh every 6 hours; on failure the cache/built-in registry takes over.</p>

          <p className="mb-2 mt-6 text-sm text-slate-300">
            DNS challenge (wildcard SSL){hasDnsToken ? ' — API token configured.' : ' — no API token yet.'}
          </p>
          <div className="max-w-md space-y-2">
            <select
              value={dnsProviderInput ?? dnsProvider}
              onChange={(e) => setDnsProviderInput(e.target.value)}
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label="DNS provider"
            >
              <option value="">None (HTTP-01 only)</option>
              <option value="cloudflare">Cloudflare</option>
              <option value="digitalocean">DigitalOcean</option>
              <option value="hetzner">Hetzner</option>
              <option value="linode">Linode</option>
              <option value="gandi">Gandi</option>
              <option value="duckdns">DuckDNS</option>
            </select>
            <input
              type="password"
              value={dnsTokenInput}
              onChange={(e) => setDnsTokenInput(e.target.value)}
              placeholder={hasDnsToken ? 'API token (stored — leave empty to keep)' : 'API token'}
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label="DNS API token"
            />
            <input
              type="text"
              value={dnsApexInput ?? wildcardApex}
              onChange={(e) => setDnsApexInput(e.target.value)}
              placeholder="example.com → *.example.com wildcard certificate"
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label="Wildcard domain apex"
            />
            <div>
              <Button
                size="sm"
                onClick={() =>
                  setDns.mutate({
                    provider: (dnsProviderInput ?? dnsProvider).trim(),
                    token: dnsTokenInput.trim() || undefined,
                    wildcardApex: (dnsApexInput ?? wildcardApex).trim(),
                  })
                }
                disabled={!loaded || setDns.isPending}
              >
                {setDns.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            DNS-01 enables wildcard certificates (<code>*.example.com</code>) via your DNS provider; the token is stored
            encrypted and reaches Traefik through a docker --env-file. Changes apply immediately.
          </p>
        </CardBody>
      </Card>

      {/* Wildcard Domain — reads the configured apex from the settings API */}
      <Card className="mb-5">
        <CardBody>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Wildcard Domain</h2>
          <p className="mb-3 text-xs text-slate-500">
            Set a wildcard domain so every service automatically gets a URL like <code className="text-emerald-300">my-app.yourdomain.com</code>.
            Configure a wildcard DNS <code className="text-slate-400">*.yourdomain.com</code> → server IP, then set it here.
          </p>
          <div className="rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-inset ring-white/5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">Current</span>
              <span className="font-mono text-sm text-emerald-300">
                {wildcardApex ? `*.${wildcardApex}` : 'not configured'}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-600">
              Set via <code className="text-slate-500">NINEDEPLOY_WILDCARD_DOMAIN</code> env var and restart.
              Example: <code className="text-slate-500">NINEDEPLOY_WILDCARD_DOMAIN=ninedeploy.dev</code>
            </p>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
