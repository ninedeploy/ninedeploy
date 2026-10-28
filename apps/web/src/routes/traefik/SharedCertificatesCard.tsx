import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Card, CardBody, Switch } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Traefik → Certificates (G5.7, operator): give node proxies the panel's
 * own ACME certificates for the hosts they route, instead of each node
 * requesting its own. Off by default, because it copies private keys.
 */
export function SharedCertificatesCard() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['shared-certificates'], queryFn: () => api.traefik.sharedCertificates.get() });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.traefik.sharedCertificates.set(enabled),
    onSuccess: (view) => {
      qc.setQueryData(['shared-certificates'], view);
      toast(view.enabled ? t('Node proxies now get the panel certificates') : t('Node proxies request their own certificates again'), 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  if (!q.data) return null;
  return (
    <Card>
      <CardBody className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-slate-200">
            <Share2 size={15} className="text-sky-300" /> {t('Share panel certificates with nodes')}
          </div>
          <Switch checked={q.data.enabled} onChange={(on) => save.mutate(on)} disabled={save.isPending} label={t('Share panel certificates with nodes')} />
        </div>
        <p className="text-xs text-slate-400">
          {t(
            "Node proxies get the panel's Let's Encrypt certificates, a DNS-01 wildcard included, for the hosts they route, instead of each requesting its own. A domain served by several nodes then has one certificate everywhere. Renewals reach the nodes within the hour; an uploaded certificate still wins.",
          )}
        </p>
        <p className="text-xs text-amber-300">{t('This copies those certificates’ private keys to the nodes that route the hosts.')}</p>
      </CardBody>
    </Card>
  );
}
