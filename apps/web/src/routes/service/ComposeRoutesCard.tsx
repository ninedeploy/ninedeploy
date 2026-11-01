import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ComposeRouteView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Input, Select } from '../../components/ui.js';

/**
 * G2.1, in a compose stack's domain row on the Network tab: send the domain to
 * another service of the stack instead of the main one. The next deploy also
 * sets `SERVICE_FQDN_<SERVICE>` and `SERVICE_URL_<SERVICE>`.
 */
export function ComposeRouteRow({ domainId, hostname, mainService }: { domainId: number; hostname: string; mainService: string | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['compose-route', domainId], queryFn: () => api.domains.composeRoute.get(domainId), retry: false });
  const [service, setService] = useState('');
  const [port, setPort] = useState('');
  useEffect(() => {
    if (!q.data) return;
    setService(q.data.route?.service ?? '');
    setPort(q.data.route ? String(q.data.route.port) : '');
  }, [q.data]);
  const save = useMutation({
    mutationFn: (route: { service: string; port: number } | null) => api.domains.composeRoute.set(domainId, route),
    onSuccess: (view: ComposeRouteView) => {
      qc.setQueryData(['compose-route', domainId], view);
      toast(view.route ? t('{host} routes to {service}', { host: hostname, service: view.route.service }) : t('{host} routes to the main service', { host: hostname }), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (!q.data) return null;
  const valid = service === '' || (/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service) && /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535);
  const saved = q.data.route ? `${q.data.route.service}:${q.data.route.port}` : '';
  const changed = (service === '' ? '' : `${service}:${port}`) !== saved;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-white/5 px-3 py-2 text-xs">
      <span className="text-slate-500">{t('Routes to')}</span>
      {q.data.services ? (
        <Select value={service} onChange={(e) => setService(e.target.value)} className="h-8 text-xs" aria-label={t('Service for {host}', { host: hostname })}>
          <option value="">{mainService ? t('Main service ({name})', { name: mainService }) : t('Main service')}</option>
          {q.data.services.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      ) : (
        <Input value={service} onChange={(e) => setService(e.target.value)} placeholder={t('Main service')} className="h-8 w-36 font-mono text-xs" aria-label={t('Service for {host}', { host: hostname })} />
      )}
      {service !== '' && (
        <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder={t('Port')} className="h-8 w-20 font-mono text-xs" aria-label={t('Port for {host}', { host: hostname })} />
      )}
      {changed && (
        <Button size="sm" variant="secondary" onClick={() => save.mutate(service === '' ? null : { service, port: Number(port) })} disabled={!valid || save.isPending}>
          {t('Save')}
        </Button>
      )}
    </div>
  );
}
