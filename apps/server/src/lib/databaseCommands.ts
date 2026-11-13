/**
 * Docker argv for managed-database maintenance commands, as pure builders
 * (multi-node T6, design §5.4).
 *
 * A database on a node is driven through its agent (`db.exec`, the `db.dump`
 * and `db.restore` stream kinds in agentOps/databases.ts). Those build their
 * `docker` argv HERE, and every builder reproduces, byte for byte, the argv
 * the panel host's own functions in engine/database.ts run for the same
 * engine — pinned against the v0.15.0 recording in
 * test/fixtures/databaseArgv015.json (test/databaseCommands.test.ts). So a
 * node dump is the same file a panel dump is, restorable either way, and a
 * size or credential probe asks the same question.
 *
 * engine/database.ts itself is NOT rewritten on top of these (the panel host's
 * code path stays exactly v0.15.0's); the test is what keeps the two equal.
 *
 * The credentials are the managed ones engine/database.ts `ENGINES` declares
 * (postgres/mongo/clickhouse/rabbitmq user `nine`, database `app`; mysql and
 * mariadb `root`). Pure: no I/O, no import of the engine (the agent loads it).
 */

/**
 * A docker argv and the variables the docker CLI forwards into the container.
 * A secret travels as `docker exec -e NAME` with the value in the CLI's own
 * environment, never as an argv element: every argv is readable by any local
 * user (`ps`, `/proc/<pid>/cmdline`), on the host and in the container, while
 * a process's environment is readable only by its own user and root.
 */
export interface DbCommand {
  argv: string[];
  env: Record<string, string>;
}

/** Spawn options for a {@link DbCommand}: its variables, or nothing when it has none. */
export const dbCommandEnv = (command: DbCommand): { env?: Record<string, string> } =>
  Object.keys(command.env).length > 0 ? { env: command.env } : {};

/** The variable that carries a mysql/mariadb `[client]` option file. */
export const MYSQL_CNF_VAR = 'ND_MYSQL_CNF';

