/**
 * R3: the WAL archive of a PostgreSQL database with point-in-time recovery
 * on (`databases.pitr_enabled`). A leaf module: `startDatabase` needs the
 * volume, the mount and the server flags, and engine/postgresPitr.ts (which
 * imports engine/database.ts) builds on them, so nothing here imports the
 * engine back.
 *
 * Layout of the archive volume `<data volume>-wal`, mounted at
 * {@link PITR_ARCHIVE_MOUNT} in the database container:
 *   wal/<segment>.gz            every finished WAL segment, gzip-compressed
 *   wal/<segment>.<off>.backup.gz  PostgreSQL's history file of a base backup
 *   base/<label>/base.tar.gz    a `pg_basebackup -Ft -z -X none` base backup
 *   base/<label>/backup_manifest
 *
 * Compression matters: `archive_timeout` switches to a new 16 MiB segment
 * once a minute whenever anything was written, and a mostly idle segment is
 * zero-padded; gzip turns those into a few kilobytes.
 */
import type { Database } from '@ninedeploy/db';
import { run } from '../lib/exec.js';

/** Where the archive volume is mounted in every container that reads or writes it. */
export const PITR_ARCHIVE_MOUNT = '/nd-wal-archive';
export const PITR_WAL_DIR = `${PITR_ARCHIVE_MOUNT}/wal`;
export const PITR_BASE_DIR = `${PITR_ARCHIVE_MOUNT}/base`;

/** At most this many seconds of committed work wait in an unarchived segment (the RPO). */
export const PITR_ARCHIVE_TIMEOUT_S = 60;

/**
 * `archive_command`. PostgreSQL may retry a segment it archived just before a
 * crash: an existing file then counts only when it holds the same bytes. A
 * different file fails the command, so a diverged history never overwrites
 * the archive (PostgreSQL keeps the segment and retries). The `.part` +
 * `sync` + `mv` makes a segment appear only once it is complete and on disk.
 */
export const PITR_ARCHIVE_COMMAND =
  `f=${PITR_WAL_DIR}/%f.gz; if [ -f "$f" ]; then gzip -dc "$f" | cmp -s - "%p"; ` +
  `else gzip -c "%p" > "$f.part" && sync "$f.part" && mv "$f.part" "$f"; fi`;

/** `restore_command` of a recovery: a missing or damaged segment fails, which PostgreSQL reads as the end of the archive. */
export const PITR_RESTORE_COMMAND = `gzip -dc ${PITR_WAL_DIR}/%f.gz > "%p"`;

/**
 * Flags of every one-off container that touches an archive. The archive is
 * writable by the database's own superuser (who can run programs as
 * `postgres` in its container), so its file names and contents are not
 * trusted: no network, no capabilities beyond the file ownership a
 * restore needs, no privilege gain, a PID bound.
 */
export const PITR_HELPER_FLAGS = ['--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256'] as const;
/** The capabilities a root helper needs to create files owned by `postgres` (tar, chown, chmod). */
export const PITR_OWNERSHIP_CAPS = ['--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER'] as const;

/** The archive volume of a database whose data volume is `volumeName`. */
export function pitrArchiveVolume(volumeName: string): string {
  return `${volumeName}-wal`;
}

/** Whether `startDatabase` runs `d` with WAL archiving: PITR on, PostgreSQL, on the panel host. */
export function pitrArchiving(d: Pick<Database, 'engine' | 'pitrEnabled' | 'serverId'>): boolean {
  return d.engine === 'postgres' && d.pitrEnabled === true && d.serverId == null;
}

/**
 * The server flags that turn archiving on. Command-line settings win over
 * `postgresql.auto.conf`, so an `ALTER SYSTEM` cannot switch archiving off
 * behind the panel's back. `wal_level` is left alone: its default (`replica`)
 * archives, and `logical` (set for logical replication) does too.
 */
export function pitrServerArgs(): string[] {
  return [
    '-c', 'archive_mode=on',
    '-c', `archive_command=${PITR_ARCHIVE_COMMAND}`,
    '-c', `archive_timeout=${PITR_ARCHIVE_TIMEOUT_S}`,
  ];
}

/** Labels of an archive volume: traceable to its database after the row is gone, like the data volume. */
export function pitrArchiveLabels(d: Pick<Database, 'slug' | 'name' | 'ownerUserId'>, image: string): Record<string, string> {
  return {
    'ninedeploy.managed': 'pitr-archive',
    'ninedeploy.database.slug': d.slug,
    'ninedeploy.database.name': d.name,
    'ninedeploy.database.engine': 'postgres',
    'ninedeploy.database.image': image,
    'ninedeploy.owner': String(d.ownerUserId ?? ''),
  };
}

/**
 * Make sure the archive volume exists with `wal/` and `base/` owned by the
 * image's `postgres` user (its uid differs between the Debian and Alpine
 * images, so the image itself does the chown). Idempotent; runs before every
 * start of an archiving database.
 */
export async function ensurePitrArchive(
  d: Pick<Database, 'slug' | 'name' | 'ownerUserId' | 'volumeName'>,
  image: string,
  log: (line: string) => void,
  exists: (name: string) => Promise<boolean>,
): Promise<void> {
  if (!d.volumeName) throw new Error('database has no volume name');
  const volume = pitrArchiveVolume(d.volumeName);
  if (!(await exists(volume))) {
    log(`Creating WAL archive volume ${volume} …`);
    const args = ['volume', 'create'];
    for (const [key, value] of Object.entries(pitrArchiveLabels(d, image))) if (value !== '') args.push('--label', `${key}=${value}`);
    await run('docker', [...args, volume], {}, log);
  }
  await run(
    'docker',
    [
      'run', '--rm', ...PITR_HELPER_FLAGS, ...PITR_OWNERSHIP_CAPS, '--user', '0', '-v', `${volume}:${PITR_ARCHIVE_MOUNT}`, '--entrypoint', 'sh', image,
      '-c', 'mkdir -p "$1/wal" "$1/base" && chown postgres:postgres "$1" "$1/wal" "$1/base" && chmod 700 "$1"', 'sh', PITR_ARCHIVE_MOUNT,
    ],
    { timeoutMs: 120_000 },
    log,
  );
}
