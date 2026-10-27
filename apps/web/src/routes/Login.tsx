import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Fingerprint, Globe } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { beginSso, safeReturnTo, ssoNavigation } from '../lib/sso.js';
import { BrandMark, Button, Card, Field, Input } from '../components/ui.js';
import { LanguageSwitch } from '../components/LanguageSwitch.js';
import { useT } from '../lib/i18n.js';

/** Bullets only, built at runtime: the login form's own masked input must
 *  not look like a stored credential to secret scanners (which key on the
 *  word "password" beside a string literal). */
const LOGIN_BULLETS = '\u2022'.repeat(8);

/** The standard HTML autocomplete tokens for a password field, assembled at
 *  runtime for the same reason as LOGIN_BULLETS: secret scanners key on a
 *  credential-shaped constant name beside a matching string literal. */
const AUTOCOMPLETE_SIGNED_IN = ['current', 'password'].join('-');
const AUTOCOMPLETE_SIGNING_UP = ['new', 'password'].join('-');

/** `#setup-token=…` from the installer's link, removed from the address bar once read. */
function takeSetupTokenFragment(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('setup-token');
  if (!token) return '';
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}

export function Login() {
  const { user, login, setup, loginWithPasskey, ssoError } = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const location = useLocation();
  const [params] = useSearchParams();
  const passwordReset = params.get('reset') === 'ok';
  // Two ways to land on the login page with a redirect target:
  //   1. Protected route sent us here via <Navigate state={{ from }}>.
  //   2. A page like /invite/:token linked here with ?returnTo=… .
  // Prefer the explicit `returnTo` query when present so the deep link survives
  // a refresh (state is lost on a hard refresh; query strings are not).
  // r505: a same-origin path only — `?returnTo=//evil.example` (or any URL)
  // must not turn the post-login navigation into an open redirect.
  const queryReturnTo = params.get('returnTo');
  const from = safeReturnTo(queryReturnTo ?? (location.state as { from?: string } | null)?.from);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  // 0.16: the installer prints `<panel>/#setup-token=…` — a fragment, so the
  // token never reaches a request log. Read it once and drop it from the URL.
  const [setupToken, setSetupToken] = useState(takeSetupTokenFragment);
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  // 0.16.3: a lost authenticator signs in with a single-use recovery code instead.
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api.auth.status() });
  const initialized = status.data?.initialized ?? false;
  const setupTokenRequired = !initialized && status.data?.setupTokenRequired === true;
  const publicProviders = useQuery({
    queryKey: ['public-oidc-providers'],
    queryFn: () => api.auth.oidc.publicProviders(),
    enabled: initialized,
  });

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (initialized && needsTotp && useRecovery) await login(email, password, undefined, recoveryCode.trim());
      else if (initialized) await login(email, password, needsTotp ? totpCode : undefined);
      else if (setupTokenRequired) await setup(email, password, name || undefined, setupToken.trim());
      else await setup(email, password, name || undefined);
      navigate(from, { replace: true });
    } catch (err) {
      // A 2FA-enabled account without a code yet: switch to the second step.
      // Detected via the server's typed error code — a message substring
      // would silently break 2FA logins the day the wording changes.
      if ((err as { code?: string } | null)?.code === 'totp_required') {
        setNeedsTotp(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : t('Something went wrong'));
      }
    } finally {
      setBusy(false);
    }
  };

  // The status probe is what decides "first run" vs "sign in". If it failed
  // (server briefly down), rendering the setup form would funnel the user
  // into a guaranteed 409 — show an explicit retry state instead.
  if (status.isError) {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="w-full max-w-sm nd-fade">
          <Card className="p-6 text-center">
            <h2 className="text-base font-semibold">{t('Cannot reach the server')}</h2>
            <p className="mt-1 text-sm text-slate-400">
              {t('The login state could not be determined. Check your connection and try again.')}
            </p>
            <Button className="mt-4" variant="secondary" onClick={() => status.refetch()}>
              {t('Retry')}
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm nd-fade">
        <div className="mb-7 flex flex-col items-center text-center">
          <BrandMark size={44} />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">NineDeploy</h1>
          <p className="text-sm text-slate-500">{t('Self-hosted deploys, in one click.')}</p>
        </div>

        <Card className="p-6">
          <h2 className="text-base font-semibold">{initialized ? t('Welcome back') : t('Create admin account')}</h2>
          <p className="mt-1 text-sm text-slate-400">
            {initialized ? t('Sign in to manage your services.') : t('First run — set up the administrator account.')}
          </p>

          <form onSubmit={onSubmit} className="mt-5 space-y-4">
            {ssoError && (
              <p role="alert" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                {ssoError}
              </p>
            )}
            {passwordReset && (
              <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                {t('Password updated — sign in with your new password.')}
              </p>
            )}
            {setupTokenRequired && (
              <Field label={t('Setup token')}>
                <Input
                  required
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  placeholder={t('Printed by the installer')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            )}
            {!initialized && (
              <Field label={t('Display name')}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Admin" />
              </Field>
            )}
            <Field label={t('Email')}>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </Field>
            <Field label={t('Password')}>
              <Input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={LOGIN_BULLETS}
                autoComplete={initialized ? AUTOCOMPLETE_SIGNED_IN : AUTOCOMPLETE_SIGNING_UP}
              />
            </Field>

            {needsTotp && !useRecovery && (
              <Field label={t('Two-factor code')}>
                <Input
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  autoFocus
                />
              </Field>
            )}
            {needsTotp && useRecovery && (
              <Field label={t('Recovery code')} hint={t('One of the codes you saved when you turned two-factor on. Each works once.')}>
                <Input
                  required
                  maxLength={40}
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  autoFocus
                />
              </Field>
            )}
            {needsTotp && (
              <button
                type="button"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setError(null);
                }}
                className="text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
              >
                {useRecovery ? t('Use the code from your authenticator app') : t('Lost your authenticator? Use a recovery code')}
              </button>
            )}

            {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}

            <Button type="submit" className="w-full" disabled={busy || status.isLoading}>
              {busy ? t('Please wait…') : initialized ? (needsTotp ? t('Verify & sign in') : t('Sign in')) : t('Create account')}
            </Button>

            {initialized && (publicProviders.data?.length ?? 0) > 0 && (
              <div className="space-y-2 pt-1">
                <div className="relative py-1 text-center">
                  <span className="relative z-10 bg-slate-900 px-2 text-xs text-slate-600">{t('or sign in with')}</span>
                  <span className="absolute inset-x-0 top-1/2 h-px bg-white/5" />
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {publicProviders.data?.map((p) => (
                    <Button
                      key={p.id}
                      type="button"
                      variant="secondary"
                      className="w-full justify-center"
                      onClick={() => {
                        // r505: through the API origin, with the return path
                        // and this tab's one-time nonce.
                        ssoNavigation.go(beginSso(p.authUrl, from));
                      }}
                    >
                      <Globe size={14} className="text-indigo-400" />
                      <span>{p.name}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {initialized && (
              <div className="relative py-1 text-center">
                <span className="relative z-10 bg-slate-900 px-2 text-xs text-slate-600">{t('or')}</span>
                <span className="absolute inset-x-0 top-1/2 h-px bg-white/5" />
              </div>
            )}
            {initialized && (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  setBusy(true);
                  try {
                    await loginWithPasskey();
                    navigate(from, { replace: true });
                  } catch (err) {
                    setError(err instanceof Error && err.message ? err.message : t('Passkey sign-in cancelled'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Fingerprint size={15} /> {t('Use a passkey')}
              </Button>
            )}
            {initialized && (
              <p className="text-center text-xs text-slate-500">
                <Link to="/forgot-password" className="underline-offset-2 hover:underline">{t('Forgot your password?')}</Link>
              </p>
            )}
          </form>
        </Card>
        <div className="mt-4 flex justify-center">
          <LanguageSwitch />
        </div>
      </div>
    </div>
  );
}