/** A `[client]` option file that gives the password (backslash and double quote escaped). */
export function mysqlClientConfig(password: string): string {
  return `[client]\npassword="${password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
}

/**
 * `sh -c` scripts that hand the option file in {@link MYSQL_CNF_VAR} to the
 * client on fd 3 (`--defaults-extra-file=/dev/fd/3`, which must come first),
 * so stdin stays free for a dump. A heredoc expands the variable once and
 * never evaluates its value. Proven against mysql 8.0 / 9.7 and mariadb
 * 10.6 / 12.3 with a password holding `#"\;$'` and spaces.
 */
const MYSQL_WITH_CNF = ['c="$1"; shift', 'exec "$c" --defaults-extra-file=/dev/fd/3 "$@" 3<<ND_CNF', `$${MYSQL_CNF_VAR}`, 'ND_CNF'].join('\n');
const MYSQL_WITH_CNF_FROM_FILE = ['f="$1"; c="$2"; shift 2', 'exec "$c" --defaults-extra-file=/dev/fd/3 "$@" < "$f" 3<<ND_CNF', `$${MYSQL_CNF_VAR}`, 'ND_CNF'].join('\n');

/**
 * Run a mysql/mariadb client (`mysql`, `mariadb`, `mysqldump`, `mariadb-dump`)
 * as root with the password from an option file, optionally reading `stdinFile`
 * (a path inside the container) as its input. Feeding the file on stdin
 * rather than `-e "source <file>"`: MySQL 9's client no longer runs client
 * commands in `-e` unless given `--commands`, which older clients refuse.
 */
export function mysqlCommand(
  cn: string,
  binary: string,
  password: string,
  args: readonly string[],
  stdinFile?: string,
  opts: { dropGtidPurged?: boolean } = {},
): DbCommand {
  const script = !stdinFile ? MYSQL_WITH_CNF : opts.dropGtidPurged ? MYSQL_WITH_CNF_FROM_FILE_NO_GTID : MYSQL_WITH_CNF_FROM_FILE;
  return {
    argv: ['exec', '-e', MYSQL_CNF_VAR, cn, 'sh', '-c', script, 'sh', ...(stdinFile ? [stdinFile] : []), binary, ...args],
    env: { [MYSQL_CNF_VAR]: mysqlClientConfig(password) },
  };
}

/**
 * MySQL with GTIDs on (the 9.x images' default) writes
 * `SET @@GLOBAL.GTID_PURGED=…` into a dump unless told not to, and restoring
 * that dump into the server that wrote it fails: "ERROR 3546 … must not
 * overlap with @@GLOBAL.GTID_EXECUTED". Backups are taken with
 * `--set-gtid-purged=OFF`; a restore also drops the statement (one line, or
 * several for a multi-server set, up to the one ending in `;`) from the
 * container's own temporary copy, so backups taken before that restore too.
 * POSIX sed; proven on mysql 8.0, 8.4 and 9.7.
 */
const DROP_GTID_PURGED = ['/^SET @@GLOBAL.GTID_PURGED=/{', ':a', '/;$/!{', 'N', 'ba', '}', 'd', '}'].join('\n');
// Rewritten only when the statement is there (a read-only grep first): a dump
// without it (MySQL 8, new backups) is not copied again, which would need its
// size once more in the container's writable layer. A failed rewrite stops
// the restore.
const MYSQL_WITH_CNF_FROM_FILE_NO_GTID = [
  'f="$1"; c="$2"; shift 2',
  `if grep -q '^SET @@GLOBAL.GTID_PURGED=' "$f"; then sed -i -e '${DROP_GTID_PURGED}' "$f" || exit 1; fi`,
  'exec "$c" --defaults-extra-file=/dev/fd/3 "$@" < "$f" 3<<ND_CNF',
  `$${MYSQL_CNF_VAR}`,
  'ND_CNF',
].join('\n');

/** The variables that carry the managed mongo root user's password: for mongosh, and as mongo-tools YAML config. */
export const MONGO_PASSWORD_VAR = 'ND_MONGO_PASSWORD';
export const MONGO_CONFIG_VAR = 'ND_MONGO_CONFIG';

/** A mongo-tools `--config` file that gives the password (YAML double-quoted: backslash and quote escaped). */
export function mongoToolConfig(password: string): string {
  return `password: "${password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
}

/** `mongodump` / `mongorestore` with `--config=/dev/fd/3`, fed like the mysql option file (stdin stays free). */
const MONGO_TOOL_WITH_CONFIG = ['c="$1"; shift', 'exec "$c" --config=/dev/fd/3 "$@" 3<<ND_CFG', `$${MONGO_CONFIG_VAR}`, 'ND_CFG'].join('\n');

/**
 * Run a mongo tool (`mongodump`, `mongorestore`) as the managed root user `nine`
 * with the password from a YAML config on fd 3. Proven on mongo 7.0 and 8.0
 * with a password holding `#"\;$'` and spaces, a wrong one refused.
 */
export function mongoToolCommand(cn: string, tool: string, password: string, args: readonly string[]): DbCommand {
  return {
    argv: ['exec', '-e', MONGO_CONFIG_VAR, cn, 'sh', '-c', MONGO_TOOL_WITH_CONFIG, 'sh', tool, '-u', MONGO_USER, '--authenticationDatabase', 'admin', ...args],
    env: { [MONGO_CONFIG_VAR]: mongoToolConfig(password) },
  };
}

/**
 * Evaluate `expression` in mongosh as the managed root user and print its
 * value: mongosh starts without a connection, connects, and authenticates
 * with the password it reads from {@link MONGO_PASSWORD_VAR} (mongosh has no
 * password variable or file of its own). A failed sign-in throws: a non-zero
 * exit and no value. Prints exactly what `--eval <expression>` printed.
 */
export function mongoshCommand(cn: string, password: string, expression: string): DbCommand {
  const script = `const c = connect('mongodb://127.0.0.1:27017/admin'); c.auth('${MONGO_USER}', process.env.${MONGO_PASSWORD_VAR}); db = c; print(${expression});`;
  return { argv: ['exec', '-e', MONGO_PASSWORD_VAR, cn, 'mongosh', '--nodb', '--quiet', '--eval', script], env: { [MONGO_PASSWORD_VAR]: password } };
}

/** Engines a managed database can run. */
export const DATABASE_ENGINES = ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'valkey', 'clickhouse', 'meilisearch', 'rabbitmq', 'keydb', 'dragonfly'] as const;
export type DatabaseEngineName = (typeof DATABASE_ENGINES)[number];
export const isDatabaseEngine = (value: unknown): value is DatabaseEngineName =>
  typeof value === 'string' && (DATABASE_ENGINES as readonly string[]).includes(value);

/** Engines a node's agent can dump and restore (`db.dump` / `db.restore`); the rest refuse with the same message. */
export const DUMPABLE_ENGINES: ReadonlySet<string> = new Set(['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongo', 'keydb', 'dragonfly']);

/**
 * G1.8: engines `backupDatabase` / `restoreDatabase` support on the PANEL HOST
 * only (engine/extraEngineBackups.ts). A node's agent has no dump kind for
 * them, so a node database of these engines keeps refusing backups.
 */
export const PANEL_ONLY_DUMPABLE_ENGINES: ReadonlySet<string> = new Set(['clickhouse', 'meilisearch', 'rabbitmq']);

/** The refusal for a node database whose engine only the panel host can back up. */
export const panelOnlyBackupRefusal = (engine: string, verb: 'backup' | 'restore'): string =>
  `${verb} of a ${engine} database runs on the panel host only; a database on a node cannot be ${verb === 'backup' ? 'backed up' : 'restored'} yet`;

/**
 * Engines that speak the Redis protocol and keep their data in ONE RDB file,
 * `/data/dump.rdb` ({@link REDIS_DUMP_PATH}): backed up with `SAVE` and a copy
 * of that file, restored by stop / copy over it / start. redis and valkey are
 * the originals; keydb and dragonfly (0.15.6) follow the same file contract.
 * Dragonfly is started with `--df_snapshot_format=false --dbfilename=dump`
 * (engine/database.ts) so that its snapshot IS an RDB file at that path.
 */
export const REDIS_FAMILY_ENGINES: ReadonlySet<string> = new Set(['redis', 'valkey', 'keydb', 'dragonfly']);
export const isRedisFamily = (engine: string): boolean => REDIS_FAMILY_ENGINES.has(engine);

/**
 * The first agent release whose `db.exec` / `db.dump` / `db.restore` accept
 * keydb and dragonfly. An older agent's `engineOperand` refuses them with
 * "Invalid database engine", so the panel asks for an update before placing
 * one of these on a node (modules/databases.ts).
 */
export const AGENT_REDIS_FAMILY_VERSION = '0.15.6';
/** The engines that need {@link AGENT_REDIS_FAMILY_VERSION} on a node. */
export const NODE_ENGINES_NEEDING_NEWER_AGENT: ReadonlySet<string> = new Set(['keydb', 'dragonfly']);

/**
 * One Redis-protocol command inside a managed redis-family database's own
 * container with the stored password: `docker exec -e REDISCLI_AUTH <cn>
 * <cli> …`, where `<cli>` is `redis-cli` for redis, valkey and dragonfly (the
 * Dragonfly image ships a real `/usr/bin/redis-cli`) and `keydb-cli` for
 * keydb. Every one of them reads the password from `REDISCLI_AUTH` (proven
 * on redis 8.8, valkey 9.1, keydb 6.3.4 and dragonfly 1.34.2, a wrong one
 * refused); until 0.18.28 it rode the argv as `-a <pw>`.
 */
export function redisCliCommand(engine: string, cn: string, password: string, ...command: string[]): DbCommand {
  return { argv: ['exec', '-e', 'REDISCLI_AUTH', cn, engine === 'keydb' ? 'keydb-cli' : 'redis-cli', ...command], env: { REDISCLI_AUTH: password } };
}

const PG_USER = 'nine';
const PG_DB = 'app';
const MONGO_USER = 'nine';

/** `databaseSize`: the engine's size query, or null when the engine has none (size 0). */
export function sizeCommand(engine: string, cn: string, password: string): DbCommand | null {
  if (engine === 'postgres') return { argv: ['exec', cn, 'psql', '-U', PG_USER, '-d', PG_DB, '-tAc', 'SELECT pg_database_size(current_database())'], env: {} };
  if (isRedisFamily(engine)) return redisCliCommand(engine, cn, password, 'INFO', 'memory');
  if (engine === 'mysql' || engine === 'mariadb') {
    return mysqlCommand(cn, engine === 'mysql' ? 'mysql' : 'mariadb', password, [
      '-uroot', '-N', '-e', 'SELECT IFNULL(SUM(data_length+index_length),0) FROM information_schema.tables',
    ]);
  }
  if (engine === 'mongo') return mongoshCommand(cn, password, 'db.getSiblingDB("app").stats().dataSize');
  return null;
}

/** The size in bytes `databaseSize` reads from the size query's output (0 when unreadable). */
export function parseSizeOutput(engine: string, out: string): number {
  if (isRedisFamily(engine)) {
    const m = /used_memory:(\d+)/.exec(out);
    return m ? Number(m[1]) : 0;
  }
  if (engine === 'mongo') return Number(out.match(/[\d.]+/)?.[0]) || 0;
  return Number(out.trim()) || 0;
}

/** `probeDatabaseCredentials`: one real sign-in with the stored credentials, or null (no probe: false). */
export function probeCommand(engine: string, cn: string, password: string): DbCommand | null {
  if (engine === 'postgres') {
    // Over the container's own network address (its name, through Docker's DNS on the database's
    // bridge): the image trusts the local socket AND 127.0.0.1, so a probe there signs in with
    // any password; every other address asks for it (scram-sha-256).
    return { argv: ['exec', '-e', 'PGPASSWORD', cn, 'psql', '-h', cn, '-U', PG_USER, '-d', PG_DB, '-tAc', 'SELECT 1'], env: { PGPASSWORD: password } };
  }
  if (engine === 'mysql' || engine === 'mariadb') {
    return mysqlCommand(cn, engine === 'mysql' ? 'mysql' : 'mariadb', password, ['-uroot', '-N', '-e', 'SELECT 1']);
  }
  if (engine === 'mongo') return mongoshCommand(cn, password, 'db.getSiblingDB("app").runCommand({ ping: 1 }).ok');
  if (isRedisFamily(engine)) return redisCliCommand(engine, cn, password, 'PING');
  return null;
}

/** Whether a probe's output is a successful sign-in. */
export function probeSucceeded(engine: string, out: string): boolean {
  return out.trim() === (isRedisFamily(engine) ? 'PONG' : '1');
}

/** `probeMysqlSandboxFlag`: the client's `--help`, or null for engines without the flag. */
export function mysqlHelpCommand(engine: string, cn: string): string[] | null {
  if (engine !== 'mysql' && engine !== 'mariadb') return null;
  return ['exec', cn, engine === 'mysql' ? 'mysql' : 'mariadb', '--help'];
}

/** The sandbox flag the client's `--help` offers, or null. */
export function sandboxFlagFrom(engine: string, help: string): string | null {
  if (engine === 'mariadb') return /(^|\s)--sandbox\b/m.test(help) ? '--sandbox' : null;
  if (engine === 'mysql') return /(^|\s)--system-command\b/m.test(help) ? '--system-command=OFF' : null;
  return null;
}

/** The sandbox flags an import plan may carry (what {@link sandboxFlagFrom} answers). */
export const SANDBOX_FLAGS: ReadonlySet<string> = new Set(['--sandbox', '--system-command=OFF']);

/**
 * `backupDatabase`: the dump, written INSIDE the container (`tmp`, or redis'
 * own `/data/dump.rdb`), then read out. `dump` is the panel host's argv;
 * `file` is the in-container file that holds the dump afterwards (the panel
 * host `docker cp`s it, the node streams it with `cat`); `cleanup` removes a
 * temporary dump (null: redis' own file stays).
 */
export function dumpCommands(engine: string, cn: string, tmp: string, password: string): { dump: DbCommand; file: string; cleanup: string[] | null } {
  if (engine === 'postgres') {
    return {
      dump: { argv: ['exec', cn, 'pg_dump', '-U', PG_USER, '-d', PG_DB, '--clean', '--if-exists', `--file=${tmp}`], env: {} },
      file: tmp,
      cleanup: ['exec', cn, 'rm', '-f', tmp],
    };
  }
  if (engine === 'mysql' || engine === 'mariadb') {
    const dumper = engine === 'mysql' ? 'mysqldump' : 'mariadb-dump';
    return {
      // MySQL: no SET @@GLOBAL.GTID_PURGED (see DROP_GTID_PURGED); mariadb-dump has no such statement or flag.
      dump: mysqlCommand(cn, dumper, password, [
        '-uroot', '--single-transaction', '--quick', '--all-databases', ...(engine === 'mysql' ? ['--set-gtid-purged=OFF'] : []), `--result-file=${tmp}`,
      ]),
      file: tmp,
      cleanup: ['exec', cn, 'rm', '-f', tmp],
    };
  }
  if (isRedisFamily(engine)) {
    // Dragonfly: `SAVE RDB` names the format, so a changed `df_snapshot_format` default cannot turn the dump into a .dfs set.
    // (Dragonfly pads the file with zeros to a multiple of 4096 bytes; it is still a valid RDB file.)
    const save = engine === 'dragonfly' ? redisCliCommand(engine, cn, password, 'SAVE', 'RDB') : redisCliCommand(engine, cn, password, 'SAVE');
    return { dump: save, file: REDIS_DUMP_PATH, cleanup: null };
  }
  if (engine === 'mongo') {
    return {
      dump: mongoToolCommand(cn, 'mongodump', password, [`--archive=${tmp}`, '--gzip']),
      file: tmp,
      cleanup: ['exec', cn, 'rm', '-f', tmp],
    };
  }
  throw new Error(`backup not supported for ${engine}`);
}

/**
 * `restoreDatabase` for the SQL/archive engines: the restore of the dump the
 * caller copied to `tmp` inside the container. redis/valkey have no command —
 * their restore is stop, copy over `/data/dump.rdb`, start.
 */
export function restoreCommand(engine: string, cn: string, tmp: string, password: string): DbCommand {
  if (engine === 'postgres') return { argv: ['exec', cn, 'psql', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-U', PG_USER, '-d', PG_DB, '-f', tmp], env: {} };
  if (engine === 'mysql' || engine === 'mariadb') {
    // The dump on stdin: a batch-mode client stops at the first failing statement and exits non-zero.
    return mysqlCommand(cn, engine === 'mysql' ? 'mysql' : 'mariadb', password, ['-uroot'], tmp, { dropGtidPurged: engine === 'mysql' });
  }
  if (engine === 'mongo') {
    return mongoToolCommand(cn, 'mongorestore', password, [`--archive=${tmp}`, '--gzip', '--drop']);
  }
  throw new Error(`restore not supported for ${engine}`);
}

/**
 * Why a `SAVE` did not take, or null. `redis-cli` exits 0 on an error reply,
 * and `docker cp` of `/data/dump.rdb` would then copy a STALE file as the
 * backup. Every Redis-family engine must check the reply before copying the
 * RDB file, including redis and valkey.
 */
export function saveReplyProblem(engine: string, output: string): string | null {
  if (!isRedisFamily(engine)) return null;
  const text = output.trim();
  return /^OK$/m.test(text) ? null : `SAVE did not answer OK: ${text.slice(0, 300) || 'no reply'}`;
}

/** The in-container path every redis-family engine loads its data from. */
export const REDIS_DUMP_PATH = '/data/dump.rdb';

/** The temp paths the panel host uses inside the container (same prefixes on nodes). */
export const dumpTmpPath = (id: string): string => `/tmp/ninedeploy-dump-${id}`;
export const restoreTmpPath = (id: string): string => `/tmp/ninedeploy-restore-${id}`;
export const importTmpPath = (id: string): string => `/tmp/ninedeploy-import-${id}`;
