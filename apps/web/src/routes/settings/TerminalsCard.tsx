import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, SquareTerminal } from 'lucide-react';
import type { TerminalSettingsInput, TerminalSettingsView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ErrorCard, Field, Input, Modal, Switch } from '../../components/ui.js';
import { msg, useT } from '../../lib/i18n.js';

const LIMITS = [
  { key: 'idleTimeoutMinutes', label: msg('Idle timeout (minutes)'), min: 1, max: 240, hint: msg('No input for this long closes the session.') },
  { key: 'maxSessionMinutes', label: msg('Maximum session (minutes)'), min: 5, max: 1440, hint: msg('A hard cap on any one session.') },
  { key: 'maxConcurrent', label: msg('Open terminals on this panel'), min: 1, max: 50, hint: msg('Each user may also hold at most 3.') },
  { key: 'retentionDays', label: msg('Keep session history (days)'), min: 30, max: 3650, hint: msg('Metadata only: no transcript is recorded.') },
] as const;

type LimitKey = (typeof LIMITS)[number]['key'];

/**
 * Settings → Security → Terminals (operator only, 0.15): the host-shell switch
 * (off by default; turning it on needs a password re-check), the session
 * limits and the history retention. `NINEDEPLOY_HOST_TERMINAL=off` on the
 * panel forbids host shells whatever the switch says.
 */
export function TerminalsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const settings = useQuery({ queryKey: ['terminal-settings'], queryFn: () => api.terminals.settings.get() });
  const [draft, setDraft] = useState<Partial<Record<LimitKey, string>>>({});
  const [confirmHost, setConfirmHost] = useState(false);
  const [password, setPassword] = useState('');

  const save = useMutation({
    mutationFn: (input: TerminalSettingsInput) => api.terminals.settings.set(input),
    onSuccess: (view: TerminalSettingsView) => {
      qc.setQueryData(['terminal-settings'], view);
      setDraft({});
      setConfirmHost(false);
      setPassword('');
      toast(t('Terminal settings saved'), 'success');
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : t('Could not save the terminal settings'), 'error'),
  });

  if (settings.isError) return <ErrorCard title={t("Couldn't load the terminal settings")} error={settings.error} onRetry={() => settings.refetch()} />;
  const view = settings.data;

  const saveLimits = (e: FormEvent) => {
    e.preventDefault();
    const input: TerminalSettingsInput = {};
    for (const { key } of LIMITS) {
      const raw = draft[key];
      if (raw !== undefined && raw.trim() !== '') input[key] = Number(raw);
    }
    save.mutate(input);
  };

  const enableHost = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ hostTerminalEnabled: true, ...(password ? { password } : {}) });
  };

  return (
    <Card>
      <CardBody className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <SquareTerminal size={15} className="text-slate-500" /> {t('Terminals')}
          </div>
          <Link to="/terminals" className="text-xs text-indigo-400 hover:text-indigo-300">
            {t('Terminal sessions →')}
          </Link>
        </div>
        <p className="text-xs text-slate-500">
          {t('Operators can open shells into service, database and managed containers. Sessions record who, what, when and how many bytes, never what was typed or shown.')}
        </p>

        {!view ? (
          <p className="text-xs text-slate-500">{t('Loading…')}</p>
        ) : (
          <>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm text-slate-200">
                    {t('Host shells')}
                    {view.hostTerminalForbiddenByEnv ? (
                      <Badge tone="rose">{t('forbidden by {setting}', { setting: 'NINEDEPLOY_HOST_TERMINAL=off' })}</Badge>
                    ) : view.hostTerminalEnabled ? (
                      <Badge tone="amber">{t('enabled')}</Badge>
                    ) : (
                      <Badge>{t('off')}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {t('A root shell on the panel host or a node (from the Servers page). Every session asks for your password again.')}
                  </p>
                </div>
                <Switch
                  label={t('Host shells')}
                  checked={view.hostTerminalEnabled}
                  disabled={save.isPending || (view.hostTerminalForbiddenByEnv && !view.hostTerminalEnabled)}
                  onChange={(on) => (on ? setConfirmHost(true) : save.mutate({ hostTerminalEnabled: false }))}
                />
              </div>
            </div>

            <form onSubmit={saveLimits} className="grid gap-4 sm:grid-cols-2">
              {LIMITS.map((l) => (
                <Field key={l.key} label={t(l.label)} hint={t(l.hint)}>
                  <Input
                    type="number"
                    min={l.min}
                    max={l.max}
                    aria-label={t(l.label)}
                    value={draft[l.key] ?? String(view[l.key])}
                    onChange={(e) => setDraft((d) => ({ ...d, [l.key]: e.target.value }))}
                  />
                </Field>
              ))}
              <div className="sm:col-span-2">
                <Button type="submit" size="sm" disabled={save.isPending || Object.keys(draft).length === 0}>
                  {t('Save limits')}
                </Button>
              </div>
            </form>
          </>
        )}
      </CardBody>

      {confirmHost && (
        <Modal title={t('Enable host shells?')} onClose={() => setConfirmHost(false)}>
          <form onSubmit={enableHost} className="space-y-4">
            <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <p>
                {t('A host shell is an interactive root shell on the server. A stolen operator browser session could then open one in a single click. Every session asks for the password again, is audited and sends a security notification. Node owners can still refuse with NINEDEPLOY_AGENT_HOST_TERMINAL=off.')}
              </p>
            </div>
            <Field label={t('Your password')} hint={t('Accounts that sign in only through SSO: leave it empty within 10 minutes of signing in.')}>
              <Input type="password" aria-label={t('Your password')} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setConfirmHost(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" variant="danger" disabled={save.isPending}>
                {t('Enable host shells')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}
