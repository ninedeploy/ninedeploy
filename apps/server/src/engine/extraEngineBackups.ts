import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { capture, run, sleep } from '../lib/exec.js';
import { writeSecretFile } from '../lib/secretFile.js';

/**
 * G1.8: backup and restore for the three managed engines that used to answer
 * "backup not supported": ClickHouse, Meilisearch and RabbitMQ. Each pair was
 * run end to end against the real images (clickhouse/clickhouse-server:25.8,
 * getmeili/meilisearch:v1.53, rabbitmq:4.0) before it was written down here.
 *
 * Panel host only: a node's agent has no such dump kinds, so
 * lib/nodeDatabase.ts keeps refusing them there.
 *
 * Every function writes or reads a PLAINTEXT file on the panel host; the
 * caller (engine/database.ts) encrypts the backup afterwards and decrypts the
 * restore input before, exactly as for the other engines.
 */

const swallow = () => {};

/**
 * `docker cp` copies a symlink inside the container as a symlink, so a
 * database container could make its "backup" point at a file of the host.
 * Whatever was copied out must be a plain file; anything else is removed.
 */
export function assertCopiedFile(file: string): void {
  let ok = false;
  try {
    ok = lstatSync(file).isFile();
  } catch {
    ok = false;
  }
  if (!ok) {
    rmSync(file, { recursive: true, force: true });
    throw new Error('The database container produced something other than a plain file; refusing to read it');
  }
}

type Log = (line: string) => void;

/** The fields of a managed database row these routines need. */
export interface EngineBackupTarget {
  /** Container name. */
  cn: string;
  /** Decrypted password (ClickHouse/RabbitMQ user password, Meilisearch master key). */
  password: string;
  /** Managed username (`nine` for ClickHouse). */
  username: string;
}

// ── ClickHouse ──────────────────────────────────────────────────────────────
//
// `BACKUP … TO File('<name>')` writes under the server's `<backups>
// <allowed_path>backups</allowed_path>` (default config), i.e.
// /var/lib/clickhouse/backups/<name>, inside the data volume. Only user
// databases are backed up: `BACKUP ALL` would also carry the system schemas,
// which a restore must not touch.

const CLICKHOUSE_BACKUPS_DIR = '/var/lib/clickhouse/backups';
const CLICKHOUSE_SYSTEM_DATABASES = ['system', 'information_schema', 'INFORMATION_SCHEMA'];
/** Plain identifiers only: they are quoted with backticks in the statements below. */
const CLICKHOUSE_DB_NAME = /^[A-Za-z0-9_]+$/;
const CLICKHOUSE_RESTORE_SUFFIX = '__nd_restore';
const CLICKHOUSE_OLD_SUFFIX = '__nd_old';
/** A BACKUP or RESTORE of a large database runs for as long as the copy takes. */
const LONG_OPERATION_MS = 6 * 60 * 60 * 1000;

function clickhouseClient(t: EngineBackupTarget, query: string): string[] {
  return ['exec', t.cn, 'clickhouse-client', '-u', t.username, `--password=${t.password}`, '-q', query];
}

/** The user databases of a running ClickHouse, refusing names the statements could not quote safely. */
async function clickhouseUserDatabases(t: EngineBackupTarget): Promise<string[]> {
  const out = await capture(
    'docker',
    clickhouseClient(
      t,
      `SELECT name FROM system.databases WHERE name NOT IN (${CLICKHOUSE_SYSTEM_DATABASES.map((n) => `'${n}'`).join(', ')}) ORDER BY name FORMAT TSVRaw`,
    ),
  );
  const names = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const odd = names.filter((n) => !CLICKHOUSE_DB_NAME.test(n));
  if (odd.length) throw new Error(`ClickHouse database names with characters other than letters, digits and _ cannot be backed up: ${odd.join(', ')}`);
  return names;
}

