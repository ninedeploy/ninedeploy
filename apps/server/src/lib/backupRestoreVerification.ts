/** R3: restore a backup into an isolated, networkless engine helper and run a known-data probe there. */
import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { capture, ExecOutputTooLargeError, ExecTimeoutError, run, sleep } from './exec.js';
import { streamFileToCommand } from './fileCommandInput.js';
import { rabbitmqExpected, rabbitmqMissing } from '../engine/extraEngineBackups.js';

/** Engines with an isolated restore adapter. */
export const RESTORE_VERIFICATION_ENGINES = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'valkey', 'keydb', 'dragonfly', 'clickhouse', 'meilisearch', 'rabbitmq'] as const;
export type RestoreVerificationEngine = (typeof RESTORE_VERIFICATION_ENGINES)[number];
export function isRestoreVerificationEngine(engine: string): engine is RestoreVerificationEngine {
  return (RESTORE_VERIFICATION_ENGINES as readonly string[]).includes(engine);
}

export interface RestoreProbe {
  /** Already decrypted, caller-owned backup. Never modified or removed here. */
  file: string;
  /** Managed engine image; resolved to its immutable config ID before use. */
  image: string;
  query: string;
  /** Exact client output (see `helperProfile`'s `query`), excluding its final newline. Never persisted by this adapter. */
  expected: string;
}
export interface RestoreVerificationResult {
  status: 'passed' | 'failed' | 'unverifiable';
  engine: RestoreVerificationEngine;
  /** postgres: plain SQL or a custom archive. mysql/mariadb dumps are always
   *  plain SQL; mongo backups are a gzipped mongodump archive, ClickHouse's a
   *  BACKUP zip archive; the Redis family's are the server's own RDB file. */
  format: 'plain' | 'custom' | 'archive' | 'rdb' | 'definitions' | null;
  imageId: string | null;
  durationMs: number;
  restoreMs: number | null;
  queryMs: number | null;
  queryMatched: boolean;
  cleanupConfirmed: boolean;
  /** Fixed diagnostic only: no engine stderr, SQL, expected value or restored data. */
  error: string | null;
}
const QUICK_MS = 10_000;
const DUMP = '/tmp/nd-restore-source.dump';
/** The helper's only data filesystem holds both the dump and PGDATA. */
const SCRATCH_MIB = 1024;
/** A dump above half the scratch cannot fit beside its own restored data. */
export const RESTORE_VERIFICATION_MAX_DUMP_BYTES = (SCRATCH_MIB / 2) * 1024 * 1024;
const HELPER_ROLE = 'ninedeploy.role=restore-verification';
const HELPER_NAME = /^\/?ninedeploy-restore-check-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Engine messages that mean the bounded helper ran out of room, not that the
 * backup is bad. Only this boolean is used; stderr itself is never kept.
 * MySQL reports a full tmpfs as "The table '…' is full" (ER_RECORD_FILE_FULL);
 * ClickHouse as NOT_ENOUGH_SPACE / MEMORY_LIMIT_EXCEEDED. */
const CAPACITY_ERROR = /No space left on device|could not extend file|out of memory|Cannot allocate memory|The table '[^']*' is full|Got error 28\b|Errcode: 28\b|failed with error 28\b|Out of disk space|NOT_ENOUGH_SPACE|MEMORY_LIMIT_EXCEEDED/i;
/** The client lost its server mid-operation: the engine died, which no dump
 * statement does on a healthy server. Only this boolean is used. */
const LOST_SERVER = /Lost connection to (?:MySQL |MariaDB )?server|server has gone away|server closed the connection unexpectedly/i;

