import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Bug } from 'lucide-react';
import type { ErrorEventView, ErrorIssueView } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { useT } from '../../lib/i18n.js';
import { Badge, Button, Card, CardBody, Select } from '../../components/ui.js';

type Status = ErrorIssueView['status'];

/** The top in-app frames of an event's exception, newest call first. */
function framesOf(event: ErrorEventView | undefined): string[] {
  const payload = event?.payload as { exception?: { values?: Array<{ stacktrace?: { frames?: Array<Record<string, unknown>> } }> } } | null;
  const values = payload?.exception?.values ?? [];
  const frames = values[values.length - 1]?.stacktrace?.frames ?? [];
  return frames
    .slice(-8)
    .reverse()
    .map((f) => `${String(f['function'] ?? '?')} — ${String(f['filename'] ?? f['module'] ?? '?')}${f['lineno'] ? `:${String(f['lineno'])}` : ''}`);
}

/**
 * Service → Activity (G5.4): errors that Sentry SDKs report to the panel,
 * grouped into issues, each with the deploy it first appeared under. The
 * DSN is shown once when created.
 */
export function ErrorsCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState<Status>('unresolved');
  const [open, setOpen] = useState<number | null>(null);
  const [dsn, setDsn] = useState<string | null>(null);
  const ingest = useQuery({ queryKey: ['error-ingest', serviceId], queryFn: () => api.services.errors.ingest.get(serviceId), retry: false });
  const issues = useQuery({ queryKey: ['error-issues', serviceId, status], queryFn: () => api.services.errors.list(serviceId, status), retry: false });
  const detail = useQuery({ queryKey: ['error-issue', serviceId, open], queryFn: () => api.services.errors.get(serviceId, open!), enabled: open !== null, retry: false });

  const createKey = useMutation({
    mutationFn: () => api.services.errors.ingest.create(serviceId),
    onSuccess: (v) => {
      setDsn(v.dsn ?? null);
      qc.setQueryData(['error-ingest', serviceId], { enabled: true, createdAt: v.createdAt });
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  const removeKey = useMutation({
    mutationFn: () => api.services.errors.ingest.remove(serviceId),
    onSuccess: (v) => {
      setDsn(null);
      qc.setQueryData(['error-ingest', serviceId], v);
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  const change = useMutation({
    mutationFn: ({ issueId, next }: { issueId: number; next: Status }) => api.services.errors.setStatus(serviceId, issueId, next),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['error-issues', serviceId] }),
    onError: (err: Error) => toast(err.message, 'error'),
  });
  if (!ingest.data) return null;
  const enabled = ingest.data.enabled;

  return (
    <Card className="mt-5">
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 font-medium text-slate-300">
          <Bug size={15} className="text-slate-500" /> {t('Errors')}
          {enabled && (
            <Select value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label={t('Issue status')} className="ml-auto max-w-[10rem]">
              <option value="unresolved">{t('Unresolved')}</option>
              <option value="resolved">{t('Resolved')}</option>
              <option value="ignored">{t('Ignored')}</option>
            </Select>
          )}
        </div>
        <p className="text-xs text-slate-500">
          {t('Point a Sentry SDK at this DSN to collect the errors of the service here. Set the release to the commit SHA, so each issue names the deploy that introduced it.')}
        </p>
        {dsn && (
          <div className="space-y-1">
            <p className="text-xs text-amber-300">{t('Copy the DSN now; it is not shown again.')}</p>
            <code className="block break-all rounded bg-black/30 px-2 py-1 font-mono text-xs text-slate-200">{dsn}</code>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={enabled ? 'ghost' : undefined} onClick={() => createKey.mutate()} disabled={createKey.isPending}>
            {enabled ? t('Replace DSN') : t('Create DSN')}
          </Button>
          {enabled && (
            <Button size="sm" variant="ghost" onClick={() => removeKey.mutate()} disabled={removeKey.isPending}>
              {t('Stop collecting')}
            </Button>
          )}
        </div>

        {enabled && issues.data && issues.data.length === 0 && <p className="text-xs text-slate-500">{t('No issues.')}</p>}
        {enabled && (issues.data ?? []).length > 0 && (
          <ul className="divide-y divide-white/5">
            {(issues.data ?? []).map((i) => (
              <li key={i.id} className="py-2">
                <button type="button" className="w-full text-left" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-200">{i.title}</span>
                    <Badge tone={i.level === 'fatal' || i.level === 'error' ? 'rose' : 'amber'}>{i.level}</Badge>
                    <span className="text-xs text-slate-500">{t('{n} events', { n: i.count })}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {i.culprit ? `${i.culprit} · ` : ''}
                    {t('last seen {when}', { when: formatDateTime(i.lastSeen) })}
                    {i.firstDeploymentId ? ` · ${t('since deploy #{id}', { id: i.firstDeploymentId })}` : ''}
                  </div>
                </button>
                {open === i.id && (
                  <div className="mt-2 space-y-2">
                    {framesOf(detail.data?.events[0]).length > 0 && (
                      <pre className="overflow-x-auto rounded bg-black/30 p-2 font-mono text-xs text-slate-300">{framesOf(detail.data?.events[0]).join('\n')}</pre>
                    )}
                    <div className="flex gap-2">
                      {i.status !== 'resolved' && (
                        <Button size="sm" onClick={() => change.mutate({ issueId: i.id, next: 'resolved' })} disabled={change.isPending}>
                          {t('Resolve')}
                        </Button>
                      )}
                      {i.status !== 'ignored' && (
                        <Button size="sm" variant="ghost" onClick={() => change.mutate({ issueId: i.id, next: 'ignored' })} disabled={change.isPending}>
                          {t('Ignore')}
                        </Button>
                      )}
                      {i.status !== 'unresolved' && (
                        <Button size="sm" variant="ghost" onClick={() => change.mutate({ issueId: i.id, next: 'unresolved' })} disabled={change.isPending}>
                          {t('Reopen')}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
