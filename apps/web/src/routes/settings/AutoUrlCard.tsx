import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Globe, Link2, Radar, Zap } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ErrorCard, cn } from '../../components/ui.js';
import { fill, msg, useT } from '../../lib/i18n.js';

type Mode = 'off' | 'domain' | 'sslip';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const DOMAIN = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/;

const MODES: { id: Mode; title: string; hint: string; icon: typeof Globe }[] = [
  { id: 'sslip', title: msg('Free test URLs'), hint: msg('my-app.<server-ip>.sslip.io — no DNS needed'), icon: Zap },
  { id: 'domain', title: msg('Your wildcard domain'), hint: msg('my-app.apps.example.com — HTTPS with ACME'), icon: Globe },
  { id: 'off', title: msg('Off'), hint: msg('Services get only the domains you add'), icon: Link2 },
];

/**
 * Settings → Automatic URLs (0.16.1). Replaces the old read-only "Wildcard
 * Domain" card, which showed the DNS-01 certificate apex as if it gave
 * services URLs — only NINEDEPLOY_WILDCARD_DOMAIN ever did.
 */
export function AutoUrlCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const q = useQuery({ queryKey: ['auto-url'], queryFn: () => api.settings.autoUrl.get() });
  const [mode, setMode] = useState<Mode | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [ip, setIp] = useState<string | null>(null);

  const data = q.data;
  const stored = data?.stored;
  const currentMode: Mode = mode ?? (stored?.mode === 'domain' || stored?.mode === 'sslip' ? stored.mode : 'off');
  const currentDomain = domain ?? stored?.domain ?? '';
  const currentIp = ip ?? stored?.ip ?? data?.suggestedIp ?? '';
  const envLocked = !!data?.envWildcard;

  const save = useMutation({
    mutationFn: () =>
      api.settings.autoUrl.set({
        mode: currentMode,
        ...(currentMode === 'domain' ? { domain: currentDomain.trim().replace(/^\*\./, '') } : {}),
        ...(currentMode === 'sslip' ? { ip: currentIp.trim() } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['auto-url'] });
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      setMode(null);
      setDomain(null);
      setIp(null);
      toast(
        currentMode === 'off'
          ? t('Automatic URLs turned off')
          : t('Automatic URLs saved — each service gets one on its next deploy, or now via Generate on its Network tab'),
        'success',
      );
    },
    onError: (err: Error) => toast(t('Could not save: {error}', { error: err.message }), 'error'),
  });

  const detect = useMutation({
    mutationFn: () => api.settings.autoUrl.detectIp(),
    onSuccess: (res) => {
      setIp(res.ip);
      toast(res.public ? t('Detected public IP {ip}', { ip: res.ip }) : t('Detected {ip}, which is not a public address', { ip: res.ip }), res.public ? 'success' : 'info');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const valid =
    currentMode === 'off' || (currentMode === 'domain' ? DOMAIN.test(currentDomain.trim().replace(/^\*\./, '')) : IPV4.test(currentIp.trim()));
  const example =
    currentMode === 'sslip' && IPV4.test(currentIp.trim())
      ? `http://my-app.${currentIp.trim()}.sslip.io`
      : currentMode === 'domain' && currentDomain.trim()
        ? `https://my-app.${currentDomain.trim().replace(/^\*\./, '')}`
        : null;

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Link2 size={14} /> {t('Automatic URLs')}
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          {t('Give every service a URL of its own the moment it deploys, before you set up any domain.')}
        </p>
        {q.isError && <ErrorCard title={t('Could not load the automatic URL settings')} error={q.error} onRetry={() => void q.refetch()} />}
        {envLocked ? (
          <div className="rounded-lg bg-white/[0.02] px-3 py-2.5 text-xs text-slate-400 ring-1 ring-inset ring-white/5">
            {fill(t('Set by {variable}: services get {url}. Remove the variable and restart to choose here.'), {
              variable: <code className="text-slate-300">NINEDEPLOY_WILDCARD_DOMAIN</code>,
              url: <code className="text-emerald-300">my-app.{data?.envWildcard}</code>,
            })}
          </div>
        ) : (
          <>
            <div role="radiogroup" aria-label={t('Automatic URL mode')} className="grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-3">
              {MODES.map((m) => {
                const Icon = m.icon;
                const active = currentMode === m.id;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a card-style choice with a title, hint and icon; role=radio inside a radiogroup gives it the same semantics as <input type="radio">.
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={!data}
                    onClick={() => setMode(m.id)}
                    className={cn(
                      'rounded-xl border p-3 text-left transition disabled:opacity-50',
                      active ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.05]',
                    )}
                  >
                    <Icon size={15} className={active ? 'text-indigo-300' : 'text-slate-500'} />
                    <div className="mt-1.5 text-sm font-medium text-slate-200">{t(m.title)}</div>
                    <div className="text-[11px] text-slate-500">{t(m.hint)}</div>
                  </button>
                );
              })}
            </div>

            {currentMode === 'sslip' && (
              <div className="mt-4 max-w-md space-y-1.5">
                <span className="block text-xs font-medium text-slate-400">{t('Server IPv4 the names resolve to')}</span>
                <div className="flex items-center gap-2">
                  <input
                    value={currentIp}
                    onChange={(e) => setIp(e.target.value)}
                    placeholder="203.0.113.10"
                    aria-label={t('Server IP address')}
                    className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
                  />
                  <Button size="sm" variant="secondary" onClick={() => detect.mutate()} disabled={detect.isPending}>
                    <Radar size={13} /> {detect.isPending ? t('Detecting…') : t('Detect')}
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  {fill(
                    t("sslip.io answers {pattern} with that address, so the URL works as soon as port 80 is open. Plain HTTP — meant for testing; add your own domain for production. Services on a node use the node's address."),
                    { pattern: <code>*.{'<ip>'}.sslip.io</code> },
                  )}
                </p>
              </div>
            )}

            {currentMode === 'domain' && (
              <div className="mt-4 max-w-md space-y-1.5">
                <span className="block text-xs font-medium text-slate-400">{t('Base domain')}</span>
                <input
                  value={currentDomain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="apps.example.com"
                  aria-label={t('Base domain')}
                  className="h-9 w-full rounded-lg border border-slate-800 bg-slate-900/40 px-3 font-mono text-xs text-slate-200 outline-none focus:border-indigo-500/60"
                />
                <p className="text-[11px] leading-relaxed text-slate-500">
                  {fill(
                    t('Point a wildcard DNS record {record} at this server. With an ACME email set, each URL gets its own certificate — or one wildcard certificate via the DNS challenge above.'),
                    { record: <code>*.{currentDomain.trim().replace(/^\*\./, '') || 'apps.example.com'}</code> },
                  )}
                </p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={() => save.mutate()} disabled={!data || !valid || save.isPending}>
                {save.isPending ? t('Saving…') : t('Save')}
              </Button>
              {example && (
                <span className="text-xs text-slate-500">
                  {fill(t('Example: {url}'), { url: <code className="text-emerald-300">{example}</code> })}
                </span>
              )}
              {data && data.effective.mode !== 'off' && mode === null && (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                  {t('active')}
                </span>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
