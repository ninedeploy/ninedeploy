import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Snowflake } from 'lucide-react';
import type { DeployFreeze, DeployFreezeScope } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { msg, useT } from '../../lib/i18n.js';
import { Badge, Button, Card, CardBody, ErrorCard, Field, Input, Select, Skeleton } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const SCOPE_LABEL: Record<DeployFreezeScope, string> = {
  instance: msg('Whole instance'),
  workspace: msg('Workspace'),
  project: msg('Project'),
  environment: msg('Environment'),
};

/**
 * Settings → Deploy freeze (G5.5, operator only). A freeze holds every deploy
 * of its scope in the queue, whatever triggered it, until it ends or is
 * lifted; the held deploys then start. Nothing is dropped.
 */
export function DeployFreezeSection() {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const freezes = useQuery({ queryKey: ['deploy-freezes'], queryFn: () => api.deployFreezes.list() });
  const [scope, setScope] = useState<DeployFreezeScope>('instance');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');

  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => api.workspaces.list(), enabled: scope === 'workspace' });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list(), enabled: scope === 'project' });
  const environments = useQuery({ queryKey: ['environments'], queryFn: () => api.environments.list(), enabled: scope === 'environment' });
  const targets: Array<{ id: number; name: string }> =
    scope === 'workspace' ? (workspaces.data ?? []) : scope === 'project' ? (projects.data ?? []) : scope === 'environment' ? (environments.data ?? []) : [];

  const create = useMutation({
    mutationFn: () =>
      api.deployFreezes.create({
        scope,
        targetId: scope === 'instance' ? null : Number(targetId),
        reason: reason.trim(),
        until: until ? new Date(until).toISOString() : null,
      }),
    onSuccess: () => {
      setReason('');
      setUntil('');
      void qc.invalidateQueries({ queryKey: ['deploy-freezes'] });
      toast(t('Deploys frozen'), 'success');
    },
    onError: (err) => toast(t('Could not freeze deploys: {error}', { error: errorText(err) }), 'error'),
  });
  const lift = useMutation({
    mutationFn: (id: string) => api.deployFreezes.lift(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['deploy-freezes'] });
      toast(t('Freeze lifted; held deploys start now'), 'success');
    },
    onError: (err) => toast(t('Could not lift the freeze: {error}', { error: errorText(err) }), 'error'),
  });

  const canCreate = reason.trim().length > 0 && (scope === 'instance' || targetId !== '') && !create.isPending;
  const describe = (f: DeployFreeze) =>
    f.scope === 'instance' ? t('All deploys') : `${t(SCOPE_LABEL[f.scope])}: ${f.targetName ?? `#${f.targetId}`}`;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3 text-sm">
          <div className="flex items-center gap-2 font-semibold text-slate-200">
            <Snowflake size={15} className="text-sky-300" /> {t('Deploy freeze')}
          </div>
          <p className="text-xs text-slate-400">
            {t(
              'A freeze holds every deploy of its scope in the queue (UI, API, git pushes, deploy hooks, schedules, rollbacks) until it ends or you lift it. Held deploys then start; nothing is dropped.',
            )}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Scope')}>
              <Select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as DeployFreezeScope);
                  setTargetId('');
                }}
              >
                {(Object.keys(SCOPE_LABEL) as DeployFreezeScope[]).map((s) => (
                  <option key={s} value={s}>
                    {t(SCOPE_LABEL[s])}
                  </option>
                ))}
              </Select>
            </Field>
            {scope !== 'instance' && (
              <Field label={t(SCOPE_LABEL[scope])}>
                <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                  <option value="">{t('Choose…')}</option>
                  {targets.map((x) => (
                    <option key={x.id} value={String(x.id)}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('Reason')}>
              <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={t('Release week, incident, holidays…')} />
            </Field>
            <Field label={t('Ends')} hint={t('Leave empty to keep it until lifted')}>
              <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => create.mutate()} disabled={!canCreate}>
              {create.isPending ? t('Freezing…') : t('Freeze deploys')}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2 text-sm">
          <div className="font-semibold text-slate-200">{t('Freezes in force')}</div>
          {freezes.isLoading && <Skeleton className="h-10" />}
          {freezes.isError && <ErrorCard title={t('Could not load deploy freezes')} error={freezes.error} onRetry={() => void freezes.refetch()} />}
          {freezes.data?.length === 0 && <p className="text-xs text-slate-500">{t('No freeze is in force; deploys run normally.')}</p>}
          <ul className="space-y-2">
            {freezes.data?.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] p-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="sky">{describe(f)}</Badge>
                    <span className="text-xs text-slate-400">
                      {f.until ? t('until {time}', { time: formatDateTime(f.until) }) : t('until lifted')}
                    </span>
                  </div>
                  <p className="break-words text-slate-300">{f.reason}</p>
                  <p className="text-xs text-slate-500">
                    {t('by {who}, {time}', { who: f.createdBy ?? t('unknown'), time: formatDateTime(f.createdAt) })}
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => lift.mutate(f.id)} disabled={lift.isPending}>
                  {t('Lift')}
                </Button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
