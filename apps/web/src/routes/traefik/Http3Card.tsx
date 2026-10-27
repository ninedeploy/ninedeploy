import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Zap } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Card, CardBody, ConfirmDialog, Switch } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

/**
 * Traefik → Overview, 0.16.1 (operator only): HTTP/3. Traefik has always
 * declared HTTP/3 on 443, but QUIC needs 443/udp published, which is off
 * until an operator turns it on. Switching recreates Traefik once (about a
 * second of refused connections); the panel may be served through Traefik,
 * so a lost answer re-reads the switch instead of guessing.
 */
export function Http3Card() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const state = useQuery({ queryKey: ['traefik-http3'], queryFn: () => api.traefik.http3.get() });

  const save = useMutation({
    mutationFn: (enabled: boolean) => api.traefik.http3.set(enabled),
    onSuccess: (view) => {
      qc.setQueryData(['traefik-http3'], view);
      toast(view.enabled ? t('HTTP/3 on: Traefik now listens on 443/udp') : t('HTTP/3 off: 443/udp closed'), 'success');
    },
    onError: (err: unknown) => {
      const status = (err as { status?: number } | null)?.status;
      void qc.invalidateQueries({ queryKey: ['traefik-http3'] });
      toast(
        status ? (err as Error).message : t('The proxy restarted before the panel could answer; re-reading the setting.'),
        status ? 'error' : 'info',
      );
    },
    onSettled: () => setConfirm(null),
  });

  if (!state.data) return null;
  return (
    <Card className="mt-6">
      <CardBody className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <Zap size={15} className="text-slate-500" /> HTTP/3 (QUIC)
          </div>
          <p className="mt-1 max-w-2xl text-xs text-slate-500">
            {t("Publishes 443/udp so browsers can reach your domains over HTTP/3. Open UDP 443 in the cloud provider's firewall too. Nodes keep their proxy as it is. Off by default.")}
          </p>
        </div>
        <Switch label="HTTP/3" checked={state.data.enabled} disabled={save.isPending} onChange={(on) => setConfirm(on)} />
      </CardBody>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? t('Turn HTTP/3 on?') : t('Turn HTTP/3 off?')}
        message={t('Traefik is recreated with the new port list: about a second of refused connections on every domain.')}
        confirmLabel={confirm ? t('Turn on') : t('Turn off')}
        onConfirm={() => save.mutate(confirm === true)}
        onClose={() => setConfirm(null)}
      />
    </Card>
  );
}
