import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitCommitHorizontal } from 'lucide-react';
import type { ServiceCommitStatusView, ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Card, CardBody, Switch } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

const PROVIDER_NAME: Record<NonNullable<ServiceCommitStatusView['provider']>, string> = { gitlab: 'GitLab', gitea: 'Gitea', bitbucket: 'Bitbucket' };

/**
 * ROADMAP 0.16.8 item 8: commit statuses on GitLab, Gitea and Bitbucket for a
 * service that clones through a token source of that type. Shown only when
 * the source is one of those (GitHub reports through the GitHub App).
 */
export function CommitStatusCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['commit-status', svc.id], queryFn: () => api.services.commitStatus.get(svc.id), retry: false });
  const set = useMutation({
    mutationFn: (enabled: boolean) => api.services.commitStatus.set(svc.id, enabled),
    onSuccess: (data) => {
      qc.setQueryData(['commit-status', svc.id], data);
      toast(data.enabled ? t('Commit statuses on') : t('Commit statuses off'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  if (status.isError || !status.data?.provider) return null;
  const { enabled, provider, unavailable } = status.data;
  const name = PROVIDER_NAME[provider];

  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <GitCommitHorizontal size={15} className="text-slate-500" /> {t('Commit statuses on {provider}', { provider: name })}
          </div>
          <Switch
            checked={enabled}
            onChange={(on) => set.mutate(on)}
            disabled={set.isPending || (!enabled && unavailable !== null)}
            label={t('Commit statuses on {provider}', { provider: name })}
          />
        </div>
        <p className="text-xs text-slate-500">
          {t('Each deploy marks its commit as deploying, then deployed, failed or cancelled (ninedeploy/{slug}), with the source token. A failed status never fails the deploy.', { slug: svc.slug })}
        </p>
        {unavailable && <p className="text-xs text-amber-300">{unavailable}</p>}
      </CardBody>
    </Card>
  );
}
