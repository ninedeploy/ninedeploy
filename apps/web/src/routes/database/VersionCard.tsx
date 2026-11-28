import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Tags } from 'lucide-react';
import type { DatabaseDetail, LegacyVersionStatus } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Select, Skeleton } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const ENGINE_LABELS: Record<string, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB' };

/** The release of the image that created the volume, when it is one this row may be named: the likeliest answer. */
const creationTag = (s: LegacyVersionStatus) => s.choices.find((c) => s.creationImage?.endsWith(`:${c}`)) ?? null;

/**
 * N12, Database → Settings: a database that has no version, or whose version
 * was named by hand and the server has not run on yet. Rows without a version
 * come from installs before 0.18.28: the version pin left them alone because
 * their volume was not created by the default image, so nobody can tell which
 * release their data runs, and the next Start would run the default — for
 * MySQL, MariaDB and MongoDB an in-place upgrade with no way back. Here the
 * release is named before that Start, from a short list. A name is provisional
 * until the server has run on it: the first Start tries it, and one the server
 * does not stay up in is undone. Admin on the database.
 */
export function VersionCard({ db }: { db: DatabaseDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  // Only such a row asks: a database with a version the server runs has nothing to name.
  const enabled = db.serverId == null && (db.version == null || db.versionNamedAt != null);
  const status = useQuery({
    queryKey: ['database-version', db.id, db.version ?? '', db.versionNamedAt ?? '', db.status],
    queryFn: () => api.databases.version.get(db.id),
    enabled,
    retry: false,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['database-version', db.id] });
    void qc.invalidateQueries({ queryKey: ['database', db.id] });
  };
  const set = useMutation({
    mutationFn: (version: string) => api.databases.version.set(db.id, { version }),
    onSuccess: (s) => {
      refresh();
      setConfirm(false);
      setPicked(null);
      toast(t('Version set to {version}. The first start tries it.', { version: s.version ?? '' }), 'success');
    },
    onError: (err) => { setConfirm(false); toast(message(err, t('Could not set the version')), 'error'); },
  });

  if (!enabled) return null;
  const s = status.data;
  const engine = ENGINE_LABELS[db.engine] ?? db.engine;
  const chosen = picked ?? (s ? (s.version ?? creationTag(s) ?? s.choices[0]) : null);

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          <Tags size={14} /> {t('Version')}
        </h2>
        {s?.version != null && <span className="text-xs text-slate-400">{t('{engine} {version}', { engine, version: s.version })}</span>}
      </div>
      <CardBody className="space-y-4">
        {status.isLoading ? (
          <Skeleton className="h-12" />
        ) : !s ? (
          <p className="text-sm text-slate-500">{message(status.error, t('Could not read the database version.'))}</p>
        ) : !s.canSet ? (
          <p className="text-sm text-slate-500" data-testid="version-closed">{s.why}</p>
        ) : (
          <>
            {s.version == null ? (
              <div className="space-y-1 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-200" data-testid="version-unknown">
                <p>
                  {s.creationImage
                    ? t('This database has no version: a Start would run {image} on data created by {created}.', { image: s.defaultImage, created: s.creationImage })
                    : t('This database has no version: a Start would run {image}.', { image: s.defaultImage })}
                </p>
                {s.ambiguous && <p>{t('Nobody can tell which release this data runs: the volume was not created by the image that is the default today.')}</p>}
              </div>
            ) : (
              <div className="space-y-1 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-200" data-testid="version-provisional">
                <p>{t('Named {version} by hand on {time}; the server has not run on it yet.', { version: s.version ?? '', time: formatDateTime(s.namedAt ?? '') })}</p>
                <p>{t('The first start tries the named release: one the server does not stay up in is undone, and the release can be named again.')}</p>
              </div>
            )}
            <p className="text-xs text-slate-400">
              {t('For MySQL, MariaDB and MongoDB, a Start on a release the data does not run yet upgrades the data in place, with no way back. Name the release the data runs before the first start, and take a backup first when in doubt.')}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Select aria-label={t('Release to name')} value={chosen ?? ''} onChange={(e) => setPicked(e.target.value)} className="h-9 w-48 text-xs">
                {s.choices.map((v) => (
                  <option key={v} value={v}>{t('{engine} {version}', { engine, version: v })}</option>
                ))}
              </Select>
              <Button size="sm" onClick={() => setConfirm(true)} disabled={set.isPending || chosen == null}>
                {t('Set version')}
              </Button>
            </div>
          </>
        )}
      </CardBody>

      <ConfirmDialog
        open={confirm}
        title={t('Set the version to {engine} {version}?', { engine, version: chosen ?? '' })}
        message={t('The next Start runs that release on the data it has. For MySQL, MariaDB and MongoDB, a release the data does not run yet upgrades the data in place, with no way back; take a backup first when in doubt. Until the server has run on it, the release can be changed.')}
        confirmLabel={t('Set version')}
        confirmDisabled={set.isPending}
        onConfirm={() => chosen != null && set.mutate(chosen)}
        onClose={() => setConfirm(false)}
      />
    </Card>
  );
}