interface HelperProfile {
  user: string;
  /** Where the bounded scratch tmpfs goes: the restored data, and the dump
   *  copy unless the restore streams it. */
  scratch: string;
  /** Other tmpfs mounts: the socket directory, and 1 MiB mounts over the
   *  image's VOLUMEs so no anonymous volume ever holds restored data. */
  mounts: string[];
  env: string[];
  /** Replaces the image's entrypoint (the Redis family's start gate). */
  entrypoint?: string;
  /** After the image. Both MySQL-family entrypoints prepend their daemon to leading flags. */
  args: string[];
  pidsLimit: number;
  readyAttempts: number;
  readyTimeoutMs: number;
  ready: string[];
  /**
   * - `stdin`: the panel streams the dump straight into this client, so no
   *   copy lands in the helper.
   * - `file`: the dump is copied into the scratch first: to `path` (default
   *   `DUMP`), after `prepare` (e.g. creating the directory the engine reads
   *   backups from). `settle` then waits for an engine that applies the
   *   restore asynchronously (RabbitMQ's definitions import), so the probe
   *   never races it.
   * - `preload`: the engine only reads its data file at startup. The dump is
   *   copied to `path`, then the `marker` file releases the gated server
   *   (`startGate`), which either answers `loaded` with output matching
   *   `answer` or exits. An exit whose log matches `rejects` is the backup's
   *   failure.
   */
  restore:
    | { stdin: string[] }
    | { file(format: 'plain' | 'custom'): string[]; path?: string; prepare?: string[]; settle?(name: string, file: string): Promise<void> }
    | { preload: { path: string; marker: string; loaded: string[]; answer: RegExp; rejects: RegExp } };
  query(sql: string): string[];
  /** The probe goes to the client on stdin instead of argv (redis-cli reads commands per line). */
  queryOnStdin?: boolean;
  /** Why this engine's client cannot take `query` at all, or null. Checked before any work. */
  queryProblem?(query: string): string | null;
  /** The client lists rows in no fixed order, so rows compare as a set of lines. */
  unorderedRows?: boolean;
}

/** One row per line, sorted, so a listing in no fixed order compares stably. */
function sortedRows(text: string): string {
  return text.split('\n').sort().join('\n');
}
const PG_CONNECTION = ['-h', '127.0.0.1', '-U', 'nine', '-d', 'app'];
/** A preloading engine's start gate: PID 1 waits for `marker`, then becomes the server. */
const startGate = (marker: string) => `while [ ! -e ${marker} ]; do sleep 0.2; done; exec "$@"`;
/** A Meilisearch probe is a GET path on its own HTTP API, appended to the base URL. */
const MEILI_PROBE = /^\/[\x21-\x7e]*$/;
/** A RabbitMQ probe is one `rabbitmqctl list_…` command: the listing, then
 *  options and column names such as `-p shop name durable`. */
const RABBITMQ_PROBE = /^list_[a-z_]+(?: [A-Za-z0-9_./:-]+)*$/;
/** RabbitMQ applies an import asynchronously; this long is the wait for every
 *  definition the file names to appear, before the probe may run. */
const RABBITMQ_SETTLE_MS = 120_000;
/** A Meilisearch that exits with one of these in its log refused the dump itself. */
const MEILI_DUMP_REJECTED = /failed to iterate over archive|invalid gzip header|unexpected end of file|failed to import the dump|dump .*(version|corrupt|invalid)/i;
/** A Redis-family server that exits with one of these in its log refused the
 *  file itself: a wrong signature, a short or corrupt RDB, an unknown version.
 *  Dragonfly reports every such refusal as "Rdb load failed: …". */
const RDB_REJECTED = /Wrong signature trying to load DB|Short read or OOM loading DB|RDB ERROR DETECTED|Unexpected EOF reading RDB|Can't handle RDB format version|Bad file format|Fatal error loading the DB|Rdb load failed/i;
/** The staged dump on the client's stdin. Positional arguments only: neither
 *  the path nor any byte of the dump ever becomes shell code. */
const STDIN_FROM_FILE = 'f="$1"; shift; exec "$@" < "$f"';

