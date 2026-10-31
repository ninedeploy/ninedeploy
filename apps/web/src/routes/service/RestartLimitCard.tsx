import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Field, Input, Switch } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Service → Settings (G1.3): stop a docker service on the panel host, or a PM2
 * service, whose containers or processes keep restarting, and notify. Off by default.
 */
export function RestartLimitCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  // G1.3: docker services on the panel host and PM2 services.
  const limitable = svc.type === 'docker' || svc.type === 'pm2';
  const q = useQuery({ queryKey: ['restart-limit', svc.id], queryFn: () => api.services.restartLimit.get(svc.id), enabled: limitable });
  const [on, setOn] = useState(false);
  const [max, setMax] = useState('5');
  const [minutes, setMinutes] = useState('10');
  useEffect(() => {
    if (!q.data) return;
    setOn(q.data.limit !== null);
    if (q.data.limit) {
      setMax(String(q.data.limit.maxRestarts));
      setMinutes(String(q.data.limit.windowMinutes));
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.services.restartLimit.set(svc.id, on ? { maxRestarts: Number(max), windowMinutes: Number(minutes) } : null),
    onSuccess: (view) => {
      qc.setQueryData(['restart-limit', svc.id], view);
      toast(view.limit ? t('Restart-loop limit saved') : t('Restart-loop limit turned off'), 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  if (!limitable || !q.data) return null;
  const valid = !on || (/^\d+$/.test(max) && Number(max) >= 2 && Number(max) <= 100 && /^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 1440);

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-slate-300">
            <RotateCcw size={15} className="text-slate-500" /> {t('Restart-loop limit')}
          </div>
          <Switch checked={on} onChange={setOn} label={t('Restart-loop limit')} />
        </div>
        <p className="text-xs text-slate-500">
          {t('Stops the service, as the Stop button does, when its containers or PM2 processes restart this many times within the window, and notifies. A deploy in progress is left alone. Docker services on the panel host and PM2 services.')}
        </p>
        {on && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Restarts')} hint={t('2–100')}>
              <Input value={max} onChange={(e) => setMax(e.target.value)} inputMode="numeric" className="h-9 font-mono text-xs" />
            </Field>
            <Field label={t('Within (minutes)')} hint={t('1–1440')}>
              <Input value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" className="h-9 font-mono text-xs" />
            </Field>
          </div>
        )}
        {q.data.limit && (
          <p className="text-xs text-slate-400">
            {t('{n} restarts in the window now', { n: q.data.recentRestarts })}
            {q.data.trippedAt ? ` · ${t('last stopped by the limit {time}', { time: formatDateTime(q.data.trippedAt) })}` : ''}
          </p>
        )}
        <Button size="sm" onClick={() => save.mutate()} disabled={!valid || save.isPending}>
          {t('Save')}
        </Button>
      </CardBody>
    </Card>
  );
}