export async function backupClickhouse(t: EngineBackupTarget, file: string, log: Log): Promise<void> {
  const dbs = await clickhouseUserDatabases(t);
  const name = `nd-backup-${randomUUID()}.zip`;
  log(`Backing up ClickHouse databases: ${dbs.join(', ')}`);
  try {
    await run('docker', clickhouseClient(t, `BACKUP ${dbs.map((d) => `DATABASE \`${d}\``).join(', ')} TO File('${name}')`), { timeoutMs: LONG_OPERATION_MS }, log);
    await run('docker', ['cp', `${t.cn}:${CLICKHOUSE_BACKUPS_DIR}/${name}`, file], {}, log);
    assertCopiedFile(file);
  } finally {
    await run('docker', ['exec', '-u', '0', t.cn, 'rm', '-f', `${CLICKHOUSE_BACKUPS_DIR}/${name}`], {}, swallow).catch(() => {
      log(`⚠ could not remove the temporary backup ${CLICKHOUSE_BACKUPS_DIR}/${name} from ${t.cn} — delete it by hand`);
    });
  }
}

/** The databases a ClickHouse backup archive holds: its `metadata/<db>.sql` entries (BusyBox `unzip -l` output). */
export function clickhouseArchiveDatabases(listing: string): string[] {
  const names = new Set<string>();
  for (const line of listing.split('\n')) {
    const m = /\smetadata\/([^/\s]+)\.sql\s*$/.exec(line);
    if (m) names.add(m[1] as string);
  }
  return [...names].filter((n) => !CLICKHOUSE_SYSTEM_DATABASES.includes(n)).sort();
}

/** Whether a database exists right now. */
async function clickhouseDatabaseExists(t: EngineBackupTarget, db: string): Promise<boolean> {
  const count = (await capture('docker', clickhouseClient(t, `SELECT count() FROM system.databases WHERE name = '${db}'`))).trim();
  if (count !== '0' && count !== '1') throw new Error(`ClickHouse database existence is unconfirmed for ${db}`);
  return count === '1';
}

/**
 * Restore every database in the archive. Each is first restored under a
 * temporary name. Only when all of them succeeded is each live database
 * renamed aside (`<db>__nd_old`) and its copy renamed into place; the
 * set-aside originals are dropped only after every swap succeeded. A failure
 * while swapping renames the current database's original back, so no step
 * ever leaves a database with neither its old nor its restored data.
 * Databases that are not in the backup are kept.
 */
export async function restoreClickhouse(t: EngineBackupTarget, file: string, log: Log): Promise<void> {
  const name = `nd-restore-${randomUUID()}.zip`;
  const archive = `${CLICKHOUSE_BACKUPS_DIR}/${name}`;
  /** Databases whose original was renamed aside, and those whose restored copy is live. */
  const setAside: string[] = [];
  const promoted = new Set<string>();
  let swapped = false;
  try {
    await run('docker', ['cp', file, `${t.cn}:${archive}`], {}, log);
    // `docker cp` keeps the panel's uid and the 0600 mode of the decrypted
    // temp file; the server runs as `clickhouse` and must read it.
    await run('docker', ['exec', '-u', '0', t.cn, 'chown', 'clickhouse:clickhouse', archive], {}, log);
    const dbs = clickhouseArchiveDatabases(await capture('docker', ['exec', t.cn, 'unzip', '-l', archive]));
    if (!dbs.length) throw new Error('The backup holds no ClickHouse database');
    const odd = dbs.filter((n) => !CLICKHOUSE_DB_NAME.test(n));
    if (odd.length) throw new Error(`The backup holds database names this restore cannot quote safely: ${odd.join(', ')}`);
    const reserved = dbs.flatMap(db => [`${db}${CLICKHOUSE_RESTORE_SUFFIX}`, `${db}${CLICKHOUSE_OLD_SUFFIX}`]);
    if (reserved.some(name => dbs.includes(name))) throw new Error('ClickHouse backup database names conflict with recovery names');
    for (const name of reserved) {
      if (await clickhouseDatabaseExists(t, name)) throw new Error(`ClickHouse recovery database ${name} already exists; retain it for review`);
    }
    log(`Restoring ClickHouse databases: ${dbs.join(', ')}`);
    for (const db of dbs) {
      const tmp = `${db}${CLICKHOUSE_RESTORE_SUFFIX}`;
      await run('docker', clickhouseClient(t, `RESTORE DATABASE \`${db}\` AS \`${tmp}\` FROM File('${name}')`), { timeoutMs: LONG_OPERATION_MS }, log);
    }
    for (const db of dbs) {
      const old = `${db}${CLICKHOUSE_OLD_SUFFIX}`;
      if (await clickhouseDatabaseExists(t, db)) {
        await run('docker', clickhouseClient(t, `RENAME DATABASE \`${db}\` TO \`${old}\``), {}, log);
        setAside.push(db);
      }
      await run('docker', clickhouseClient(t, `RENAME DATABASE \`${db}${CLICKHOUSE_RESTORE_SUFFIX}\` TO \`${db}\``), {}, log);
      promoted.add(db);
    }
    swapped = true;
    for (const db of setAside) {
      await run('docker', clickhouseClient(t, `DROP DATABASE IF EXISTS \`${db}${CLICKHOUSE_OLD_SUFFIX}\` SYNC`), {}, log).catch(() => {
        log(`⚠ could not drop the previous copy ${db}${CLICKHOUSE_OLD_SUFFIX}; drop it by hand`);
      });
    }
  } finally {
    if (!swapped) {
      // An original that was set aside but whose copy never went live comes back.
      for (const db of setAside.filter((d) => !promoted.has(d))) {
        await run('docker', clickhouseClient(t, `RENAME DATABASE \`${db}${CLICKHOUSE_OLD_SUFFIX}\` TO \`${db}\``), {}, swallow).catch(() => {
          log(`⚠ the original of ${db} is kept as ${db}${CLICKHOUSE_OLD_SUFFIX}; rename it back by hand`);
        });
      }
      for (const db of setAside.filter((d) => promoted.has(d))) {
        log(`⚠ ${db} was already restored before the failure; its previous data is kept as ${db}${CLICKHOUSE_OLD_SUFFIX}`);
      }
      // A failed or interrupted command may still have changed the server.
      // Keep all remaining copies for inspection rather than guessing ownership.
    }
    await run('docker', ['exec', '-u', '0', t.cn, 'rm', '-f', archive], {}, swallow).catch(() => undefined);
  }
}