function helperProfile(engine: RestoreVerificationEngine): HelperProfile {
  if (engine === 'postgres') {
    return {
      user: 'postgres',
      scratch: '/tmp',
      mounts: [
        '/var/run/postgresql:rw,nosuid,nodev,mode=1777,size=16m',
        '/var/lib/postgresql:rw,nosuid,nodev,mode=1777,size=1m',
        '/var/lib/postgresql/data:rw,nosuid,nodev,mode=1777,size=1m',
      ],
      env: ['PGDATA=/tmp/nd-restore/data', 'POSTGRES_HOST_AUTH_METHOD=trust', 'POSTGRES_USER=nine', 'POSTGRES_DB=app'],
      args: [],
      pidsLimit: 128,
      readyAttempts: 60,
      readyTimeoutMs: 1000,
      // The entrypoint's temporary initialization server listens on a Unix
      // socket only. Require TCP so it cannot race the final server startup.
      ready: ['pg_isready', ...PG_CONNECTION],
      restore: {
        file: (format) => format === 'custom'
          ? ['pg_restore', '--exit-on-error', '--single-transaction', ...PG_CONNECTION, DUMP]
          : ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', ...PG_CONNECTION, '-f', DUMP],
      },
      // Unaligned, tuples only: `|` between columns, one line per row.
      query: (sql) => ['psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...PG_CONNECTION, '-c', sql],
    };
  }
  if (engine === 'mongo') {
    // No MONGO_INITDB_* variables: the entrypoint starts mongod directly (no
    // temporary initialization server) and without access control. The
    // archive's admin users are restored as data only.
    const host = ['--host', '127.0.0.1'];
    return {
      user: 'mongodb',
      scratch: '/data/db',
      mounts: [
        '/data/configdb:rw,nosuid,nodev,mode=1777,size=1m',
        // mongosh keeps its history and logs under HOME.
        '/tmp:rw,nosuid,nodev,mode=1777,size=64m',
      ],
      // The image sets glibc.pthread.rseq=0 so TCMalloc can use per-CPU
      // caches. On Linux 6.19 through 7.0.13 that crashes, and mongod refuses
      // to start at all. rseq=1 makes TCMalloc fall back to per-thread caches,
      // which start on every kernel; a short-lived helper does not need the
      // per-CPU speed-up.
      env: ['HOME=/tmp', 'GLIBC_TUNABLES=glibc.pthread.rseq=1'],
      args: [],
      // mongod, mongorestore's workers and mongosh each run many threads.
      pidsLimit: 256,
      readyAttempts: 60,
      // mongosh alone takes about a second to start.
      readyTimeoutMs: 5000,
      ready: ['mongosh', '--quiet', '--norc', ...host, '--eval', 'db.adminCommand({ ping: 1 }).ok'],
      // mongodump --archive --gzip on stdin: the whole scratch is left for data.
      restore: { stdin: ['mongorestore', ...host, '--archive', '--gzip', '--stopOnError', '--quiet'] },
      // What mongosh prints for the script's last expression; the default
      // database is `test`, so address others with db.getSiblingDB(…).
      query: (sql) => ['mongosh', '--quiet', '--norc', ...host, '--eval', sql],
    };
  }
  if (engine === 'clickhouse') {
    return {
      user: 'clickhouse',
      // The data path; the image's `<backups><allowed_path>backups</allowed_path>`
      // makes File('…') resolve under its `backups/` directory.
      scratch: '/var/lib/clickhouse',
      mounts: [
        '/var/log/clickhouse-server:rw,nosuid,nodev,mode=1777,size=64m',
        '/tmp:rw,nosuid,nodev,mode=1777,size=64m',
      ],
      // The entrypoint would write user settings under /etc, which is
      // read-only here. The default user, local only, is all the helper needs.
      env: ['CLICKHOUSE_SKIP_USER_SETUP=1'],
      args: [],
      // ClickHouse starts several hundred threads at once (its schedule pool
      // alone asks for 512) and aborts when it cannot.
      pidsLimit: 4096,
      readyAttempts: 60,
      readyTimeoutMs: 2000,
      ready: ['clickhouse-client', '-q', 'SELECT 1'],
      restore: {
        // Every database the archive holds: the panel's backups carry the
        // user databases only. A .zip name makes ClickHouse read it as an archive.
        file: () => ['clickhouse-client', '-q', "RESTORE ALL FROM File('nd-restore.zip')"],
        path: '/var/lib/clickhouse/backups/nd-restore.zip',
        prepare: ['mkdir', '-p', '/var/lib/clickhouse/backups'],
      },
      // TabSeparated: a tab between columns, one line per row, NULL as \N.
      // Unqualified names resolve in `app`, the managed database.
      query: (sql) => ['clickhouse-client', '--database', 'app', '-q', sql],
    };
  }
  if (engine === 'redis' || engine === 'valkey' || engine === 'keydb' || engine === 'dragonfly') {
    const dragonfly = engine === 'dragonfly';
    // Dragonfly ships redis-cli; the forks ship their own server and client names.
    const cli = [dragonfly || engine === 'redis' ? 'redis-cli' : `${engine}-cli`, '-h', '127.0.0.1'];
    const server = dragonfly
      // The managed database's own snapshot flags (`ENGINES.dragonfly`): it
      // loads `/data/dump.rdb`, a Redis-format RDB, while it starts.
      ? ['dragonfly', '--logtostderr', '--dir=/data', '--dbfilename=dump', '--df_snapshot_format=false', '--bind=127.0.0.1', '--port=6379']
      : [`${engine}-server`, '--dir', '/data', '--dbfilename', 'dump.rdb', '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1', '--port', '6379'];
    return {
      user: dragonfly ? 'dfly' : engine,
      // The RDB file and the loaded dataset's working files.
      scratch: '/data',
      mounts: [],
      env: [],
      // The image's entrypoint would start the server at once, before the
      // backup is in place: a gate holds PID 1 until the file is copied.
      entrypoint: 'sh',
      args: ['-c', startGate('/data/.nd-start'), 'nd-restore', ...server],
      pidsLimit: 128,
      readyAttempts: 30,
      readyTimeoutMs: 2000,
      // Only that the gated helper runs; the server itself starts in `restore`.
      ready: ['true'],
      // LOADING until the dataset is in memory, then PONG.
      restore: { preload: { path: '/data/dump.rdb', marker: '/data/.nd-start', loaded: [...cli, 'ping'], answer: /^PONG$/, rejects: RDB_REJECTED } },
      // One command per line on stdin. Replies print raw: one line per value
      // or array element, an empty line for nil.
      query: () => cli,
      queryOnStdin: true,
    };
  }
  if (engine === 'rabbitmq') {
    const definitions = '/var/lib/rabbitmq/nd-restore.json';
    return {
      user: 'rabbitmq',
      // Mnesia, the Erlang cookie and the copied definitions export.
      scratch: '/var/lib/rabbitmq',
      mounts: ['/var/log/rabbitmq:rw,nosuid,nodev,mode=1777,size=16m', '/tmp:rw,nosuid,nodev,mode=1777,size=64m'],
      env: [],
      args: [],
      pidsLimit: 512,
      // The Erlang node answers before the broker has booted: wait for the
      // running application, not a ping. Each CLI call starts an Erlang VM.
      readyAttempts: 90,
      readyTimeoutMs: 5000,
      ready: ['rabbitmq-diagnostics', '-q', 'check_running'],
      restore: {
        // The panel's backups are `rabbitmqctl export_definitions`: users,
        // vhosts, permissions, queues, exchanges, bindings, policies; not messages.
        file: () => ['rabbitmqctl', '-q', 'import_definitions', definitions],
        path: definitions,
        // Every vhost, queue, exchange and binding the file names must be
        // there before the probe runs (the panel's restore waits the same way).
        settle: async (name, file) => {
          const expected = rabbitmqExpected(JSON.parse(await readFile(file, 'utf8')));
          const started = Date.now();
          // Each listing starts an Erlang VM; bound every call, not just the loop.
          while ((await rabbitmqMissing(name, expected, 30_000)).length > 0) {
            if (Date.now() - started >= RABBITMQ_SETTLE_MS) throw new ExecTimeoutError('definitions import', RABBITMQ_SETTLE_MS);
            await sleep(500);
          }
        },
      },
      // Tab-separated rows without headers, e.g. `list_queues -p shop name durable`.
      query: (command) => ['rabbitmqctl', '-q', '--no-table-headers', ...command.split(' ')],
      // rabbitmqctl lists queues, exchanges and bindings in no fixed order.
      unorderedRows: true,
      queryProblem: (command) => (RABBITMQ_PROBE.test(command)
        ? null
        : 'A RabbitMQ probe is one rabbitmqctl list command, such as list_queues -p shop name durable'),
    };
  }
  if (engine === 'meilisearch') {
    const api = 'http://127.0.0.1:7700';
    return {
      // The image has no service user; any unprivileged id owns the tmpfs data.
      user: '65534:65534',
      scratch: '/meili_data',
      mounts: ['/tmp:rw,nosuid,nodev,mode=1777,size=64m'],
      env: [],
      // A dump is imported only at startup (`--import-dump`), so the server
      // waits behind the gate until the dump is in place. No master key: the
      // helper has no network and serves the probe only.
      entrypoint: 'sh',
      args: ['-c', startGate('/meili_data/.nd-start'), 'nd-restore', 'meilisearch',
        '--db-path', '/meili_data/data.ms', '--import-dump', '/meili_data/nd-restore.dump', '--http-addr', '127.0.0.1:7700', '--no-analytics'],
      pidsLimit: 256,
      readyAttempts: 30,
      readyTimeoutMs: 2000,
      ready: ['true'],
      // The import finishes before the server answers /health.
      restore: {
        preload: {
          path: '/meili_data/nd-restore.dump', marker: '/meili_data/.nd-start',
          loaded: ['curl', '-s', `${api}/health`], answer: /"status":"available"/, rejects: MEILI_DUMP_REJECTED,
        },
      },
      // The response body of a GET on that path, e.g. /indexes/movies/documents/1?fields=title.
      query: (path) => ['curl', '-s', '-g', '--max-time', '10', `${api}${path}`],
      queryProblem: (path) => (MEILI_PROBE.test(path) ? null : 'A Meilisearch probe is an API path such as /indexes/movies/documents/1, without spaces'),
    };
  }
  const mysql = engine === 'mysql';
  const client = mysql ? 'mysql' : 'mariadb';
  // The helper's own root has no password and no network; the dump's
  // `mysql` schema replaces the grant tables on disk, never in memory (the
  // panel's dumps carry no FLUSH PRIVILEGES), so the probe still connects.
  const tcp = ['-uroot', '-h', '127.0.0.1', '--protocol=tcp'];
  return {
    user: 'mysql',
    scratch: '/tmp',
    mounts: [
      `${mysql ? '/var/run/mysqld' : '/run/mysqld'}:rw,nosuid,nodev,mode=1777,size=16m`,
      '/var/lib/mysql:rw,nosuid,nodev,mode=1777,size=1m',
    ],
    env: [mysql ? 'MYSQL_ALLOW_EMPTY_PASSWORD=yes' : 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1'],
    // tmpfs does not take native AIO reliably. MySQL's binary log (on by
    // default since 8.0) would only add to the restore's footprint.
    args: ['--datadir=/tmp/nd-restore/data', '--innodb-use-native-aio=0', ...(mysql ? ['--skip-log-bin'] : [])],
    pidsLimit: 128,
    readyAttempts: 120,
    readyTimeoutMs: 1000,
    // Both entrypoints initialize with --skip-networking: TCP means the final server.
    ready: [mysql ? 'mysqladmin' : 'mariadb-admin', 'ping', ...tcp],
    // A batch-mode client stops at the first failing statement and exits non-zero.
    restore: { file: () => ['sh', '-c', STDIN_FROM_FILE, 'restore', DUMP, client, ...tcp] },
    // Tab between columns, one line per row, values unescaped, NULL as `NULL`.
    // Unqualified names resolve in `app`, the managed database.
    query: (sql) => [client, ...tcp, '--batch', '--raw', '--skip-column-names', '--database=app', '-e', sql],
  };
}

/** Why `engine`'s client cannot take this probe query at all, or null. The
 *  drill runner asks before admitting a verification, so a malformed probe is
 *  a 400 instead of a verdict. */
export function restoreProbeProblem(engine: RestoreVerificationEngine, query: string): string | null {
  return helperProfile(engine).queryProblem?.(query) ?? null;
}

/** PostgreSQL entry point (the hosted acceptance fixture's). */
export function verifyPostgresRestore(input: RestoreProbe): Promise<RestoreVerificationResult> {
  return verifyRestore('postgres', input);
}

/**
 * Restore and query a backup inside an ephemeral, networkless engine server.
 * No source database identity/credentials enter this API. Its only writable
 * filesystems are bounded tmpfs mounts. No bind mounts, sockets or published
 * ports; anonymous image volumes are removed as well. A cleanup failure cannot
 * produce a passing result. This verifies the supplied probe, not all data.
 */
export async function verifyRestore(engine: RestoreVerificationEngine, input: RestoreProbe): Promise<RestoreVerificationResult> {
  if (!isRestoreVerificationEngine(engine)) throw new Error('Unsupported restore verification engine');
  if (!input.query.trim() || Buffer.byteLength(input.query) > 16_384 || Buffer.byteLength(input.expected) > 16_384) {
    throw new Error('A restore probe requires a query and an expected result of at most 16384 bytes each');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_@-]*$/.test(input.image)) throw new Error('Invalid restore engine image');
  const problem = restoreProbeProblem(engine, input.query);
  if (problem) throw new Error(problem);
  const profile = helperProfile(engine);
  const started = Date.now();
  const result: RestoreVerificationResult = {
    status: 'unverifiable', engine, format: null, imageId: null,
    durationMs: 0, restoreMs: null, queryMs: null, queryMatched: false,
    cleanupConfirmed: false, error: 'Restore verification did not complete',
  };
  const name = `ninedeploy-restore-check-${randomUUID()}`;
  let createAttempted = false;
  let phase: 'setup' | 'restore' | 'query' = 'setup';
  let oversized = false;
  const docker = (args: string[], timeoutMs = QUICK_MS, maxOutputBytes = 4096, stdin?: Buffer) =>
    capture('docker', args, { timeoutMs, maxOutputBytes }, stdin);
  try {
    const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', input.image])).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Missing immutable image identity');
    result.imageId = imageId;
    const handle = await open(input.file, 'r');
    try {
      // Refuse before any helper exists: an oversized dump cannot fit the
      // bounded scratch, and that says nothing about whether it restores.
      if ((await handle.stat()).size > RESTORE_VERIFICATION_MAX_DUMP_BYTES) {
        oversized = true;
        throw new Error('Backup exceeds the bounded restore verification capacity');
      }
      const header = Buffer.alloc(5);
      const { bytesRead } = await handle.read(header, 0, 5, 0);
      result.format = engine === 'rabbitmq'
        ? 'definitions'
        : engine === 'mongo' || engine === 'clickhouse' || engine === 'meilisearch'
        ? 'archive'
        : 'preload' in profile.restore
          ? 'rdb'
          : engine === 'postgres' && bytesRead === 5 && header.toString('ascii') === 'PGDMP' ? 'custom' : 'plain';
    } finally { await handle.close(); }
    // The caller's private staged file is streamed through exec stdin, read by
    // this process: no second plaintext copy on the panel's disk (a crash
    // between copy and cleanup left one that no housekeeping sweep matched),
    // and Docker's archive API never resolves a path inside the helper's tmpfs.
    createAttempted = true;
    await docker([
      'create', '--name', name, '--label', HELPER_ROLE,
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--user', profile.user, '--pids-limit', String(profile.pidsLimit), '--memory', '1536m', '--cpus', '1',
      '--tmpfs', `${profile.scratch}:rw,nosuid,nodev,mode=1777,size=${SCRATCH_MIB}m`,
      ...profile.mounts.flatMap((mount) => ['--tmpfs', mount]),
      ...profile.env.flatMap((entry) => ['--env', entry]),
      ...(profile.entrypoint ? ['--entrypoint', profile.entrypoint] : []),
      '--pull', 'never', imageId, ...profile.args,
    ]);
    await docker(['start', name]);
    let ready = false;
    for (let attempt = 0; attempt < profile.readyAttempts; attempt++) {
      try {
        await docker(['exec', name, ...profile.ready], profile.readyTimeoutMs);
        ready = true; break;
      } catch { await sleep(1000); }
    }
    if (!ready) throw new Error('Restore helper did not become ready');
    if ('stdin' in profile.restore) {
      phase = 'restore';
      const restoreStarted = Date.now();
      await streamFileToCommand('docker', ['exec', '-i', name, ...profile.restore.stdin], input.file, 300_000);
      result.restoreMs = Date.now() - restoreStarted;
    } else if ('preload' in profile.restore) {
      const { path, marker, loaded, answer } = profile.restore.preload;
      await streamFileToCommand('docker', ['exec', '-i', name, 'sh', '-c', 'umask 077; cat > "$1"', 'restore-copy', path], input.file, 60_000);
      phase = 'restore';
      const restoreStarted = Date.now();
      await docker(['exec', name, 'touch', marker]);
      // The released server reads the file while it starts: it gives the
      // loaded answer once the data is in (PONG, or Meilisearch's healthy
      // status), or it exits.
      for (;;) {
        let reply = '';
        try {
          reply = (await docker(['exec', name, ...loaded], 2000)).trim();
        } catch {
          if ((await docker(['inspect', '--format', '{{.State.Running}}', name])).trim() !== 'true') {
            throw new Error('The engine stopped while loading the backup');
          }
        }
        if (answer.test(reply)) break;
        if (Date.now() - restoreStarted >= 300_000) throw new ExecTimeoutError('restore load', 300_000);
        await sleep(250);
      }
      result.restoreMs = Date.now() - restoreStarted;
    } else {
      if (profile.restore.prepare) await docker(['exec', name, ...profile.restore.prepare]);
      await streamFileToCommand('docker', ['exec', '-i', name, 'sh', '-c', 'umask 077; cat > "$1"', 'restore-copy', profile.restore.path ?? DUMP], input.file, 60_000);
      phase = 'restore';
      const restoreStarted = Date.now();
      await docker(['exec', name, ...profile.restore.file(result.format === 'custom' ? 'custom' : 'plain')], 300_000, 64 * 1024);
      // An asynchronously applied restore counts as done once it has settled.
      await profile.restore.settle?.(name, input.file);
      result.restoreMs = Date.now() - restoreStarted;
    }
    phase = 'query';
    const queryStarted = Date.now();
    const output = profile.queryOnStdin
      ? await docker(['exec', '-i', name, ...profile.query(input.query)], 15_000, 16_386, Buffer.from(`${input.query}\n`))
      : await docker(['exec', name, ...profile.query(input.query)], 15_000, 16_386);
    result.queryMs = Date.now() - queryStarted;
    const printed = output.replace(/\r?\n$/, '');
    result.queryMatched = profile.unorderedRows ? sortedRows(printed) === sortedRows(input.expected) : printed === input.expected;
    result.status = result.queryMatched ? 'passed' : 'failed';
    result.error = result.queryMatched ? null : 'Restored data did not match the expected probe result';
  } catch (error) {
    // Exhausting the bounded helper (scratch or memory) or losing its engine
    // is not evidence that the backup is broken: an operator reads 'failed'
    // as "does not restore". Only a healthy helper's error is the backup's.
    const bounded = error instanceof ExecTimeoutError || error instanceof ExecOutputTooLargeError;
    const rejects = 'preload' in profile.restore ? profile.restore.preload.rejects : undefined;
    const helper = phase !== 'setup' && !bounded ? await helperState(error, name, docker, rejects) : null;
    const unavailable = phase === 'setup' || bounded || (helper !== null && helper !== 'healthy' && helper !== 'rejected');
    result.status = unavailable ? 'unverifiable' : 'failed';
    result.error = oversized || helper === 'exhausted'
      ? 'Backup exceeds the bounded restore verification capacity'
      : unavailable ? `Restore verification could not complete during ${phase}` : `Restore verification failed during ${phase}`;
  } finally {
    let cleanup = true;
    if (createAttempted) {
      try {
        // Use the preallocated random name even if create's reply was lost.
        await docker(['rm', '-f', '-v', name]);
        const retained = await docker(['ps', '-a', '--no-trunc', '-q', '--filter', `name=^/${name}$`]);
        cleanup = retained.trim() === '';
      } catch { cleanup = false; }
    }
    result.cleanupConfirmed = cleanup;
    if (!cleanup) {
      result.status = 'unverifiable';
      result.error = 'Restore verification cleanup could not be confirmed';
    }
    result.durationMs = Date.now() - started;
  }
  return result;
}

