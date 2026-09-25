import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Fingerprint, KeyRound, MonitorSmartphone, QrCode, Smartphone } from 'lucide-react';
import { api, setSessionTokens } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { QrCode as QrCodeImage } from '../../components/QrCode.js';
import { Button, Card, CardBody, Skeleton } from '../../components/ui.js';
import { formatDateTime, useCopy } from '../../lib/format.js';

/** Account: self-service password change + two-factor authentication. */
export function AccountSection() {
  const { toast } = useToast();
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNext, setPwNext] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const changePassword = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) => api.auth.changePassword(input),
    onSuccess: (session) => {
      // The endpoint revoked every other session and returned a fresh pair —
      // persist it so the caller stays logged in.
      setSessionTokens(session.tokens.accessToken, session.tokens.refreshToken);
      setPwCurrent('');
      setPwNext('');
      setPwConfirm('');
      toast('Password changed — other sessions signed out', 'success');
    },
    onError: () => toast('Password change failed', 'error'),
  });

  const submitPassword = () => {
    if (pwNext !== pwConfirm) {
      toast('New passwords do not match', 'error');
      return;
    }
    if (pwNext.length < 8) {
      toast('New password must be at least 8 characters', 'error');
      return;
    }
    changePassword.mutate({ currentPassword: pwCurrent, newPassword: pwNext });
  };

  return (
    <>
      <Card className="mb-5">
        <CardBody>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            <KeyRound size={14} /> Account
          </h2>
          <p className="mb-4 text-xs text-slate-500">
            Changing your password signs out every other session of this account.
          </p>
          <div className="grid max-w-md gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">Current password</span>
              <input
                type="password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                autoComplete="current-password"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">New password</span>
              <input
                type="password"
                value={pwNext}
                onChange={(e) => setPwNext(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-500">Confirm new password</span>
              <input
                type="password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <div>
              <Button onClick={submitPassword} disabled={changePassword.isPending || !pwCurrent || !pwNext}>
                {changePassword.isPending ? 'Changing…' : 'Change password'}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <TwoFactorCard />
      <SsoLinkCard />
      <PasskeyCard />
      <SessionsCard />
    </>
  );
}

function SsoLinkCard() {
  const { toast } = useToast();
  const providers = useQuery({
    // r342: same key as Login — SsoSection invalidates this one on save.
    queryKey: ['public-oidc-providers'],
    queryFn: () => api.auth.oidc.publicProviders(),
  });
  const link = useMutation({
    mutationFn: (slug: string) => api.auth.oidc.link(slug),
    onSuccess: ({ authUrl }) => window.location.assign(authUrl),
    onError: (error) => toast(error instanceof Error ? error.message : 'Could not link SSO account', 'error'),
  });

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">Single sign-on</h2>
        <p className="mb-4 text-xs text-slate-500">
          Link your existing account before signing in with an SSO provider. You will continue to the provider to verify your identity.
        </p>
        {providers.isLoading ? <Skeleton className="h-10 w-full" /> : providers.isError ? (
          <p role="alert" className="text-xs text-rose-400">Could not load SSO providers.</p>
        ) : !providers.data?.length ? (
          <p className="text-xs text-slate-500">No SSO providers are configured.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {providers.data.map((provider) => (
              <Button key={provider.id} onClick={() => link.mutate(provider.slug)} disabled={link.isPending}>
                {link.isPending && link.variables === provider.slug ? 'Connecting…' : `Link ${provider.name}`}
              </Button>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── Passkeys (WebAuthn) ────────────────────────────────────────────────────
function PasskeyCard() {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const queryClient = useQueryClient();

  const passkeys = useQuery({ queryKey: ['passkeys'], queryFn: () => api.auth.passkeys.list() });

  const register = useMutation({
    mutationFn: async () => {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const { options } = await api.auth.passkeys.registerOptions();
      const attestation = await startRegistration(JSON.parse(options) as Parameters<typeof startRegistration>[0]);
      return api.auth.passkeys.registerVerify({ name: name || 'Passkey', response: attestation });
    },
    onSuccess: () => {
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      toast('Passkey added', 'success');
    },
    onError: (err) => toast(err instanceof Error && err.message ? `Passkey setup failed: ${err.message}` : 'Passkey setup failed or cancelled', 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.auth.passkeys.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      toast('Passkey removed', 'success');
    },
    onError: () => toast('Could not remove passkey', 'error'),
  });

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Fingerprint size={14} /> Passkeys
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          Sign in with biometrics or a security key — no password needed. The relying party is bound to this
          instance's hostname, so passkeys only work on the URL they were registered on.
        </p>
        <div className="mb-4 flex max-w-md items-end gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-xs text-slate-500">Label</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="MacBook Touch ID"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </label>
          <Button size="sm" onClick={() => register.mutate()} disabled={register.isPending}>
            {register.isPending ? 'Waiting for authenticator…' : 'Add passkey'}
          </Button>
        </div>
        {passkeys.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : !passkeys.data || passkeys.data.length === 0 ? (
          <p className="text-xs text-slate-600">No passkeys registered yet.</p>
        ) : (
          <ul className="space-y-1">
            {passkeys.data.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2 text-xs ring-1 ring-inset ring-white/5"
              >
                <span className="text-slate-300">{p.name}</span>
                <span className="flex items-center gap-3">
                  <span className="text-slate-500">{formatDateTime(p.createdAt)}</span>
                  <button type="button" onClick={() => remove.mutate(p.id)} className="text-rose-400 hover:text-rose-300">
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ── Active sessions ────────────────────────────────────────────────────────
function SessionsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.auth.sessions.list(),
    refetchInterval: 15000,
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.auth.sessions.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      toast('Session revoked', 'success');
    },
    onError: () => toast('Could not revoke session', 'error'),
  });

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <MonitorSmartphone size={14} /> Active sessions
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          Devices holding a valid refresh token for your account. Revoking signs that device out when its
          access token expires (within minutes).
        </p>
        {sessions.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : !sessions.data || sessions.data.length === 0 ? (
          <p className="text-xs text-slate-600">No active sessions.</p>
        ) : (
          <ul className="space-y-1">
            {sessions.data.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 text-xs ring-1 ring-inset ring-white/5"
              >
                <span className="min-w-0">
                  <span className="block truncate text-slate-300">
                    {s.current && <span className="mr-2 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300">this device</span>}
                    {s.ip ?? 'unknown ip'}
                  </span>
                  <span className="block truncate text-slate-600" title={s.userAgent ?? undefined}>
                    {s.userAgent ?? 'unknown client'}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-slate-500">{s.lastUsedAt ? formatDateTime(s.lastUsedAt) : formatDateTime(s.createdAt)}</span>
                  {!s.current && (
                    <button type="button" onClick={() => revoke.mutate(s.id)} className="text-rose-400 hover:text-rose-300">
                      Revoke
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ── Two-factor (TOTP) ─────────────────────────────────────────────────────
function TwoFactorCard() {
  const { toast } = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [showSetupPassword, setShowSetupPassword] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [showDisable, setShowDisable] = useState(false);

  // The server requires the account password when regenerating the secret of
  // an already-enabled 2FA — always offer the field.
  const doSetup = useMutation({
    mutationFn: () => api.auth.twoFactor.setup(setupPassword ? { password: setupPassword } : undefined),
    onSuccess: (res) => {
      setSetup(res);
      setCode('');
      setSetupPassword('');
      setShowSetupPassword(false);
    },
    onError: () => toast(showSetupPassword ? 'Could not start 2FA setup — check your password' : 'Could not start 2FA setup', 'error'),
  });
  const enable = useMutation({
    mutationFn: () => api.auth.twoFactor.enable(code),
    onSuccess: () => {
      setSetup(null);
      setCode('');
      toast('Two-factor authentication enabled', 'success');
    },
    onError: () => toast('Invalid or expired code', 'error'),
  });
  const disable = useMutation({
    mutationFn: () => api.auth.twoFactor.disable({ password: disablePassword, code: disableCode }),
    onSuccess: () => {
      setShowDisable(false);
      setDisablePassword('');
      setDisableCode('');
      setSetup(null);
      toast('Two-factor authentication disabled — you were signed out everywhere', 'info');
      setTimeout(() => window.location.assign('/login'), 1500);
    },
    onError: () => toast('Could not disable 2FA — check your password and code', 'error'),
  });

  const { copy: copyText } = useCopy();
  const copy = async (value: string) => {
    const ok = await copyText(value);
    if (ok) toast('Copied', 'success');
    else toast('Copy failed', 'error');
  };

  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Smartphone size={14} /> Two-factor authentication
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          Require a time-based one-time code (TOTP) from an authenticator app in addition to your password.
        </p>

        {!setup && !showDisable && !showSetupPassword && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setShowSetupPassword(true)} disabled={doSetup.isPending}>
              {doSetup.isPending ? 'Generating…' : 'Set up 2FA'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowDisable(true)}>
              Disable 2FA
            </Button>
          </div>
        )}

        {showSetupPassword && !setup && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (setupPassword) doSetup.mutate();
            }}
            className="flex max-w-md items-end gap-2 rounded-lg border border-slate-700 bg-white/[0.02] p-4"
          >
            <label className="flex-1">
              <span className="mb-1 block text-xs text-slate-400">Confirm your password (required when 2FA is already enabled)</span>
              <input
                type="password"
                value={setupPassword}
                onChange={(e) => setSetupPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
            </label>
            <Button type="submit" size="sm" disabled={!setupPassword || doSetup.isPending}>
              {doSetup.isPending ? 'Generating…' : 'Continue'}
            </Button>
            <button type="button" onClick={() => { setShowSetupPassword(false); setSetupPassword(''); }} className="text-xs text-slate-400 hover:underline">
              Cancel
            </button>
          </form>
        )}

        {setup && (
          <div className="max-w-md space-y-4 rounded-2xl border border-amber-500/30 bg-amber-500/[0.04] p-5">
            <div>
              <p className="text-sm font-semibold text-amber-200 flex items-center gap-1.5">
                <QrCode size={16} /> Scan QR Code with Authenticator
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Scan this QR code with Google Authenticator, 1Password, Bitwarden, or Aegis.
              </p>
            </div>

            {/* Visual QR Code Box. `components/QrCode` owns the rendering —
                this card used to carry a second, hand-rolled copy of the same
                `QRCode.toDataURL` effect while the shared component sat unused
                (and hi-DPI: it renders at 2× the CSS size). */}
            <div className="flex justify-center py-2">
              <QrCodeImage value={setup.otpauthUri} size={176} alt="Two-factor authentication QR code" />
            </div>

            <div className="space-y-2 pt-1">
              <div className="text-[11px] font-medium text-slate-400">Manual Entry Secret Key:</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-black/50 px-2.5 py-2 font-mono text-xs text-amber-200 border border-white/5">
                  {setup.secret}
                </code>
                <Button size="sm" variant="secondary" onClick={() => copy(setup.secret)} className="shrink-0 text-xs">
                  Copy
                </Button>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (code.length === 6) enable.mutate();
              }}
              className="space-y-3 pt-3 border-t border-white/[0.06]"
            >
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-amber-200">
                  Verify with 6-digit Authenticator Code
                </span>
                <div className="flex items-center gap-2">
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    placeholder="123456"
                    className="w-36 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 font-mono text-base tracking-widest text-center text-white outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  />
                  <Button type="submit" size="md" disabled={code.length !== 6 || enable.isPending}>
                    {enable.isPending ? 'Verifying…' : 'Enable 2FA'}
                  </Button>
                </div>
              </label>
              <div>
                <button
                  type="button"
                  onClick={() => setSetup(null)}
                  className="text-xs text-slate-400 hover:text-slate-200 hover:underline"
                >
                  Cancel setup
                </button>
              </div>
            </form>
          </div>
        )}

        {showDisable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (disablePassword && disableCode.length === 6) disable.mutate();
            }}
            className="grid max-w-md gap-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.05] p-4"
          >
            <p className="text-xs text-rose-200">Confirm with your password and a current 2FA code.</p>
            <input
              type="password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <input
              type="text"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6-digit code"
              inputMode="numeric"
              className="w-36 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 font-mono text-sm outline-none focus:border-indigo-500"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="danger" disabled={!disablePassword || disableCode.length !== 6 || disable.isPending}>
                {disable.isPending ? 'Disabling…' : 'Disable 2FA'}
              </Button>
              <button type="button" onClick={() => setShowDisable(false)} className="text-xs text-slate-400 hover:underline">
                Cancel
              </button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
