import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { History } from 'lucide-react';
import type { DatabaseDetail, PitrRecovery, PitrStatus } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Field, Input, Modal, Skeleton } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

const errorStatus = (err: unknown): number | undefined => (err as { status?: number } | null)?.status;
const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/** A `datetime-local` value (this browser's zone) as an ISO instant with the zone applied. */
export function localInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/**
 * R3, Database → Backups: PostgreSQL point-in-time recovery. Reading follows
 * the backups list; enabling, a base backup and a recovery need admin on the
 * database (the server answers 403 otherwise). A recovery never touches this
 * database: it creates a new one, and its history polls while it runs.
 */
export function PitrCard({ db }: { db: DatabaseDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [retention, setRetention] = useState('');
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const status = useQuery({ queryKey: ['database-pitr', db.id], queryFn: () => api.databases.pitr.get(db.id), retry: false, enabled: db.engine === 'postgres' });
  const recoveries = useQuery({
    queryKey: ['database-pitr-recoveries', db.id],
    queryFn: () => api.databases.pitr.recoveries(db.id),
    enabled: status.data?.enabled === true,
    refetchInterval: (q) => ((q.state.data as PitrRecovery[] | undefined)?.some((r) => r.status === 'running') ? 3000 : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['database-pitr', db.id] });
    void qc.invalidateQueries({ queryKey: ['database-pitr-recoveries', db.id] });
  };

  const set = useMutation({
    mutationFn: (input: { enabled: boolean; retentionDays?: number }) => api.databases.pitr.set(db.id, input),
    onSuccess: (next: PitrStatus, input) => {
      qc.setQueryData(['database-pitr', db.id], next);
      refresh();
      setRetention('');
      toast(input.enabled ? t('Point-in-time recovery is on; the first base backup is running') : t('Point-in-time recovery is off; its archive was deleted'), 'success');
    },
    onError: (err) => toast(message(err, t('Could not change point-in-time recovery')), 'error'),
  });
  const baseBackup = useMutation({
    mutationFn: () => api.databases.pitr.baseBackup(db.id),
    onSuccess: () => { refresh(); toast(t('Base backup started'), 'success'); },
    onError: (err) => toast(message(err, t('Could not start a base backup')), 'error'),
  });

  if (db.engine !== 'postgres') return null;
  const title = (
    <div className="p-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <History size={14} /> {t('Point-in-time recovery')}
      </h2>
      {status.data?.enabled && <span className="text-xs text-emerald-300">{t('On')}</span>}
    </div>
  );
  if (status.isLoading) {
    return (
      <Card>
        <CardBody>
          <Skeleton className="h-20" />
        </CardBody>
      </Card>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Card className="overflow-hidden">
        {title}
        <CardBody>
          <p className="text-sm text-slate-500">
            {errorStatus(status.error) === 403 ? t('Point-in-time recovery needs access to this database.') : t('Could not load point-in-time recovery.')}
          </p>
        </CardBody>
      </Card>
    );
  }

  const s = status.data;
  const days = retention.trim() === '' ? s.retentionDays : Number(retention);
  const retentionError = /^\d+$/.test(String(days)) && days >= 1 && days <= 35 ? null : t('Between 1 and 35 days');
  const busy = set.isPending || baseBackup.isPending;

  return (
    <Card className="overflow-hidden">
      {title}
      <CardBody className="space-y-4">
        <p className="text-xs text-slate-400">
          {t('Archives every change of this database, so it can be recovered to any second inside the window, into a new database. A base backup is taken daily; the archive and the base backups use disk on the panel host.')}
        </p>
        {!s.available ? (
          <p className="text-sm text-slate-500">{s.unavailableReason}</p>
        ) : !s.enabled ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('Keep for (days)')} error={retentionError}>
              <Input value={retention} onChange={(e) => setRetention(e.target.value)} placeholder={String(s.retentionDays)} inputMode="numeric" className="h-9 w-24 font-mono text-xs" />
            </Field>
            <Button size="sm" onClick={() => set.mutate({ enabled: true, retentionDays: days })} disabled={busy || retentionError !== null}>
              {set.isPending ? t('Restarting…') : t('Enable point-in-time recovery')}
            </Button>
            <p className="w-full text-xs text-slate-500">{t('Enabling restarts the database once.')}</p>
          </div>
        ) : (
          <>
            {s.lastError && <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">{s.lastError}</p>}
            {s.archiving?.failing && (
              <p className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{t('WAL archiving is failing since {time}; recent changes are not recoverable until it works again.', { time: formatDateTime(s.archiving.lastFailedAt ?? '') })}</p>
            )}
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">{t('Last base backup')}</dt>
                <dd className="text-slate-200">{s.baseBackupRunning ? t('Running…') : s.lastBaseBackupAt ? formatDateTime(s.lastBaseBackupAt) : t('None yet')}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t('Archive')}</dt>
                <dd className="text-slate-200">{t('{size} in {count} segments', { size: formatBytes(s.archiveBytes), count: s.segmentCount })}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t('Keep for (days)')}</dt>
                <dd className="flex items-center gap-2">
                  <Input value={retention} onChange={(e) => setRetention(e.target.value)} placeholder={String(s.retentionDays)} inputMode="numeric" aria-label={t('Keep for (days)')} className="h-8 w-16 font-mono text-xs" />
                  {retention.trim() !== '' && (
                    <Button size="sm" variant="secondary" onClick={() => set.mutate({ enabled: true, retentionDays: days })} disabled={busy || retentionError !== null}>
                      {t('Save')}
                    </Button>
                  )}
                </dd>
              </div>
            </dl>
            <div className="text-xs">
              <div className="text-slate-500">{t('Recoverable')}</div>
              {s.recoverable.length ? (
                <ul className="mt-1 space-y-0.5 font-mono text-slate-200" data-testid="pitr-window">
                  {s.recoverable.map((r) => (
                    <li key={r.from}>
                      {formatDateTime(r.from)} → {formatDateTime(r.to)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-slate-400">{t('Nothing yet: the first base backup has not finished.')}</p>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => baseBackup.mutate()} disabled={busy || s.baseBackupRunning}>
                {t('Take base backup')}
              </Button>
              <Button size="sm" onClick={() => setRecovering(true)} disabled={!s.recoverable.length || s.recoveryRunning}>
                {t('Recover to a point in time…')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setConfirmDisable(true)} disabled={busy}>
                {t('Disable')}
              </Button>
            </div>
            {recoveries.data && recoveries.data.length > 0 && (
              <div className="text-xs">
                <div className="text-slate-500">{t('Recoveries')}</div>
                <ul className="mt-1 space-y-1">
                  {recoveries.data.slice(0, 5).map((r) => (
                    <li key={r.id} className="text-slate-300">
                      <span className={r.status === 'failed' ? 'text-rose-300' : r.status === 'running' ? 'text-amber-300' : 'text-emerald-300'}>
                        {r.status === 'running' ? t('Recovering…') : r.status === 'completed' ? t('Recovered') : t('Failed')}
                      </span>{' '}
                      {r.targetTime ? t('to {time}', { time: formatDateTime(r.targetTime) }) : t('to the latest point')}
                      {r.status === 'completed' && r.databaseId != null && (
                        <>
                          {' · '}
                          <Link className="text-sky-300 hover:underline" to={`/databases/${r.databaseId}`}>
                            {t('database #{id}', { id: r.databaseId })}
                          </Link>
                          {r.restoreMs != null && ` · ${t('replayed in {seconds} s', { seconds: Math.max(1, Math.round(r.restoreMs / 1000)) })}`}
                        </>
                      )}
                      {r.error && <div className="text-slate-500">{r.error}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirmDisable}
        title={t('Disable point-in-time recovery?')}
        message={t('The database restarts without archiving, and its WAL archive and base backups are deleted. Points in time before now can no longer be recovered.')}
        confirmLabel={t('Disable and delete the archive')}
        confirmWord="disable"
        onConfirm={() => { setConfirmDisable(false); set.mutate({ enabled: false }); }}
        onClose={() => setConfirmDisable(false)}
      />
      {recovering && <RecoverDialog db={db} status={s} onClose={() => setRecovering(false)} onStarted={refresh} />}
    </Card>
  );
}

function RecoverDialog({ db, status, onClose, onStarted }: { db: DatabaseDetail; status: PitrStatus; onClose: () => void; onStarted: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const [name, setName] = useState(`${db.name}-restored`);
  const [mode, setMode] = useState<'latest' | 'time'>('latest');
  const [when, setWhen] = useState('');
  const targetTime = mode === 'time' ? localInputToIso(when) : null;
  const invalid = !name.trim() || (mode === 'time' && targetTime === null);
  const start = useMutation({
    mutationFn: () => api.databases.pitr.recover(db.id, { name: name.trim(), targetTime }),
    onSuccess: () => {
      onStarted();
      toast(t('Recovery started; the new database appears when it finishes'), 'success');
      onClose();
    },
    onError: (err) => toast(message(err, t('The recovery could not start')), 'error'),
  });
  return (
    <Modal
      title={t('Recover {name} to a point in time', { name: db.name })}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button size="sm" type="submit" form="pitr-recover-form" disabled={start.isPending || invalid}>
            {start.isPending ? t('Starting…') : t('Start recovery')}
          </Button>
        </div>
      }
    >
      <form
        id="pitr-recover-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) start.mutate();
        }}
      >
        <p className="text-sm text-slate-400">
          {t('A base backup is restored into a new database and the archived changes are replayed up to the point you pick. This database is not touched.')}
        </p>
        <Field label={t('New database name')}>
          <Input required value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <fieldset className="space-y-2 text-sm text-slate-300">
          <label className="flex items-center gap-2">
            <input type="radio" name="pitr-target" checked={mode === 'latest'} onChange={() => setMode('latest')} />
            {t('The latest archived point')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="pitr-target" checked={mode === 'time'} onChange={() => setMode('time')} />
            {t('A point in time (your local time)')}
          </label>
        </fieldset>
        {mode === 'time' && (
          <Field
            label={t('Recover to')}
            hint={status.recoverable.length ? t('Recoverable: {ranges}', { ranges: status.recoverable.map((r) => `${formatDateTime(r.from)} → ${formatDateTime(r.to)}`).join(', ') }) : undefined}
            error={when && targetTime === null ? t('Pick a date and a time') : undefined}
          >
            <Input type="datetime-local" step={1} value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
        )}
      </form>
    </Modal>
  );
}
