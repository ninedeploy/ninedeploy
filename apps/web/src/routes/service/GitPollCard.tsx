import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Radar } from 'lucide-react';
import type { ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { useT, type Translate } from '../../lib/i18n.js';
import { Button, Card, CardBody, Field, Select, Switch } from '../../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the menu offers. Any value the server takes (60 s to 24 h) can be stored, and stays selectable below. */
const INTERVALS = [60, 300, 900, 1800, 3600, 21600, 86400];

function intervalLabel(t: Translate, seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? t('Every hour') : t('Every {n} hours', { n: seconds / 3600 });
  if (seconds % 60 === 0) return seconds === 60 ? t('Every minute') : t('Every {n} minutes', { n: seconds / 60 });
  return t('Every {n} seconds', { n: seconds });
}

/**
 * X2: read the branch head on an interval and deploy a new commit, as a push webhook would. For a Git server that
 * cannot reach this panel. Off by default; a service without a repository has nothing to poll.
 */
export function GitPollCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  // The condition the server judges by too: a repository to ask.
  const repository = !!svc.repoUrl;
  const q = useQuery({ queryKey: ['git-poll', svc.id], queryFn: () => api.services.gitPoll.get(svc.id), enabled: repository, retry: false });
  const [on, setOn] = useState(false);
  const [seconds, setSeconds] = useState('300');
  useEffect(() => {
    if (!q.data) return;
    setOn(q.data.poll !== null);
    if (q.data.poll) setSeconds(String(q.data.poll.intervalSeconds));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.services.gitPoll.set(svc.id, on ? { intervalSeconds: Number(seconds) } : null),
    onSuccess: (view) => {
      qc.setQueryData(['git-poll', svc.id], view);
      toast(view.poll ? t('Git polling saved') : t('Git polling turned off'), 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  if (!repository || q.isError || !q.data?.supported) return null;
  const view = q.data;
  const current = Number(seconds);
  // A value set through the API, outside the menu's, stays selectable so that saving does not change it.
  const options = INTERVALS.includes(current) ? INTERVALS : [...INTERVALS, current].sort((a, b) => a - b);

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-slate-300">
            <Radar size={15} className="text-slate-500" /> {t('Git polling')}
          </div>
          <Switch checked={on} onChange={setOn} label={t('Git polling')} />
        </div>
        <p className="text-xs text-slate-500">
          {t('Asks the Git server for the branch head on an interval and deploys a new commit, as a push webhook would. For a Git server that cannot reach this panel with a webhook. Every new commit deploys: [skip cd] and watch paths are not read.')}
        </p>
        {on && (
          <Field label={t('Interval')}>
            <Select value={seconds} onChange={(e) => setSeconds(e.target.value)} className="h-9 sm:w-64">
              {options.map((value) => (
                <option key={value} value={value}>
                  {intervalLabel(t, value)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {view.poll && (
          <div className="space-y-1 text-xs text-slate-400">
            {view.lastPolledAt ? (
              <p className="font-mono">
                {t('Last checked {time}', { time: formatDateTime(view.lastPolledAt) })}
                {view.lastSha ? ` · ${view.lastSha.slice(0, 7)}` : ''}
                {view.lastDeploymentId ? ` · ${t('queued deployment #{id}', { id: view.lastDeploymentId })}` : ''}
              </p>
            ) : (
              <p>{t('The first check runs within fifteen seconds.')}</p>
            )}
            {view.lastError && <p className="font-mono text-rose-400">{t('The last check failed: {error}', { error: view.lastError })}</p>}
          </div>
        )}
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {t('Save')}
        </Button>
      </CardBody>
    </Card>
  );
}
