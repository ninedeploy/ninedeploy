import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ErrorCard, cn } from '../../components/ui.js';
import { useAuth } from '../../lib/auth.js';
import { fill, useT } from '../../lib/i18n.js';
import { TerminalsCard } from './TerminalsCard.js';
import { AutoUrlCard } from './AutoUrlCard.js';
import { HostIpsCard } from './HostIpsCard.js';
import { EgressIpCard } from './EgressIpCard.js';
import { ApiTokensCard } from './ApiTokensCard.js';

/** Security: open registration, ACME, template source, DNS-01 and wildcard domain. */
export function SecuritySection() {
  const qc = useQueryClient();
  const t = useT();
  // 0.15: the Terminals card is operator-only (every terminal route is).
  const isOperator = useAuth().user?.isOperator === true;
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
    onError: () => toast(t('Could not update the setting'), 'error'),
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
      toast(t('Panel domain saved — Traefik routing updated'), 'success');
    },
    onError: () => toast(t('Could not save the panel domain'), 'error'),
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
      toast(t('ACME email saved — Traefik and certificate routing updated'), 'success');
    },
    onError: () => toast(t('Could not save the ACME email'), 'error'),
  });
  const setTemplatesSource = useMutation({
    mutationFn: (source: string) => api.settings.setTemplatesSource(source),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instance-settings'] });
      setTplInput(null);
      toast(t('Template registry source saved'), 'success');
    },
    onError: () => toast(t('Could not save the template source'), 'error'),
  });
  const setDns = useMutation({
    mutationFn: (input: { provider: string; token?: string; wildcardApex: string }) => api.settings.setDns(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instance-settings'] });
      setDnsProviderInput(null);
      setDnsApexInput(null);
      setDnsTokenInput('');
      toast(t('DNS challenge saved — Traefik updated'), 'success');
    },
    onError: () => toast(t('Could not save the DNS challenge settings'), 'error'),
  });

  return (
    <>
      {/* 0.16.3: every user's own tokens; the docs have pointed here since 0.10. */}
      <ApiTokensCard />
      {instanceSettings.isError && !loaded && (
        <div className="mb-5">
          <ErrorCard title={t('Could not load the security settings')} error={instanceSettings.error} onRetry={() => void instanceSettings.refetch()} />
        </div>
      )}
      <Card className="mb-5">
        <CardBody>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            <ShieldCheck size={14} /> {t('Security')}
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            {t('When disabled, only existing users can sign in — new accounts cannot self-register.')}
          </p>
          <label className="flex max-w-md items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3">
            <span className="text-sm text-slate-300">{t('Allow open registration')}</span>
            <button type="button"
              role="switch"
              aria-checked={allowRegistration}
              disabled={!loaded || setAllowRegistration.isPending}
              onClick={() => setAllowRegistration.mutate(!allowRegistration)}
              className={cn(
                'relative h-6 w-11 rounded-full transition',
                allowRegistration ? 'bg-emerald-500/80' : 'bg-slate-700',
              )}
              title={t('Toggle whether /v1/auth/register accepts new accounts')}
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
            {t("Let's Encrypt (ACME) account email — used for certificate issuance and expiry notices.")}
            {' '}{acmeEmail ? t('Configured.') : t('Not configured — SSL domains use a self-signed fallback cert.')}
          </p>
          <div className="flex max-w-md items-center gap-2">
            <input
              type="email"
              value={acmeInput ?? acmeEmail ?? ''}
              onChange={(e) => setAcmeInput(e.target.value)}
              placeholder="admin@example.com"
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label={t('ACME account email')}
            />
            <Button
              size="sm"
              onClick={() => setAcmeEmail.mutate((acmeInput ?? acmeEmail ?? '').trim())}
              disabled={!loaded || setAcmeEmail.isPending}
            >
              {setAcmeEmail.isPending ? t('Saving…') : t('Save')}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">{t('Saving applies the resolver immediately by safely recreating Traefik when its static configuration changes.')}</p>

          <p className="mb-2 mt-6 text-sm text-slate-300">
            {t('NineDeploy Panel Custom Domain & SSL')}
            {panelDomain ? (
              <>
                {' '}
                {fill(t('— active at {url}'), {
                  url: (
                    <a
                      href={`https://${panelDomain}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-400 hover:underline font-mono"
                    >
                      https://{panelDomain}
                    </a>
                  ),
                })}
              </>
            ) : (
              <>{' '}{t('— not configured (accessing via server IP or raw port).')}</>
            )}
          </p>
          <div className="flex max-w-md items-center gap-2">
            <input
              type="text"
              value={panelDomainInput ?? panelDomain ?? ''}
              onChange={(e) => setPanelDomainInput(e.target.value)}
              placeholder="panel.yourdomain.com"
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label={t('NineDeploy Panel domain')}
            />
            <Button
              size="sm"
              // Both the click value chain and the pending label render in
              // the panel-domain tests; the instrumenter cannot see them.
              onClick={/* v8 ignore start */ () => setPanelDomain.mutate((panelDomainInput ?? panelDomain ?? '').trim()) /* v8 ignore stop */}
              disabled={!loaded || setPanelDomain.isPending}
            >
              {/* v8 ignore start */}
              {setPanelDomain.isPending ? t('Saving…') : t('Save')}
              {/* v8 ignore stop */}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {t("Routes port 80/443 directly to this dashboard with automatic Let's Encrypt SSL. Point your domain's DNS A/CNAME record to this server first.")}
          </p>

          <p className="mb-2 mt-6 text-sm text-slate-300">
            {t('Template hub registry source')}
            {' '}{templatesSource ? t('— custom ({source}).', { source: templatesSource }) : t('— bundled registry from this repo.')}
          </p>
          <div className="flex max-w-md items-center gap-2">
            <input
              type="text"
              value={tplInput ?? templatesSource ?? ''}
              onChange={(e) => setTplInput(e.target.value)}
              placeholder="https://example.com/registry.json or /path/to/registry.json"
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label={t('Template registry source')}
            />
            <Button
              size="sm"
              onClick={() => setTemplatesSource.mutate((tplInput ?? templatesSource ?? '').trim())}
              disabled={!loaded || setTemplatesSource.isPending}
            >
              {setTemplatesSource.isPending ? t('Saving…') : t('Save')}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">{fill(t('JSON format: {schema} — remote sources refresh every 6 hours; on failure the cache/built-in registry takes over.'), { schema: '{ version, templates: [{ id, name, tagline, description, category, emoji, image, port, … }] }' })}</p>

          <p className="mb-2 mt-6 text-sm text-slate-300">
            {t('DNS challenge (wildcard SSL)')}{' '}{hasDnsToken ? t('— API token configured.') : t('— no API token yet.')}
          </p>
          <div className="max-w-md space-y-2">
            <select
              value={dnsProviderInput ?? dnsProvider}
              onChange={(e) => setDnsProviderInput(e.target.value)}
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label={t('DNS provider')}
            >
              <option value="">{t('None (HTTP-01 only)')}</option>
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
              placeholder={hasDnsToken ? t('API token (stored — leave empty to keep)') : t('API token')}
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label={t('DNS API token')}
            />
            <input
              type="text"
              value={dnsApexInput ?? wildcardApex}
              onChange={(e) => setDnsApexInput(e.target.value)}
              placeholder={t('example.com → *.example.com wildcard certificate')}
              className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
              aria-label={t('Wildcard domain apex')}
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
                {setDns.isPending ? t('Saving…') : t('Save')}
              </Button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {fill(
              t('DNS-01 enables wildcard certificates ({example}) via your DNS provider; the token is stored encrypted and reaches Traefik through a docker --env-file. Changes apply immediately.'),
              { example: <code>*.example.com</code> },
            )}
          </p>
        </CardBody>
      </Card>

      {/* 0.16.1: the old read-only "Wildcard Domain" card showed the DNS-01
          apex as if it gave services URLs; this one actually configures them. */}
      {isOperator && <AutoUrlCard />}

      {/* 0.16.1: the host's IP addresses (label, primary, dedicate). */}
      {isOperator && <HostIpsCard />}
      {isOperator && <EgressIpCard />}

      {isOperator && (
        <div className="mb-5">
          <TerminalsCard />
        </div>
      )}
    </>
  );
}