/**
 * What a restore/query failure says about the helper rather than the backup.
 * - `exhausted`: an engine out-of-space/out-of-memory message, or a cgroup OOM kill.
 * - `stopped`: the client lost its server, or the helper is no longer running.
 *   Unreadable helper state also lands here: the helper cannot be shown to
 *   have been healthy. MariaDB aborts outright when InnoDB cannot extend a
 *   file on a full tmpfs and its client sees only a lost connection, so a
 *   stopped helper's own log is checked for the same capacity messages.
 * - `rejected`: the stopped engine's log says it refused the file itself
 *   (`rejects`, for engines that load their data file at startup). The
 *   failure is the backup's, as on a healthy helper.
 * - `healthy`: only then is the failure attributed to the backup.
 */
async function helperState(
  error: unknown,
  name: string,
  docker: (args: string[], timeoutMs?: number, maxOutputBytes?: number) => Promise<string>,
  rejects?: RegExp,
): Promise<'exhausted' | 'stopped' | 'rejected' | 'healthy'> {
  const message = error instanceof Error ? error.message : '';
  if (CAPACITY_ERROR.test(message)) return 'exhausted';
  try {
    const [running, oomKilled] = (await docker(['inspect', '--format', '{{.State.Running}} {{.State.OOMKilled}}', name])).trim().split(' ');
    if (oomKilled === 'true') return 'exhausted';
    if (running === 'true' && !LOST_SERVER.test(message)) return 'healthy';
  } catch {
    /* unreadable: not healthy; the log may still say why */
  }
  let capacity = false;
  let rejected = false;
  try {
    // Each line is only tested, never kept: an engine's crash report can
    // quote the statement it was running, i.e. restored data.
    await run('docker', ['logs', '--tail', '200', name], { timeoutMs: QUICK_MS }, (line) => {
      if (CAPACITY_ERROR.test(line)) capacity = true;
      if (rejects?.test(line)) rejected = true;
    });
  } catch {
    /* no log: stopped, without a capacity claim */
  }
  // Capacity wins: "Short read or OOM loading DB" is also logged when memory ran out.
  return capacity ? 'exhausted' : rejected ? 'rejected' : 'stopped';
}

