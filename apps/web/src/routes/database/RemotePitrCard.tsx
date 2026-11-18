import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { CloudUpload } from 'lucide-react';
import type { DatabaseDetail, RemotePitrConfig, RemotePitrStatus } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useT } from '../../lib/i18n.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Field, Input, Select, Skeleton, Switch } from '../../components/ui.js';

type Form = {
  enabled: boolean;
  destination: string;
  mode: 'continuous' | 'checkpoint';
  interval: string;
  retention: string;
  collectOrphans: boolean;
  passphrase: string;
  confirmation: string;
};
const formFrom = (s: RemotePitrStatus): Form => ({
  enabled: s.settings?.enabled ?? false,
  destination: s.settings ? String(s.settings.destinationId) : '',
  mode: s.settings?.mode ?? (s.settings ? 'checkpoint' : 'continuous'),
  interval: String(s.settings?.intervalMinutes ?? 15),
  retention: String(s.settings?.remoteRetentionDays ?? 7),
  collectOrphans: s.settings?.collectOrphans ?? false,
  passphrase: '',
  confirmation: '',
});
const inRange = (v: string, min: number, max: number) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max;
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'The remote archive request failed.');

/** The role gate lives outside the query/form component so role or database changes discard secrets. */
export function RemotePitrCard({ db }: { db: DatabaseDetail }) {
  const { user } = useAuth();
  if (!user?.isOperator || db.engine !== 'postgres') return null;
  return <OperatorRemotePitrCard key={`${user.id}:${db.id}`} db={db} />;
}

