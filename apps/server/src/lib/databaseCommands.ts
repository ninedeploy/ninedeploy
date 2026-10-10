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

/** Engines a managed database can run. */
export const DATABASE_ENGINES = ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'valkey', 'clickhouse', 'meilisearch', 'rabbitmq', 'keydb', 'dragonfly'] as const;
export type DatabaseEngineName = (typeof DATABASE_ENGINES)[number];
export const isDatabaseEngine = (value: unknown): value is DatabaseEngineName =>
  typeof value === 'string' && (DATABASE_ENGINES as readonly string[]).includes(value);

/** Engines `backupDatabase` / `restoreDatabase` support (the rest refuse with the same message). */
export const DUMPABLE_ENGINES: ReadonlySet<string> = new Set(['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongo', 'keydb', 'dragonfly']);

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
 * The `docker` argv that runs one Redis-protocol command inside a managed
 * redis-family database's own container with the stored password:
 * `docker exec <cn> <cli> -a <pw> --no-auth-warning …`, where `<cli>` is
 * `redis-cli` for redis, valkey and dragonfly (the Dragonfly image ships a
 * real `/usr/bin/redis-cli`) and `keydb-cli` for keydb. The redis / valkey
 * argv is unchanged since 0.2.
 */
export function redisCliArgv(engine: string, cn: string, password: string, ...command: string[]): string[] {
  return ['exec', cn, engine === 'keydb' ? 'keydb-cli' : 'redis-cli', '-a', password, '--no-auth-warning', ...command];
}

const PG_USER = 'nine';
const PG_DB = 'app';
const MONGO_USER = 'nine';

/** `databaseSize`: the engine's size query, or null when the engine has none (size 0). */
export function sizeCommand(engine: string, cn: string, password: string): string[] | null {
  if (engine === 'postgres') return ['exec', cn, 'psql', '-U', PG_USER, '-d', PG_DB, '-tAc', 'SELECT pg_database_size(current_database())'];
  if (isRedisFamily(engine)) return redisCliArgv(engine, cn, password, 'INFO', 'memory');
  if (engine === 'mysql' || engine === 'mariadb') {
    return [
      'exec', cn, engine === 'mysql' ? 'mysql' : 'mariadb', '-uroot', `--password=${password}`, '-N',
      '-e', 'SELECT IFNULL(SUM(data_length+index_length),0) FROM information_schema.tables',
    ];
  }
  if (engine === 'mongo') {
    return [
      'exec', cn, 'mongosh',
      '-u', MONGO_USER, '-p', password, '--authenticationDatabase', 'admin',
      '--quiet', '--eval', 'db.getSiblingDB("app").stats().dataSize',
    ];
  }
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
export function probeCommand(engine: string, cn: string, password: string): string[] | null {
  if (engine === 'postgres') {
    return ['exec', '-e', `PGPASSWORD=${password}`, cn, 'psql', '-h', '127.0.0.1', '-U', PG_USER, '-d', PG_DB, '-tAc', 'SELECT 1'];
  }
  if (engine === 'mysql' || engine === 'mariadb') {
    return ['exec', cn, engine === 'mysql' ? 'mysql' : 'mariadb', '-uroot', `--password=${password}`, '-N', '-e', 'SELECT 1'];
  }
  if (engine === 'mongo') {
    return [
      'exec', cn, 'mongosh', '-u', MONGO_USER, '-p', password, '--authenticationDatabase', 'admin',
      '--quiet', '--eval', 'db.getSiblingDB("app").runCommand({ ping: 1 }).ok',
    ];
  }
  if (isRedisFamily(engine)) return redisCliArgv(engine, cn, password, 'PING');
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
export function dumpCommands(engine: string, cn: string, tmp: string, password: string): { dump: string[]; file: string; cleanup: string[] | null } {
  if (engine === 'postgres') {
    return {
      dump: ['exec', cn, 'pg_dump', '-U', PG_USER, '-d', PG_DB, '--clean', '--if-exists', `--file=${tmp}`],
      file: tmp,
      cleanup: ['exec', cn, 'rm', '-f', tmp],
    };
  }
  if (engine === 'mysql' || engine === 'mariadb') {
    const dumper = engine === 'mysql' ? 'mysqldump' : 'mariadb-dump';
    return {
      dump: ['exec', cn, dumper, '-uroot', `--password=${password}`, '--single-transaction', '--quick', '--all-databases', `--result-file=${tmp}`],
      file: tmp,
      cleanup: ['exec', cn, 'rm', '-f', tmp],
    };
  }
  if (isRedisFamily(engine)) {
    // Dragonfly: `SAVE RDB` names the format, so a changed `df_snapshot_format` default cannot turn the dump into a .dfs set.
    // (Dragonfly pads the file with zeros to a multiple of 4096 bytes; it is still a valid RDB file.)
    const save = engine === 'dragonfly' ? redisCliArgv(engine, cn, password, 'SAVE', 'RDB') : redisCliArgv(engine, cn, password, 'SAVE');
    return { dump: save, file: REDIS_DUMP_PATH, cleanup: null };
  }
  if (engine === 'mongo') {
    return {
      dump: ['exec', cn, 'mongodump', '-u', MONGO_USER, '-p', password, '--authenticationDatabase', 'admin', `--archive=${tmp}`, '--gzip'],
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
export function restoreCommand(engine: string, cn: string, tmp: string, password: string): string[] {
  if (engine === 'postgres') return ['exec', cn, 'psql', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-U', PG_USER, '-d', PG_DB, '-f', tmp];
  if (engine === 'mysql' || engine === 'mariadb') {
    return ['exec', cn, engine === 'mysql' ? 'mysql' : 'mariadb', '-uroot', `--password=${password}`, '-e', `source ${tmp}`];
  }
  if (engine === 'mongo') {
    return ['exec', cn, 'mongorestore', '-u', MONGO_USER, '-p', password, '--authenticationDatabase', 'admin', `--archive=${tmp}`, '--gzip', '--drop'];
  }
  throw new Error(`restore not supported for ${engine}`);
}

/**
 * Why a `SAVE` did not take, or null. `redis-cli` exits 0 on an error reply,
 * and `docker cp` of `/data/dump.rdb` would then copy a STALE file as the
 * backup. keydb and dragonfly (0.15.6) therefore check the reply; redis and
 * valkey keep their 0.15.0 behaviour unchanged (no check).
 */
export function saveReplyProblem(engine: string, output: string): string | null {
  if (engine !== 'keydb' && engine !== 'dragonfly') return null;
  const text = output.trim();
  return /^OK$/m.test(text) ? null : `SAVE did not answer OK: ${text.slice(0, 300) || 'no reply'}`;
}

/** The in-container path every redis-family engine loads its data from. */
export const REDIS_DUMP_PATH = '/data/dump.rdb';

/** The temp paths the panel host uses inside the container (same prefixes on nodes). */
export const dumpTmpPath = (id: string): string => `/tmp/ninedeploy-dump-${id}`;
export const restoreTmpPath = (id: string): string => `/tmp/ninedeploy-restore-${id}`;
export const importTmpPath = (id: string): string => `/tmp/ninedeploy-import-${id}`;