/**
 * Remove restore helpers a crashed panel left behind. A helper holds the
 * decrypted dump and the restored database in tmpfs, and a process that died
 * between create and cleanup (OOM, restart, self-update) never removes it —
 * the same exposure r302 closed for drill scratch files. Only containers with
 * the helper label AND the exact generated name pattern, older than `maxAgeMs`
 * (far above one verification's bounded lifetime), are removed. Best-effort per
 * container; returns the count removed.
 */
export async function pruneRestoreVerificationHelpers(maxAgeMs: number, now = Date.now()): Promise<number> {
  const quick = { timeoutMs: QUICK_MS, maxOutputBytes: 64 * 1024 };
  const ids = (await capture('docker', ['ps', '-a', '--no-trunc', '-q', '--filter', `label=${HELPER_ROLE}`], quick))
    .split('\n').map((line) => line.trim()).filter((id) => /^[a-f0-9]{64}$/.test(id));
  let removed = 0;
  for (const id of ids) {
    try {
      const [created = '', containerName = ''] = (await capture('docker', ['inspect', '--format', '{{.Created}} {{.Name}}', id], quick)).trim().split(' ');
      const createdMs = Date.parse(created);
      if (!HELPER_NAME.test(containerName) || !Number.isFinite(createdMs) || now - createdMs < maxAgeMs) continue;
      await capture('docker', ['rm', '-f', '-v', id], quick);
      removed++;
    } catch {
      /* best effort: the container vanished, or one daemon call failed */
    }
  }
  return removed;
}
