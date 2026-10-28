import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Split } from 'lucide-react';
import type { ComposeRouteView, ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Input, Select } from '../../components/ui.js';

/**
 * Service → Settings (G2.1): send a domain of a compose stack to another
 * service of the stack instead of the main one. The next deploy also sets
 * `SERVICE_FQDN_<SERVICE>` and `SERVICE_URL_<SERVICE>`.
 */
export function ComposeRoutesCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const isStack = svc.type === 'compose';
  const domains = useQuery({ queryKey: ['domains', svc.id], queryFn: () => api.domains.list(svc.id), enabled: isStack, retry: false });
  const rows = (domains.data ?? []).filter((d) => d.status === 'active');
  if (!isStack || rows.length === 0) return null;

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-slate-300">
          <Split size={15} className="text-slate-500" /> {t('Domains per compose service')}
        </div>
        <p className="text-xs text-slate-500">
          {t('Each domain routes to the main service unless you pick another one here. The service must be on the stack’s default network. The next deploy sets SERVICE_FQDN_<SERVICE> and SERVICE_URL_<SERVICE> for it.')}
        </p>
        {rows.map((d) => (
          <RouteRow key={d.id} domainId={d.id} hostname={`${d.hostname}${d.path && d.path !== '/' ? d.path : ''}`} mainService={svc.composeService ?? null} />
        ))}
      </CardBody>
    </Card>
  );
}

function RouteRow({ domainId, hostname, mainService }: { domainId: number; hostname: string; mainService: string | null }) {
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

  return (
    <div className="flex flex-wrap items-center gap-2 rounded bg-black/20 px-2 py-1.5">
      <span className="min-w-40 flex-1 font-mono text-xs text-slate-300">{hostname}</span>
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
      <Button size="sm" variant="secondary" onClick={() => save.mutate(service === '' ? null : { service, port: Number(port) })} disabled={!valid || save.isPending}>
        {t('Save')}
      </Button>
    </div>
  );
}