// ── RabbitMQ ────────────────────────────────────────────────────────────────
//
// The definitions export: users, virtual hosts, permissions, queues,
// exchanges, bindings, policies and parameters, NOT the messages in the
// queues. An import adds and updates what the file names; it does not delete
// objects created after the backup.
//
// Every CLI call runs as the image's `rabbitmq` user: run as root on a server
// that is still starting, rabbitmqctl creates /var/lib/rabbitmq/.erlang.cookie
// as root (0400) before the server does, and the server then cannot read it
// and never starts (seen with rabbitmq:4.0.9 and 4.x).
const RABBITMQ_USER = 'rabbitmq';

export async function backupRabbitmq(t: Pick<EngineBackupTarget, 'cn'>, file: string, log: Log): Promise<void> {
  const tmp = `/tmp/ninedeploy-definitions-${randomUUID()}.json`;
  try {
    await run('docker', ['exec', '-u', RABBITMQ_USER, t.cn, 'rabbitmqctl', 'export_definitions', tmp], {}, log);
    await run('docker', ['cp', `${t.cn}:${tmp}`, file], {}, log);
    assertCopiedFile(file);
  } finally {
    await run('docker', ['exec', '-u', RABBITMQ_USER, t.cn, 'rm', '-f', tmp], {}, swallow).catch(() => undefined);
  }
}

/** The objects a definitions file names that the restore waits to see on the server. */
export interface RabbitmqExpected {
  vhosts: string[];
  /** `vhost\tname` */
  queues: string[];
  /** `vhost\tname`, the built-in `amq.*` and default exchanges left out */
  exchanges: string[];
  /** `vhost\tsource\tdestination\trouting key` */
  bindings: string[];
}

export function rabbitmqExpected(defs: unknown): RabbitmqExpected {
  const o = (defs && typeof defs === 'object' ? defs : {}) as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(o[key]) ? (o[key] as Array<Record<string, unknown>>) : []);
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    vhosts: list('vhosts').map((v) => s(v['name'])).filter(Boolean),
    queues: list('queues').map((q) => `${s(q['vhost'])}\t${s(q['name'])}`),
    exchanges: list('exchanges').filter((e) => s(e['name']) && !s(e['name']).startsWith('amq.')).map((e) => `${s(e['vhost'])}\t${s(e['name'])}`),
    bindings: list('bindings').map((b) => `${s(b['vhost'])}\t${s(b['source'])}\t${s(b['destination'])}\t${s(b['routing_key'])}`),
  };
}

/** `rabbitmqctl -q --no-table-headers <list command>` as trimmed lines. */
async function rabbitmqList(cn: string, ...args: string[]): Promise<string[]> {
  const out = await capture('docker', ['exec', '-u', RABBITMQ_USER, cn, 'rabbitmqctl', '-q', '--no-table-headers', ...args]);
  return out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
}

