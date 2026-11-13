import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import type { DatabaseDetail, DatabaseUpgrade } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Badge, Button, Card, CardBody, ConfirmDialog, Select, Skeleton } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

const ENGINE_LABELS: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' };
/** Rows from panels before 0.18.28 carry only the majors. */
const fromOf = (u: DatabaseUpgrade) => u.fromSeries ?? String(u.fromMajor);
const toOf = (u: DatabaseUpgrade) => u.toSeries ?? String(u.toMajor);

/**
 * O2, Database → Settings: move a PostgreSQL, MySQL or MariaDB database to a
 * newer release. The panel checks the running server, stops the database,
 * dumps it (kept as a backup, labelled `pre-upgrade` in the database), then
 * restores (PostgreSQL) or copies and upgrades in place (MySQL, MariaDB) into
 * a new volume and compares the copy before the switch. The previous volume
 * stays until "Finalize"; until then "Roll back" points the database back at
 * it. Admin on the database.
 */
export function UpgradeCard({ db }: { db: DatabaseDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [target, setTarget] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'start' | 'rollback' | 'finalize'>(null);

  const enabled = db.engine in ENGINE_LABELS;
  const engine = ENGINE_LABELS[db.engine] ?? db.engine;
  const copies = db.engine !== 'postgres';
  const history = useQuery({
    queryKey: ['database-upgrades', db.id],
    queryFn: () => api.databases.upgrades.list(db.id),
    enabled,
    refetchInterval: (q) => ((q.state.data as DatabaseUpgrade[] | undefined)?.some((u) => u.status === 'running') ? 3000 : false),
  });
  const running = history.data?.some((u) => u.status === 'running') ?? false;
  const options = useQuery({
    queryKey: ['database-upgrade-options', db.id, running],
    queryFn: () => api.databases.upgrades.options(db.id),
    // Only once the history says nothing runs: a running upgrade has the database stopped.
    enabled: enabled && history.isSuccess && !running,
    retry: false,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['database-upgrades', db.id] });
    void qc.invalidateQueries({ queryKey: ['database-upgrade-options', db.id] });
    void qc.invalidateQueries({ queryKey: ['database', db.id] });
  };

  const start = useMutation({
    mutationFn: (toVersion: string) => api.databases.upgrades.start(db.id, { toVersion }),
    onSuccess: (u) => { refresh(); setConfirm(null); toast(t('Upgrade to {engine} {version} started', { engine, version: toOf(u) }), 'success'); },
    onError: (err) => { setConfirm(null); toast(message(err, t('Could not start the upgrade')), 'error'); },
  });
  const rollback = useMutation({
    mutationFn: (id: number) => api.databases.upgrades.rollback(db.id, id),
    onSuccess: (u) => { refresh(); setConfirm(null); toast(t('Back on {engine} {version}', { engine, version: fromOf(u) }), 'success'); },
    onError: (err) => { setConfirm(null); toast(message(err, t('Could not roll back')), 'error'); },
  });
  const finalize = useMutation({
    mutationFn: (id: number) => api.databases.upgrades.finalize(db.id, id),
    onSuccess: (u) => { refresh(); setConfirm(null); toast(t('Deleted {volume}', { volume: u.removedVolume }), 'success'); },
    onError: (err) => { setConfirm(null); toast(message(err, t('Could not finalize')), 'error'); },
  });

  if (!enabled) return null;
  const phaseLabel: Record<string, string> = {
    pull: t('Pulling the new image'),
    stop: t('Stopping the database'),
    dump: t('Dumping the old cluster'),
    copy: t('Copying the data directory'),
    upgrade: t('Upgrading the copy'),
    restore: t('Restoring into the new major'),
    verify: t('Comparing the copy with the original'),
    switch: t('Switching over'),
    start: t('Starting the upgraded database'),
  };
  const latest = history.data?.[0];
  const open = latest && (latest.status === 'running' || latest.status === 'completed' || latest.status === 'rolled_back') ? latest : null;
  // `versions` arrives from 0.18.28; an older panel lists PostgreSQL majors only.
  const versions = options.data ? (options.data.versions ?? options.data.targets.map(String)) : [];
  const current = options.data ? (options.data.currentSeries ?? (options.data.currentMajor != null ? String(options.data.currentMajor) : null)) : null;
  const chosen = target ?? versions.at(-1) ?? null;
  const busy = start.isPending || rollback.isPending || finalize.isPending;

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <ArrowUpCircle size={14} /> {t('Major version upgrade')}
        </h2>
        {current != null && <span className="text-xs text-slate-400">{t('{engine} {version}', { engine, version: current })}</span>}
      </div>
      <CardBody className="space-y-4">
        <p className="text-xs text-slate-400">
          {copies
            ? t('Moves this database to a newer {engine} release. The database stops while its data directory is copied into a new volume and upgraded there; the copy is compared with the original before the switch. The hostname and password stay the same, and the previous volume is kept until you finalize.', { engine })
            : t('Moves this database to a newer PostgreSQL major. The database stops while it is dumped and restored into a new volume; the copy is compared with the original before the switch. The hostname and password stay the same, and the previous volume is kept until you finalize.')}
        </p>

        {history.isLoading ? (
          <Skeleton className="h-12" />
        ) : open?.status === 'running' ? (
          <p className="rounded-lg bg-sky-500/10 p-2 text-xs text-sky-300" data-testid="upgrade-running">
            {t('Upgrading to {engine} {version}: {phase}…', { engine, version: toOf(open), phase: phaseLabel[open.phase ?? ''] ?? t('starting') })}
          </p>
        ) : open?.status === 'completed' ? (
          <div className="space-y-2 rounded-lg bg-emerald-500/10 p-3 text-xs text-emerald-200">
            <p>{t('Upgraded from {engine} {from} to {to}.', { engine, from: fromOf(open), to: toOf(open) })}</p>
            {open.verification && (
              <p className="text-emerald-300/80">
                {open.verification.users != null
                  ? t('Compared before the switch: {tables} tables, {rows} rows, {users} accounts.', { tables: open.verification.tables, rows: open.verification.rows, users: open.verification.users })
                  : t('Compared before the switch: {tables} tables, {rows} rows, {sequences} sequences.', { tables: open.verification.tables, rows: open.verification.rows, sequences: open.verification.sequences })}
              </p>
            )}
            <p className="text-slate-300">{t('The previous volume {volume} is kept. Check your services, then finalize to delete it.', { volume: open.previousVolume })}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setConfirm('finalize')} disabled={busy}>{t('Finalize')}</Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirm('rollback')} disabled={busy}>{t('Roll back to {engine} {version}', { engine, version: fromOf(open) })}</Button>
            </div>
          </div>
        ) : open?.status === 'rolled_back' ? (
          <div className="space-y-2 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-200">
            <p>{t('Rolled back to {engine} {version}. The upgraded volume {volume} still holds the writes made after the upgrade.', { engine, version: fromOf(open), volume: open.targetVolume })}</p>
            <Button size="sm" variant="secondary" onClick={() => setConfirm('finalize')} disabled={busy}>{t('Delete the upgraded volume')}</Button>
          </div>
        ) : options.isLoading ? (
          <Skeleton className="h-10" />
        ) : options.data?.refusal ? (
          <p className="text-sm text-slate-500" data-testid="upgrade-refusal">{options.data.refusal.message}</p>
        ) : options.data ? (
          <div className="flex flex-wrap items-center gap-3">
            <Select aria-label={t('Target release')} value={chosen ?? ''} onChange={(e) => setTarget(e.target.value)} className="h-9 w-48 text-xs">
              {versions.map((v) => (
                <option key={v} value={v}>{t('{engine} {version}', { engine, version: v })}</option>
              ))}
            </Select>
            <Button size="sm" onClick={() => setConfirm('start')} disabled={busy || chosen == null}>
              {t('Upgrade')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-slate-500">{message(options.error, t('Could not read the database version.'))}</p>
        )}

        {latest?.status === 'failed' && (
          <p className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-300">{t('The last upgrade failed: {error}', { error: latest.error ?? '' })}</p>
        )}

        {history.data && history.data.length > 0 && (
          <ul className="space-y-1 text-xs text-slate-400" aria-label={t('Upgrade history')}>
            {history.data.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{fromOf(u)} → {toOf(u)}</span>
                <Badge tone={u.status === 'completed' || u.status === 'finalized' ? 'emerald' : u.status === 'failed' ? 'rose' : u.status === 'running' ? 'sky' : 'amber'}>{u.status}</Badge>
                <span>{formatDateTime(u.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <ConfirmDialog
        open={confirm === 'start'}
        title={t('Upgrade to {engine} {version}?', { engine, version: chosen ?? '' })}
        message={copies
          ? t('The database stops for the whole upgrade: a safety dump, a copy of its data directory, the upgrade of the copy, comparison. Attached services lose their connection until it is back. A pre-upgrade backup is kept.')
          : t('The database stops for the whole upgrade: dump, restore into the new major, comparison. Attached services lose their connection until it is back. A pre-upgrade backup is kept.')}
        confirmLabel={t('Upgrade')}
        confirmWord={db.name}
        confirmDisabled={busy}
        onConfirm={() => chosen != null && start.mutate(chosen)}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'rollback'}
        title={t('Roll back to {engine} {version}?', { engine, version: open ? fromOf(open) : '' })}
        message={t('The database restarts on its previous volume. Writes made since the upgrade stay on the upgraded volume and are not carried back.')}
        confirmLabel={t('Roll back')}
        confirmDisabled={busy}
        onConfirm={() => open && rollback.mutate(open.id)}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'finalize'}
        title={t('Delete {volume}?', { volume: open ? (open.status === 'completed' ? open.previousVolume : open.targetVolume) : '' })}
        message={t('The volume the database no longer uses is deleted. After this there is no rollback.')}
        confirmLabel={t('Delete')}
        confirmDisabled={busy}
        onConfirm={() => open && finalize.mutate(open.id)}
        onClose={() => setConfirm(null)}
      />
    </Card>
  );
}
