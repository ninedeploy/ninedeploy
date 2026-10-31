import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Check, Copy, Workflow } from 'lucide-react';
import type { CiRunnerView } from '@ninedeploy/schemas';
import { api } from '../../lib/api.js';
import { formatDateTime, useCopy } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, ErrorCard, Field, Input, Skeleton } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/**
 * Settings → CI runners (R5, operator only). A runner is a machine that pulls
 * CI jobs from the panel with its own token; the token is shown once.
 */
export function CiRunnersSection() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const runners = useQuery({ queryKey: ['ci-runners'], queryFn: () => api.ci.runners.list(), refetchInterval: 15_000 });
  const [name, setName] = useState('');
  const [labels, setLabels] = useState('');
  const [capacity, setCapacity] = useState('1');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<CiRunnerView | null>(null);
  const { copied, copy } = useCopy();

  const labelList = labels.split(/[\s,]+/).filter(Boolean);
  const badLabel = labelList.find((l) => !LABEL_RE.test(l));
  const cap = Number(capacity);
  const canCreate = name.trim().length > 0 && !badLabel && Number.isInteger(cap) && cap >= 1 && cap <= 32;

  const create = useMutation({
    mutationFn: () => api.ci.runners.create({ name: name.trim(), labels: labelList, capacity: cap }),
    onSuccess: (r) => {
      setIssued({ name: r.name, token: r.token });
      setName('');
      setLabels('');
      void qc.invalidateQueries({ queryKey: ['ci-runners'] });
    },
    onError: (err) => toast(t('Could not add the runner: {error}', { error: errorText(err) }), 'error'),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.ci.runners.revoke(id),
    onSuccess: () => {
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: ['ci-runners'] });
      toast(t('Runner revoked; its running jobs were requeued'), 'success');
    },
    onError: (err) => toast(t('Could not revoke the runner: {error}', { error: errorText(err) }), 'error'),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3 text-sm">
          <div className="flex items-center gap-2 font-semibold text-slate-200">
            <Workflow size={15} className="text-sky-300" /> {t('CI runners')}
          </div>
          <p className="text-xs text-slate-400">
            {t('A runner is a machine that pulls CI jobs from this panel over HTTPS and runs them in containers. Use a dedicated machine: jobs can reach whatever its network reaches.')}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('Name')}>
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="builder-1" />
            </Field>
            <Field label={t('Labels')} hint={badLabel ? t('Not a valid label: {label}', { label: badLabel }) : t('Separated by spaces or commas')}>
              <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="linux x64" />
            </Field>
            <Field label={t('Jobs at the same time')}>
              <Input type="number" min={1} max={32} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => create.mutate()} disabled={!canCreate || create.isPending}>
              {create.isPending ? t('Adding…') : t('Add runner')}
            </Button>
          </div>
          {issued && (
            <div className="space-y-2 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
              <p className="text-xs text-amber-200">
                {t('Token for {name}. It is shown only once: start the runner with it now or store it safely.', { name: issued.name })}
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-black/30 px-2 py-1 text-xs text-slate-200">{issued.token}</code>
                <Button size="sm" variant="secondary" onClick={() => void copy(issued.token)} aria-label={t('Copy token')}>
                  {copied ? <Check size={13} /> : <Copy size={13} />} {t('Copy')}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded bg-black/30 p-2 text-[11px] text-slate-300">{`docker run -d --name ninedeploy-ci-runner --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /var/lib/ninedeploy-runner:/var/lib/ninedeploy-runner \\
  -e NINEDEPLOY_RUNNER_WORKDIR=/var/lib/ninedeploy-runner \\
  -e NINEDEPLOY_RUNNER_URL=${window.location.origin} \\
  -e NINEDEPLOY_RUNNER_TOKEN=${issued.token} \\
  ghcr.io/ninedeploy/ninedeploy:v<version> node apps/server/dist/ciRunner.js`}</pre>
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" onClick={() => setIssued(null)}>
                  {t('Done')}
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2 text-sm">
          <div className="font-semibold text-slate-200">{t('Enrolled runners')}</div>
          {runners.isLoading && <Skeleton className="h-10" />}
          {runners.isError && <ErrorCard title={t('Could not load CI runners')} error={runners.error} onRetry={() => void runners.refetch()} />}
          {runners.data?.length === 0 && <p className="text-xs text-slate-500">{t('No runner yet. Jobs wait in the queue until one is added.')}</p>}
          <ul className="space-y-2">
            {runners.data?.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-200">{r.name}</span>
                    {r.revokedAt ? (
                      <Badge tone="neutral">{t('Revoked')}</Badge>
                    ) : r.online ? (
                      <Badge tone="emerald">{t('Online')}</Badge>
                    ) : (
                      <Badge tone="amber">{t('Offline')}</Badge>
                    )}
                    {r.labels.map((l) => (
                      <Badge key={l} tone="sky">
                        {l}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500">
                    {t('{running} of {capacity} running', { running: r.running, capacity: r.capacity })}
                    {r.version ? ` · ${r.version}` : ''}
                    {' · '}
                    {r.lastSeenAt ? t('seen {time}', { time: formatDateTime(r.lastSeenAt) }) : t('never seen')}
                  </p>
                </div>
                {!r.revokedAt && (
                  <Button size="sm" variant="secondary" onClick={() => setRevoking(r)}>
                    {t('Revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={revoking !== null}
        title={t('Revoke {name}?', { name: revoking?.name ?? '' })}
        message={t('Its token stops working at once and the jobs it is running go back to the queue.')}
        confirmLabel={t('Revoke')}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}