/** What is still missing on the server, as readable items; empty once the import is applied. */
async function rabbitmqMissing(cn: string, expected: RabbitmqExpected): Promise<string[]> {
  const missing: string[] = [];
  const vhosts = new Set(await rabbitmqList(cn, 'list_vhosts', 'name'));
  for (const v of expected.vhosts) if (!vhosts.has(v)) missing.push(`vhost ${v}`);
  if (missing.length) return missing;
  const byVhost = new Set([...expected.queues, ...expected.exchanges, ...expected.bindings].map((k) => k.split('\t')[0] as string));
  for (const v of byVhost) {
    const queues = new Set((await rabbitmqList(cn, 'list_queues', '-p', v, 'name')).map((n) => `${v}\t${n}`));
    for (const q of expected.queues) if (q.startsWith(`${v}\t`) && !queues.has(q)) missing.push(`queue ${q.replace('\t', '/')}`);
    const exchanges = new Set((await rabbitmqList(cn, 'list_exchanges', '-p', v, 'name')).map((n) => `${v}\t${n}`));
    for (const e of expected.exchanges) if (e.startsWith(`${v}\t`) && !exchanges.has(e)) missing.push(`exchange ${e.replace('\t', '/')}`);
    const bindings = new Set((await rabbitmqList(cn, 'list_bindings', '-p', v, 'source_name', 'destination_name', 'routing_key')).map((l) => `${v}\t${l}`));
    for (const b of expected.bindings) if (b.startsWith(`${v}\t`) && !bindings.has(b)) missing.push(`binding ${b.split('\t').slice(1).join(' → ')}`);
  }
  return missing;
}

const RABBITMQ_IMPORT_WAIT_MS = 5 * 60 * 1000;

export async function restoreRabbitmq(
  t: Pick<EngineBackupTarget, 'cn'>,
  file: string,
  log: Log,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  // Read first: a file that is not a definitions export never reaches the server.
  let expected: RabbitmqExpected;
  try {
    expected = rabbitmqExpected(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`The backup is not a RabbitMQ definitions file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const tmp = `/tmp/ninedeploy-restore-${randomUUID()}.json`;
  try {
    await run('docker', ['cp', file, `${t.cn}:${tmp}`], {}, log);
    await run('docker', ['exec', '-u', '0', t.cn, 'chmod', '0644', tmp], {}, log);
    await run('docker', ['exec', '-u', RABBITMQ_USER, t.cn, 'rabbitmqctl', 'import_definitions', tmp], {}, log);
    // RabbitMQ 4 applies the import asynchronously; the restore is reported
    // done only once every vhost, queue, exchange and binding is there.
    const deadline = Date.now() + (opts.timeoutMs ?? RABBITMQ_IMPORT_WAIT_MS);
    for (;;) {
      const missing = await rabbitmqMissing(t.cn, expected);
      if (!missing.length) break;
      if (Date.now() > deadline) throw new Error(`The RabbitMQ definitions import did not complete; still missing: ${missing.slice(0, 5).join(', ')}`);
      await sleep(opts.pollMs ?? 1000);
    }
    log('RabbitMQ definitions applied');
  } finally {
    await run('docker', ['exec', '-u', '0', t.cn, 'rm', '-f', tmp], {}, swallow).catch(() => undefined);
  }
}

// ── Meilisearch ─────────────────────────────────────────────────────────────
//
// Backup: `POST /dumps`, wait for the task, copy `/meili_data/dumps/<uid>.dump`.
// Restore: Meilisearch imports a dump only at startup (`--import-dump`), into
// an empty database path. The database is stopped, a one-off container of the
// same image imports the dump into a NEW path on the same volume, and only
// after it reports healthy are the paths swapped. A failed import leaves the
// current data in place; the database is started again either way.

const MEILI_DATA = '/meili_data';
const MEILI_DB = 'data.ms';
const MEILI_DUMP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MEILI_IMPORT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * An authenticated call to the database's own API. The master key travels on
 * curl's stdin (`-H @-`), never on argv: argv is visible to `ps` in the
 * container and lands, unmasked, in exec error labels.
 */
function meiliApi(t: Pick<EngineBackupTarget, 'cn' | 'password'>, ...args: string[]): Promise<string> {
  return capture(
    'docker',
    ['exec', '-i', t.cn, 'curl', '-sS', '--fail-with-body', '-H', '@-', ...args],
    {},
    Buffer.from(`Authorization: Bearer ${t.password}\n`),
  );
}

/** The task fields a dump wait reads. */
interface MeiliTask {
  status?: string;
  details?: { dumpUid?: string | null } | null;
  error?: { message?: string } | null;
}

export async function backupMeilisearch(
  t: Pick<EngineBackupTarget, 'cn' | 'password'>,
  file: string,
  log: Log,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const enqueued = JSON.parse(await meiliApi(t, '-X', 'POST', 'http://localhost:7700/dumps')) as { taskUid?: number };
  if (typeof enqueued.taskUid !== 'number') throw new Error('Meilisearch did not accept the dump request');
  log(`Meilisearch dump task ${enqueued.taskUid} enqueued`);
  const deadline = Date.now() + (opts.timeoutMs ?? MEILI_DUMP_TIMEOUT_MS);
  let task: MeiliTask = {};
  for (;;) {
    task = JSON.parse(await meiliApi(t, `http://localhost:7700/tasks/${enqueued.taskUid}`)) as MeiliTask;
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'canceled') break;
    if (Date.now() > deadline) throw new Error(`The Meilisearch dump task ${enqueued.taskUid} did not finish in time`);
    await sleep(opts.pollMs ?? 1000);
  }
  if (task.status !== 'succeeded') throw new Error(`The Meilisearch dump ${task.status}: ${task.error?.message ?? 'no reason given'}`);
  const uid = task.details?.dumpUid;
  if (!uid || !/^[A-Za-z0-9._-]+$/.test(uid)) throw new Error('The Meilisearch dump task named no dump file');
  const inContainer = `${MEILI_DATA}/dumps/${uid}.dump`;
  try {
    await run('docker', ['cp', `${t.cn}:${inContainer}`, file], {}, log);
    assertCopiedFile(file);
  } finally {
    await run('docker', ['exec', t.cn, 'rm', '-f', inContainer], {}, swallow).catch(() => undefined);
  }
}

