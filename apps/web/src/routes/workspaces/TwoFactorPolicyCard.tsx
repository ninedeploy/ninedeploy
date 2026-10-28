import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import type { WorkspaceTwoFactorView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Card, CardBody, Switch } from '../../components/ui.js';

/**
 * Workspaces, G1.4 (workspace admin): require every member's session to
 * prove a second factor (an authenticator code or a passkey). Other sessions
 * are held to the enrolment screen. Sessions from the SSO providers ticked
 * here are exempt, for an IdP that enforces MFA itself; GitHub sign-ins never
 * are.
 */
export function TwoFactorPolicyCard({ workspaceId }: { workspaceId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['workspace-2fa', workspaceId], queryFn: () => api.workspaces.twoFactor.get(workspaceId), retry: false });
  const providers = useQuery({ queryKey: ['oidc-public-providers'], queryFn: () => api.auth.oidc.publicProviders(), retry: false });
  const save = useMutation({
    mutationFn: (input: { required: boolean; ssoExemptProviders: string[] }) => api.workspaces.twoFactor.set(workspaceId, input),
    onSuccess: (view: WorkspaceTwoFactorView, input) => {
      const wasRequired = q.data?.required === true;
      qc.setQueryData(['workspace-2fa', workspaceId], view);
      if (wasRequired !== input.required) {
        toast(view.required ? t('Two-factor authentication is now required in this workspace') : t('Two-factor authentication is no longer required'), 'success');
      }
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (q.isError || !q.data) return null;
  const { required, ssoExemptProviders, membersWithout } = q.data;
  const oidc = (providers.data ?? []).filter((p) => !p.slug.includes('github'));
  const toggleProvider = (ref: string, on: boolean) =>
    save.mutate({ required: true, ssoExemptProviders: on ? [...ssoExemptProviders, ref] : ssoExemptProviders.filter((p) => p !== ref) });

  return (
    <Card className="mt-6">
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
            <ShieldCheck size={14} /> {t('Require two-factor authentication')}
          </h2>
          <Switch
            checked={required}
            onChange={(on) => save.mutate({ required: on, ssoExemptProviders })}
            disabled={save.isPending}
            label={t('Require two-factor authentication')}
          />
        </div>
        <p className="text-xs text-slate-500">
          {t('Members must sign in with an authenticator code or a passkey. A member without one sets it up first; a member who signed in with only a password signs in again. API tokens they already have keep working. Your own session must pass it to turn this on.')}
        </p>
        {required && oidc.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-slate-400">{t('Exempt sign-ins through these SSO providers (they enforce MFA themselves):')}</p>
            {oidc.map((p) => {
              const ref = `oidc:${p.id}`;
              return (
                <label key={p.id} className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={ssoExemptProviders.includes(ref)}
                    disabled={save.isPending}
                    onChange={(e) => toggleProvider(ref, e.target.checked)}
                  />
                  {p.name}
                </label>
              );
            })}
          </div>
        )}
        <p className="text-xs text-slate-400">{t('{n} members have no second factor yet', { n: membersWithout })}</p>
      </CardBody>
    </Card>
  );
}
