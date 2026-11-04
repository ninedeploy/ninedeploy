/** R3: restore a backup into an isolated, networkless engine helper and run a known-data probe there. */
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { capture, ExecOutputTooLargeError, ExecTimeoutError, run, sleep } from './exec.js';
import { streamFileToCommand } from './fileCommandInput.js';

/** Engines with an isolated restore adapter. */
export const RESTORE_VERIFICATION_ENGINES = ['postgres', 'mysql', 'mariadb', 'mongo'] as const;
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
   *  plain SQL; mongo backups are a gzipped mongodump archive. */
  format: 'plain' | 'custom' | 'archive' | null;
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
 * MySQL reports a full tmpfs as "The table '…' is full" (ER_RECORD_FILE_FULL). */
const CAPACITY_ERROR = /No space left on device|could not extend file|out of memory|Cannot allocate memory|The table '[^']*' is full|Got error 28\b|Errcode: 28\b|failed with error 28\b|Out of disk space/i;
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
  /** After the image. Both MySQL-family entrypoints prepend their daemon to leading flags. */
  args: string[];
  pidsLimit: number;
  readyAttempts: number;
  readyTimeoutMs: number;
  ready: string[];
  /** `stdin`: the panel streams the dump straight into this client, so no
   *  copy lands in the helper. `file`: the dump is copied into the scratch
   *  (`DUMP`) first. */
  restore: { stdin: string[] } | { file(format: 'plain' | 'custom'): string[] };
  query(sql: string): string[];
}
const PG_CONNECTION = ['-h', '127.0.0.1', '-U', 'nine', '-d', 'app'];
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
      env: ['HOME=/tmp'],
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
  const docker = (args: string[], timeoutMs = QUICK_MS, maxOutputBytes = 4096) =>
    capture('docker', args, { timeoutMs, maxOutputBytes });
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
      result.format = engine === 'mongo'
        ? 'archive'
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
    } else {
      await streamFileToCommand('docker', ['exec', '-i', name, 'sh', '-c', 'umask 077; cat > "$1"', 'restore-copy', DUMP], input.file, 60_000);
      phase = 'restore';
      const restoreStarted = Date.now();
      await docker(['exec', name, ...profile.restore.file(result.format === 'custom' ? 'custom' : 'plain')], 300_000, 64 * 1024);
      result.restoreMs = Date.now() - restoreStarted;
    }
    phase = 'query';
    const queryStarted = Date.now();
    const output = await docker(['exec', name, ...profile.query(input.query)], 15_000, 16_386);
    result.queryMs = Date.now() - queryStarted;
    result.queryMatched = output.replace(/\r?\n$/, '') === input.expected;
    result.status = result.queryMatched ? 'passed' : 'failed';
    result.error = result.queryMatched ? null : 'Restored data did not match the expected probe result';
  } catch (error) {
    // Exhausting the bounded helper (scratch or memory) or losing its engine
    // is not evidence that the backup is broken: an operator reads 'failed'
    // as "does not restore". Only a healthy helper's error is the backup's.
    const bounded = error instanceof ExecTimeoutError || error instanceof ExecOutputTooLargeError;
    const helper = phase !== 'setup' && !bounded ? await helperState(error, name, docker) : null;
    const unavailable = phase === 'setup' || bounded || (helper !== null && helper !== 'healthy');
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
 * - `healthy`: only then is the failure attributed to the backup.
 */
async function helperState(
  error: unknown,
  name: string,
  docker: (args: string[], timeoutMs?: number, maxOutputBytes?: number) => Promise<string>,
): Promise<'exhausted' | 'stopped' | 'healthy'> {
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
  try {
    // Each line is only tested, never kept: an engine's crash report can
    // quote the statement it was running, i.e. restored data.
    await run('docker', ['logs', '--tail', '200', name], { timeoutMs: QUICK_MS }, (line) => {
      if (CAPACITY_ERROR.test(line)) capacity = true;
    });
  } catch {
    /* no log: stopped, without a capacity claim */
  }
  return capacity ? 'exhausted' : 'stopped';
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