export async function restoreMeilisearch(
  t: Pick<EngineBackupTarget, 'cn' | 'password'> & { volumeName: string; image: string },
  file: string,
  log: Log,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const id = randomUUID();
  const dump = `${MEILI_DATA}/nd-restore-${id}.dump`;
  const newDb = `nd-restore-${id}.ms`;
  const oldDb = `${MEILI_DB}.nd-old-${id}`;
  const importer = `${t.cn}-nd-restore`;
  const volume = `${t.volumeName}:${MEILI_DATA}`;
  const inVolume = (script: string) =>
    run('docker', ['run', '--rm', '-v', volume, '-w', MEILI_DATA, '--entrypoint', 'sh', t.image, '-c', script], {}, log);
  let swapped = false;
  await run('docker', ['cp', file, `${t.cn}:${dump}`], {}, log);
  await run('docker', ['stop', t.cn], {}, log);
  try {
    await run('docker', ['rm', '-f', importer], {}, swallow).catch(() => undefined);
    const envFile = writeSecretFile('nd-db', 'meili-restore.env', `MEILI_MASTER_KEY=${t.password}\nMEILI_NO_ANALYTICS=true\n`);
    try {
      await run(
        'docker',
        ['run', '-d', '--name', importer, '--network', 'none', '-v', volume, '--env-file', envFile.path, t.image,
          'meilisearch', '--db-path', `${MEILI_DATA}/${newDb}`, '--import-dump', dump],
        {},
        log,
      );
    } finally {
      envFile.cleanup();
    }
    // The dump is imported before Meilisearch starts serving, so the first
    // healthy answer means the import finished.
    const deadline = Date.now() + (opts.timeoutMs ?? MEILI_IMPORT_TIMEOUT_MS);
    for (;;) {
      const health = await capture('docker', ['exec', importer, 'curl', '-s', 'http://localhost:7700/health']).catch(() => '');
      if (health.includes('"available"')) break;
      const state = (await capture('docker', ['inspect', '--format', '{{.State.Running}}', importer]).catch(() => 'false')).trim();
      if (state !== 'true') {
        const logs = await capture('docker', ['logs', '--tail', '20', importer]).catch(() => '');
        throw new Error(`The Meilisearch dump import failed${logs ? `: ${logs.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
      }
      if (Date.now() > deadline) throw new Error('The Meilisearch dump import did not finish in time');
      await sleep(opts.pollMs ?? 1000);
    }
    await run('docker', ['stop', importer], {}, log);
    // One script, so a failed second move puts the original back before the
    // database starts: it must never start on a missing data.ms (an empty one).
    await inVolume(`mv ${MEILI_DB} ${oldDb} && { mv ${newDb} ${MEILI_DB} || { mv ${oldDb} ${MEILI_DB}; exit 1; }; }`);
    swapped = true;
  } finally {
    await run('docker', ['rm', '-f', importer], {}, swallow).catch(() => undefined);
    // Started again either way. If it does not start, nothing is cleaned up:
    // the previous data (`${oldDb}`) is still on the volume to recover from.
    await run('docker', ['start', t.cn], {}, log);
    // After the swap the previous data goes; before it, the half-imported
    // copy does. Either way the dump goes.
    await inVolume(`rm -rf ${swapped ? oldDb : newDb} nd-restore-${id}.dump`).catch(() => {
      log(`⚠ could not clean up ${swapped ? oldDb : newDb} in volume ${t.volumeName}`);
    });
  }
}
