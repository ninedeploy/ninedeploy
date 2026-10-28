import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import type { WorkspaceTwoFactorView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { useToast } from '../../components/Toast.js';
import { Card, CardBody, Switch } from '../../components/ui.js';

/**
 * Workspaces, G1.4 (workspace admin): require TOTP or a passkey of every
 * member. A member without one is held to the enrolment screen on their next
 * request. Optionally, SSO sign-ins are exempt.
 */
export function TwoFactorPolicyCard({ workspaceId }: { workspaceId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['workspace-2fa', workspaceId], queryFn: () => api.workspaces.twoFactor.get(workspaceId), retry: false });
  const save = useMutation({
    mutationFn: (input: { required: boolean; ssoExempt: boolean }) => api.workspaces.twoFactor.set(workspaceId, input),
    onSuccess: (view: WorkspaceTwoFactorView) => {
      qc.setQueryData(['workspace-2fa', workspaceId], view);
      toast(view.required ? t('Two-factor authentication is now required in this workspace') : t('Two-factor authentication is no longer required'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (q.isError || !q.data) return null;
  const { required, ssoExempt, membersWithout } = q.data;

  return (
    <Card className="mt-6">
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
            <ShieldCheck size={14} /> {t('Require two-factor authentication')}
          </h2>
          <Switch
            checked={required}
            onChange={(on) => save.mutate({ required: on, ssoExempt })}
            disabled={save.isPending}
            label={t('Require two-factor authentication')}
          />
        </div>
        <p className="text-xs text-slate-500">
          {t('Members without an authenticator app or a passkey must set one up before they can use the panel. API tokens they already have keep working. You need two-factor authentication on your own account to turn this on.')}
        </p>
        {required && (
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={ssoExempt}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ required: true, ssoExempt: e.target.checked })}
            />
            {t('Exempt SSO sign-ins (your identity provider enforces MFA)')}
          </label>
        )}
        <p className="text-xs text-slate-400">{t('{n} members have no second factor yet', { n: membersWithout })}</p>
      </CardBody>
    </Card>
  );
}
