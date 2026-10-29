import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Truck } from 'lucide-react';
import type { ServiceDetail, ServiceMoveView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Select } from '../../components/ui.js';

/**
 * Service → Settings (G3.1): move a stopped docker service to another host
 * together with its data volume. Operators only; the plain Target node card
 * moves the configuration alone.
 */
export function MoveWithDataCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const compose = svc.type === 'compose';
  const eligible = user?.isOperator === true && svc.orchestrator !== 'swarm' && ((svc.type === 'docker' && !!svc.volumeMount) || compose);
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api.servers.list(), enabled: eligible });
  const move = useQuery({
    queryKey: ['service-move', svc.id],
    queryFn: () => api.services.move.get(svc.id),
    enabled: eligible,
    retry: false,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 2000 : false),
  });
  const [target, setTarget] = useState('');
  const start = useMutation({
    mutationFn: () => api.services.move.start(svc.id, target === 'panel' ? null : Number(target)),
    onSuccess: (view: ServiceMoveView) => {
      qc.setQueryData(['service-move', svc.id], view);
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      toast(t('Moving the service with its data'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (!eligible || !move.data) return null;
  const view = move.data;
  const hostName = (id: number | null) => (id == null ? t('this panel host') : (servers.data?.find((s) => s.id === id)?.name ?? t('node #{id}', { id })));
  const current = svc.serverId ?? null;
  const options = [...(current != null ? [{ value: 'panel', label: t('this panel host') }] : []), ...(servers.data ?? []).filter((s) => s.id !== current).map((s) => ({ value: String(s.id), label: s.name }))];

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-slate-300">
          <Truck size={15} className="text-slate-500" /> {t('Move with data')}
        </div>
        <p className="text-xs text-slate-500">
          {compose
            ? t('Moves the stack to another host and copies every named volume compose made for it, then deploys it. Stop the stack first; the volumes on the old host are kept until you remove them. Bind mounts and external volumes are not moved.')
            : t('Moves the service to another host and copies its data volume there, then deploys it. Stop the service first; the volume on the old host is kept until you remove it.')}
        </p>
        {view.state !== 'none' && (
          <p className="text-xs text-slate-400" role="status">
            {view.state === 'running'
              ? t('Moving from {from} to {to}: {step}', { from: hostName(view.from), to: hostName(view.to), step:
                    view.step === 'deploying'
                      ? t('deploying')
                      : (view.volumes?.length ?? 0) > 1
                        ? t('copying the data ({copied} of {total} volumes)', { copied: view.copied ?? 0, total: view.volumes!.length })
                        : t('copying the data'),
                })
              : view.state === 'done'
                ? t('Moved from {from} to {to}.', { from: hostName(view.from), to: hostName(view.to) })
                : t('The move to {to} failed: {error}', { to: hostName(view.to), error: view.error ?? '' })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('Move to')} className="max-w-xs">
            <option value="">{t('Choose a host…')}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button size="sm" onClick={() => start.mutate()} disabled={!target || start.isPending || view.state === 'running' || svc.status !== 'stopped'}>
            {t('Move')}
          </Button>
        </div>
        {svc.status !== 'stopped' && <p className="text-xs text-slate-500">{t('Stop the service to move it with its data.')}</p>}
      </CardBody>
    </Card>
  );
}
