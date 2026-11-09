import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import type { UpdateChannel } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Card, CardBody, Field, Select } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

/**
 * Settings → System (operator): which releases the panel offers (A6). Every
 * release is the default, as before; the stable channel offers a release only
 * once it has been out for seven days, or at once when it fixes a security issue.
 */
export function UpdateChannelCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['update-channel'], queryFn: () => api.system.updateChannel.get() });
  const save = useMutation({
    mutationFn: (channel: UpdateChannel) => api.system.updateChannel.set(channel),
    onSuccess: (res) => {
      qc.setQueryData(['update-channel'], { channel: res.channel });
      qc.setQueryData(['update-check'], res.check);
      toast(res.channel === 'stable' ? t('The panel now follows the stable channel') : t('The panel now offers every release'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (!q.data) return null;
  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <GitBranch size={14} /> {t('Update channel')}
        </h2>
        <Field
          label={t('Offer updates from')}
          hint={t('Stable offers a release once it has been out for seven days without a known regression, or at once when it fixes a security issue. Every release offers each patch as soon as it is published.')}
        >
          <Select value={q.data.channel} disabled={save.isPending} onChange={(e) => save.mutate(e.target.value as UpdateChannel)} aria-label={t('Offer updates from')}>
            <option value="release">{t('Every release')}</option>
            <option value="stable">{t('Stable (7 days)')}</option>
          </Select>
        </Field>
      </CardBody>
    </Card>
  );
}