function OperatorRemotePitrCard({ db }: { db: DatabaseDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ['database-pitr-remote', db.id];
  const status = useQuery({
    queryKey: key,
    queryFn: () => api.databases.pitr.remote.get(db.id),
    retry: false,
    refetchInterval: q => (q.state.data?.running ? 2500 : 15_000),
  });
  const local = useQuery({
    queryKey: ['database-pitr', db.id],
    queryFn: () => api.databases.pitr.get(db.id),
    retry: false,
    refetchInterval: q => (q.state.data?.baseBackupRunning ? 3000 : 15_000),
  });
  const destinations = useQuery({ queryKey: ['backup-destinations'], queryFn: () => api.backupDestinations.list(), retry: false });
  const [form, setForm] = useState<Form | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (status.data) setForm(f => f ?? formFrom(status.data));
  }, [status.data]);
  useEffect(
    () => () => {
      formRef.current = null;
    },
    [],
  );

  // No passphrase is placed in mutation variables, query data, browser storage or a URL.
  const save = useMutation({
    mutationFn: () => {
      const f = formRef.current!;
      const input: Omit<RemotePitrConfig, 'archiveId'> & { passphrase?: string } = {
        enabled: f.enabled,
        destinationId: Number(f.destination),
        mode: f.mode,
        intervalMinutes: Number(f.interval),
        remoteRetentionDays: Number(f.retention),
      };
      if (f.passphrase) input.passphrase = f.passphrase;
      if (f.collectOrphans) input.collectOrphans = true;
      return api.databases.pitr.remote.set(db.id, input);
    },
    onSuccess: next => {
      qc.setQueryData(key, next);
      setForm(formFrom(next));
      toast(t('Remote archive settings saved'), 'success');
    },
    onError: e => toast(errorText(e), 'error'),
  });
  const ship = useMutation({
    mutationFn: () => api.databases.pitr.remote.checkpoint(db.id),
    onSuccess: () => {
      qc.setQueryData<RemotePitrStatus>(key, s => s && { ...s, running: true });
      void qc.invalidateQueries({ queryKey: key });
      toast(t('Shipment started; verification is pending.'), 'info');
    },
    onError: e => toast(errorText(e), 'error'),
  });

  const heading = (
    <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
      <CloudUpload size={14} /> {t('Remote PostgreSQL archive')}
    </h2>
  );
  if (status.isError)
    return (
      <Card>
        <CardBody className="space-y-3">
          {heading}
          <p className="text-sm text-rose-300">
            {t('Could not load remote archive status')}: {errorText(status.error)}
          </p>
          <Button size="sm" onClick={() => void status.refetch()}>
            {t('Retry')}
          </Button>
        </CardBody>
      </Card>
    );
  if (!status.data || !form)
    return (
      <Card>
        <CardBody>
          {heading}
          <Skeleton className="mt-4 h-24" />
        </CardBody>
      </Card>
    );
  const s = status.data;
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const destinationList = destinations.data ?? [];
  const selected = destinationList.find(d => String(d.id) === form.destination);
  const https = selected?.endpoint.startsWith('https://') === true;
  const passError =
    form.passphrase.length > 0 && (form.passphrase.length < 16 || form.passphrase.length > 1024)
      ? t('Use 16–1024 characters.')
      : form.passphrase !== form.confirmation
        ? t('The passphrases must match.')
        : form.enabled && !s.hasPassphrase && !form.passphrase
          ? t('Set an off-host recovery passphrase.')
          : undefined;
  const sourceReady = local.data?.available === true && local.data.enabled;
  const valid =
    inRange(form.destination, 1, Number.MAX_SAFE_INTEGER) &&
    inRange(form.interval, 15, 1440) &&
    inRange(form.retention, 1, 35) &&
    !passError &&
    (!form.enabled || (sourceReady && https && !destinations.isError));
  const busy = s.running || save.isPending || ship.isPending;
  const dirty = JSON.stringify(form) !== JSON.stringify(formFrom(s));
  const rotation =
    !!s.settings &&
    (form.destination !== String(s.settings.destinationId) || form.mode !== (s.settings.mode ?? 'checkpoint') || !!form.passphrase);
  const canShip =
    !busy &&
    !dirty &&
    s.settings?.enabled === true &&
    s.hasPassphrase &&
    sourceReady &&
    !local.data?.baseBackupRunning &&
    !!local.data?.baseBackups.length;
  const continuous = s.settings?.mode === 'continuous';
  const attempt = continuous ? s.stream : s.state;
  const protection = continuous ? s.stream?.protection : null;
  const checkpoint = !continuous ? s.state?.lastSuccess : null;
  const verified = protection ?? checkpoint;
  const ranges = protection?.ranges ?? (checkpoint ? [{ from: checkpoint.from, through: checkpoint.through }] : []);
  const recoveryKey = protection?.headKey ?? checkpoint?.key;

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {heading}
          <span className="text-xs text-slate-400">
            {s.running ? t('Shipping; not yet verified') : s.settings?.enabled ? t('Scheduled') : t('Paused')}
          </span>
        </div>
        <p className="text-xs text-slate-400">
          {t(
            'Copies the PostgreSQL archive to an HTTPS S3 destination. Keep the destination credentials, recovery key and passphrase off-host. Recover a published archive with the offline recovery tool.',
          )}
        </p>
        {local.isError ? (
          <p role="alert" className="text-xs text-amber-300">
            {t('Could not verify local archiving')}: {errorText(local.error)}
          </p>
        ) : (
          !sourceReady && (
            <p className="text-xs text-amber-300">
              {local.data?.unavailableReason || t('Enable local WAL archiving above before enabling remote shipment.')}
            </p>
          )
        )}
        {attempt?.error && (
          <p role="alert" className="break-words rounded-lg bg-rose-500/10 p-3 text-xs text-rose-300">
            {attempt.error}
          </p>
        )}
        {attempt?.missingSegment && (
          <p className="break-all text-xs text-rose-300">
            {t('Missing WAL segment')}: {attempt.missingSegment}
          </p>
        )}
        <dl className="grid gap-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">{t('Last verified')}</dt>
            <dd className="text-slate-200">{verified ? formatDateTime(verified.verifiedAt) : t('No verified remote archive yet')}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('Archive age (seconds)')}</dt>
            <dd className="text-slate-200">{s.archiveLagSeconds ?? t('Unknown')}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('Last attempt')}</dt>
            <dd className="text-slate-200">{attempt ? `${formatDateTime(attempt.attemptedAt)} · ${attempt.status}` : t('None yet')}</dd>
          </div>
        </dl>
        <p className="text-xs text-slate-500">
          {t('Archive age measures verified WAL timestamps; it is not a transaction-loss guarantee.')}
        </p>
        {verified && (
          <div className="min-w-0 space-y-2 rounded-lg bg-white/[0.03] p-3 text-xs">
            <div className="text-slate-400">{t('Verified recovery ranges')}</div>
            <ul className="space-y-1 text-slate-200">
              {ranges.map(r => (
                <li key={r.from}>
                  {formatDateTime(r.from)} → {formatDateTime(r.through)}
                </li>
              ))}
            </ul>
            <div className="text-slate-400">
              {t('Recovery key')}
              <code className="mt-1 block break-all text-slate-200">{recoveryKey}</code>
            </div>
            <p className="text-slate-500">
              {checkpoint
                ? t('Checkpoint destination #{id}; {size}', { id: checkpoint.destinationId, size: formatBytes(checkpoint.bytes) })
                : t('Continuous archive: {id}', { id: s.stream!.archiveId })}
            </p>
            <p className="text-slate-500">
              {t('Keep the original destination credentials and passphrase for this recovery key when changing settings.')}
            </p>
          </div>
        )}
        <p className="text-xs text-slate-400">{s.retention}</p>
        {continuous && (
          <p className="text-xs text-slate-500">
            {t('Objects awaiting cleanup')}: {s.stream?.gcPending ?? 0}
          </p>
        )}
        <form
          className="space-y-4"
          onSubmit={e => {
            e.preventDefault();
            if (valid && !busy) {
              if (rotation) setConfirm(true);
              else save.mutate();
            }
          }}
        >
          <div className="flex items-center gap-3">
            <Switch label={t('Remote archiving')} checked={form.enabled} onChange={enabled => set({ enabled })} disabled={busy} />
            <span className="text-sm text-slate-300">{t('Remote archiving')}</span>
          </div>
          {destinations.isError && (
            <p role="alert" className="text-xs text-rose-300">
              {t('Could not load backup destinations')}{' '}
              <Button type="button" size="sm" variant="ghost" onClick={() => void destinations.refetch()}>
                {t('Retry destinations')}
              </Button>
            </p>
          )}
          {!destinations.isPending && !destinations.isError && destinationList.length === 0 && (
            <p className="text-xs text-amber-300">{t('Create an HTTPS S3 destination in Settings → Backup destinations.')}</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Archive destination')} hint={selected && !https ? t('An HTTPS destination is required.') : undefined}>
              <Select value={form.destination} onChange={e => set({ destination: e.target.value })} disabled={busy}>
                <option value="">{t('Choose a destination')}</option>
                {form.destination && !selected && (
                  <option value={form.destination}>
                    #{form.destination} ({t('unavailable')})
                  </option>
                )}
                {destinationList.map(d => (
                  <option key={d.id} value={String(d.id)}>
                    {d.name} ({d.bucket})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('Archive mode')}>
              <Select
                value={form.mode}
                onChange={e =>
                  set({
                    mode: e.target.value as Form['mode'],
                    collectOrphans: e.target.value === 'continuous' && form.collectOrphans,
                    interval: inRange(form.interval, 15, 1440) ? form.interval : '15',
                    retention: inRange(form.retention, 1, 35) ? form.retention : '7',
                  })
                }
                disabled={busy}
              >
                <option value="continuous">{t('Continuous WAL (every minute)')}</option>
                <option value="checkpoint">{t('Self-contained checkpoints')}</option>
              </Select>
            </Field>
            {form.mode === 'checkpoint' ? (
              <Field
                label={t('Checkpoint interval (minutes)')}
                error={!inRange(form.interval, 15, 1440) ? t('Between 15 and 1440 minutes') : undefined}
              >
                <Input inputMode="numeric" value={form.interval} onChange={e => set({ interval: e.target.value })} disabled={busy} />
              </Field>
            ) : (
              <Field
                label={t('Remote retention (days)')}
                hint={t('Keeps the boundary base and newer generations, with one-hour deletion grace.')}
                error={!inRange(form.retention, 1, 35) ? t('Between 1 and 35 days') : undefined}
              >
                <Input inputMode="numeric" value={form.retention} onChange={e => set({ retention: e.target.value })} disabled={busy} />
              </Field>
            )}
            <Field
              label={t('Recovery passphrase')}
              hint={
                s.hasPassphrase
                  ? t('A passphrase is stored. Leave both fields blank to keep it.')
                  : t('Store this passphrase outside the source host.')
              }
              error={passError}
            >
              <Input
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={form.passphrase}
                onChange={e => set({ passphrase: e.target.value })}
                disabled={busy}
              />
            </Field>
            <Field label={t('Confirm recovery passphrase')}>
              <Input
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={form.confirmation}
                onChange={e => set({ confirmation: e.target.value })}
                disabled={busy}
              />
            </Field>
          </div>
          {selected && (
            <p className="break-all text-xs text-slate-500">
              {selected.endpoint} · {selected.region} · {selected.bucket}/{selected.prefix}
            </p>
          )}
          {rotation && (
            <p className="text-xs text-amber-300">
              {t(
                'Changing the destination, mode or passphrase leaves older archives in place. Continuous mode starts a separate archive; keep the previous recovery details.',
              )}
            </p>
          )}
          {form.mode === 'continuous' && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Switch
                  label={t('Collect abandoned uploads')}
                  checked={form.collectOrphans}
                  onChange={collectOrphans => set({ collectOrphans })}
                  disabled={busy}
                />
                <span className="text-sm text-slate-300">{t('Collect abandoned uploads')}</span>
              </div>
              <p className="text-xs text-slate-500">
                {t(
                  'Opt-in: scans up to 200 managed keys per pass. Unreferenced objects must be at least 24 hours old, then wait one hour after retirement. Requires ListBucket permission. Turning this off stops discovery; committed cleanup intents still complete.',
                )}
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!valid || busy || !dirty}>
              {save.isPending ? t('Saving…') : t('Save remote archive')}
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy || !dirty} onClick={() => setForm(formFrom(s))}>
              {t('Discard changes')}
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={!canShip} onClick={() => ship.mutate()}>
              {t('Ship archive now')}
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            {t(
              'Pausing shipment keeps remote objects. Disabling local WAL archiving also pauses shipment. Wait for the first base backup before shipping.',
            )}
          </p>
        </form>
        <ConfirmDialog
          open={confirm}
          title={t('Change remote archive recovery details?')}
          message={t(
            'Existing objects stay in their previous archive. Keep their recovery keys, destination credentials and passphrase. The new archive is protected only after a verified shipment.',
          )}
          confirmLabel={t('Save changes')}
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            if (valid && !busy) save.mutate();
          }}
        />
      </CardBody>
    </Card>
  );
}
