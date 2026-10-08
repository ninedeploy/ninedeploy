import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CloudUpload, DatabaseBackup, KeyRound, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PanelBackupObject, PanelBackupSettingsPatch, PanelBackupStatus } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { describeCron, isValidCron } from '../../lib/cron.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ErrorCard, Field, Input, Modal, Select, Skeleton, Switch } from '../../components/ui.js';

interface FormState {
  enabled: boolean;
  cron: string;
  destinationId: string;
  retain: string;
  passphrase: string;
  passphraseAgain: string;
}

const formFrom = (s: PanelBackupStatus): FormState => ({
  enabled: s.settings.enabled,
  cron: s.settings.cron,
  destinationId: s.settings.destinationId != null ? String(s.settings.destinationId) : '',
  retain: String(s.settings.retain),
  passphrase: '',
  passphraseAgain: '',
});

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

/**
 * Panel self-backup (0.12, operator-only): the panel's own database, master
 * key, .env and Traefik config — the `/system/export` archive — sealed with a
 * recovery passphrase and written to a backup destination on a schedule.
 */
export function PanelBackupSection() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const status = useQuery({
    queryKey: ['panel-backup'],
    queryFn: () => api.system.panelBackup.get(),
    // Follow a run that is in progress ("Back up now" returns before it ends).
    refetchInterval: (q) => (q.state.data?.running ? 2500 : false),
  });
  const destinations = useQuery({ queryKey: ['backup-destinations'], queryFn: () => api.backupDestinations.list() });

  const [form, setForm] = useState<FormState | null>(null);
  useEffect(() => {
    if (status.data && form === null) setForm(formFrom(status.data));
  }, [status.data, form]);

  const [listDest, setListDest] = useState<string>('');
  const configuredDest = status.data?.settings.destinationId ?? null;
  const listDestinationId = listDest ? Number(listDest) : configuredDest;
  const remote = useQuery({
    queryKey: ['panel-backup-remote', listDestinationId],
    queryFn: () => api.system.panelBackup.list(listDestinationId ?? undefined),
    enabled: listDestinationId != null,
  });

  // A finished run changes the listing: refresh it when `running` flips off.
  const running = status.data?.running === true;
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (wasRunning && !running) void qc.invalidateQueries({ queryKey: ['panel-backup-remote'] });
    setWasRunning(running);
  }, [running, wasRunning, qc]);

  const save = useMutation({
    mutationFn: (f: FormState) => {
      const body: PanelBackupSettingsPatch = {
        enabled: f.enabled,
        cron: f.cron.trim(),
        destinationId: f.destinationId ? Number(f.destinationId) : null,
        retain: Number(f.retain),
      };
      if (f.passphrase) body.passphrase = f.passphrase;
      return api.system.panelBackup.update(body);
    },
    onSuccess: (next) => {
      qc.setQueryData(['panel-backup'], next);
      void qc.invalidateQueries({ queryKey: ['panel-backup-remote'] });
      setForm(formFrom(next));
      toast('Panel backup settings saved', 'success');
    },
    onError: (err) => toast(errorText(err, 'Failed to save panel backup settings'), 'error'),
  });

  const runNow = useMutation({
    mutationFn: () => api.system.panelBackup.run(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['panel-backup'] });
      toast('Panel backup started', 'info');
    },
    onError: (err) => toast(errorText(err, 'Could not start the panel backup'), 'error'),
  });

  const [restoreTarget, setRestoreTarget] = useState<PanelBackupObject | null>(null);

  if (status.isLoading || (status.data && !form)) return <Skeleton className="h-64 w-full" />;
  if (status.error || !status.data || !form) {
    return <ErrorCard title="Could not load panel backup settings" error={status.error} onRetry={() => void status.refetch()} />;
  }

  const s = status.data;
  const destList = destinations.data ?? [];
  const cronOk = isValidCron(form.cron.trim());
  const retainNum = Number(form.retain);
  const retainOk = Number.isInteger(retainNum) && retainNum >= 1 && retainNum <= 365;
  const passMismatch = form.passphrase !== form.passphraseAgain;
  const passTooShort = form.passphrase.length > 0 && form.passphrase.length < 12;
  const needsPass = form.enabled && !s.settings.hasPassphrase && !form.passphrase;
  const needsDest = form.enabled && !form.destinationId;
  const canSave = cronOk && retainOk && !passMismatch && !passTooShort && !needsPass && !needsDest && !save.isPending;
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const last = s.lastRun;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <DatabaseBackup size={16} className="text-indigo-400" /> Panel backup
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Backs up the panel itself — its database, master key, .env and Traefik config (the same archive as
          Settings → Migration → Export) — encrypted with a recovery passphrase, to an S3 destination on a schedule.
          App volumes and managed database data are not included; they have their own backups.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-400">Last run:</span>
            {running ? (
              <Badge tone="sky">running…</Badge>
            ) : last ? (
              <Badge tone={last.status === 'completed' ? 'emerald' : 'rose'}>{last.status}</Badge>
            ) : (
              <span className="text-slate-500">never</span>
            )}
            {last && !running && (
              <span className="text-slate-500">
                {formatDateTime(last.finishedAt ?? last.startedAt)} · {last.trigger}
                {last.sizeBytes != null && ` · ${formatBytes(last.sizeBytes)}`}
              </span>
            )}
          </div>
          {last?.status === 'failed' && !running && last.error && (
            <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{last.error}</p>
          )}
          {last?.warning && !running && (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{last.warning}</p>
          )}
          <div className="grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
            <span>Last success: {s.lastSuccessAt ? formatDateTime(s.lastSuccessAt) : 'never'}</span>
            <span>Next run: {s.nextRunAt ? formatDateTime(s.nextRunAt) : s.settings.enabled ? '—' : 'disabled'}</span>
          </div>
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => runNow.mutate()}
              disabled={running || runNow.isPending || s.settings.destinationId == null || !s.settings.hasPassphrase}
            >
              <CloudUpload size={14} /> {running ? 'Backing up…' : 'Back up now'}
            </Button>
            {(s.settings.destinationId == null || !s.settings.hasPassphrase) && (
              <span className="ml-2 text-[11px] text-slate-500">Save a destination and a recovery passphrase first.</span>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Scheduled backups</span>
            <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Enable scheduled panel backups" />
          </div>
          <Field label="Schedule (cron)" hint={cronOk ? (describeCron(form.cron.trim()) ?? '5 fields, server time') : undefined} error={cronOk ? undefined : 'Expected 5 fields: minute hour day month weekday'}>
            <Input value={form.cron} onChange={(e) => set({ cron: e.target.value })} placeholder="0 3 * * *" aria-label="Schedule (cron)" />
          </Field>
          <Field
            label="Destination"
            hint="Managed under Backups → Destinations"
            error={needsDest ? 'Pick a destination to enable scheduled backups' : undefined}
          >
            <Select value={form.destinationId} onChange={(e) => set({ destinationId: e.target.value })} aria-label="Destination">
              <option value="">— none —</option>
              {destList.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.name} ({d.bucket}/{d.prefix})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Keep" hint="Newest backups kept in the destination (the newest is never deleted)" error={retainOk ? undefined : 'Between 1 and 365'}>
            <Input type="number" min={1} max={365} value={form.retain} onChange={(e) => set({ retain: e.target.value })} aria-label="Keep" />
          </Field>

          <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3">
            <p className="flex items-start gap-2 text-xs text-amber-200">
              <KeyRound size={14} className="mt-0.5 shrink-0" />
              <span>
                <strong>Keep the recovery passphrase somewhere other than this server</strong> (a password manager).
                Every panel backup is encrypted with it, and a backup cannot be restored without it — not even by
                NineDeploy. {s.settings.hasPassphrase ? 'A passphrase is set; type a new one only to replace it. Older backups keep the passphrase they were made with.' : 'No passphrase is set yet.'}
              </span>
            </p>
            {s.masterKeyFromEnv && (
              <p className="flex items-start gap-2 text-xs text-amber-200">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  This panel reads its master key from NINEDEPLOY_MASTER_KEY(S), so backups do NOT contain it. Keep that
                  key with the passphrase, or the restored secrets cannot be decrypted.
                </span>
              </p>
            )}
            <Field label="Recovery passphrase" error={passTooShort ? 'At least 12 characters' : needsPass ? 'Required to enable scheduled backups' : undefined}>
              <Input
                type="password"
                value={form.passphrase}
                onChange={(e) => set({ passphrase: e.target.value })}
                placeholder={s.settings.hasPassphrase ? '•••••••• (stored)' : 'At least 12 characters'}
                autoComplete="new-password"
                aria-label="Recovery passphrase"
              />
            </Field>
            <Field label="Repeat passphrase" error={passMismatch ? 'The passphrases do not match' : undefined}>
              <Input
                type="password"
                value={form.passphraseAgain}
                onChange={(e) => set({ passphraseAgain: e.target.value })}
                autoComplete="new-password"
                aria-label="Repeat passphrase"
              />
            </Field>
          </div>

          <Button onClick={() => save.mutate(form)} disabled={!canSave}>
            {save.isPending ? 'Saving…' : 'Save panel backup settings'}
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Backups in the destination</span>
            <Select value={listDest} onChange={(e) => setListDest(e.target.value)} aria-label="List destination" className="h-8 w-auto text-xs">
              <option value="">Configured destination</option>
              {destList.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
          {listDestinationId == null ? (
            <p className="text-xs text-slate-500">Pick a destination to see its panel backups.</p>
          ) : remote.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : remote.error ? (
            <ErrorCard title="Could not list panel backups" error={remote.error} onRetry={() => void remote.refetch()} />
          ) : (remote.data?.items.length ?? 0) === 0 ? (
            <p className="text-xs text-slate-500">No panel backups in this destination yet.</p>
          ) : (
            <ul className="divide-y divide-white/[0.06] text-xs">
              {remote.data!.items.map((o) => (
                <li key={o.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-slate-300">{o.name}</div>
                    <div className="text-slate-500">
                      {formatBytes(o.sizeBytes)} · {o.lastModified ? formatDateTime(o.lastModified) : '—'}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setRestoreTarget(o)} aria-label={`Restore ${o.name}`}>
                    <RotateCcw size={13} /> Restore…
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {restoreTarget && listDestinationId != null && (
        <RestoreDialog
          target={restoreTarget}
          destinationId={listDestinationId}
          onClose={() => setRestoreTarget(null)}
        />
      )}
    </div>
  );
}

/**
 * Destructive restore: the passphrase AND the backup's file name typed back.
 * Replaces this panel's database, master key, .env and Traefik config.
 */
function RestoreDialog({ target, destinationId, onClose }: { target: PanelBackupObject; destinationId: number; onClose: () => void }) {
  const { toast } = useToast();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const restore = useMutation({
    mutationFn: () => api.system.panelBackup.restore({ destinationId, key: target.key, passphrase, confirm }),
    onSuccess: (res) => {
      toast(res.message || 'Panel restored — restart NineDeploy now', 'success');
      onClose();
    },
    onError: (err) => toast(errorText(err, 'Restore failed'), 'error'),
  });
  const ready = passphrase.length > 0 && confirm === target.name && !restore.isPending;
  return (
    <Modal
      title="Restore the panel from a backup"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!ready} onClick={() => restore.mutate()}>
            {restore.isPending ? 'Restoring…' : 'Restore and replace this panel'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-300">
        <p>
          This <strong>replaces</strong> this panel's database, master key, .env and Traefik config with the contents of{' '}
          <span className="font-mono">{target.name}</span>. Everything changed here since that backup is lost. The
          current files are moved aside (the response names the folder), and NineDeploy must be restarted afterwards.
        </p>
        <Field label="Recovery passphrase">
          <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" aria-label="Backup recovery passphrase" />
        </Field>
        <Field label={`Type "${target.name}" to confirm`}>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={target.name} autoComplete="off" aria-label="Confirm backup name" />
        </Field>
      </div>
    </Modal>
  );
}
