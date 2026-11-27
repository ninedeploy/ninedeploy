import { z } from 'zod';

/**
 * N12: every statement a major upgrade runs, in ONE catalogue. The panel host
 * runs a statement's `text` through `docker exec` itself (lib/databaseUpgrade.ts
 * `databaseUpgradeDeps`). A node runs the statement by NAME: the agent builds
 * the same text from this catalogue (agentOps/databaseUpgrade.ts), so a request
 * to a node never carries SQL, and both hosts run exactly the same words.
 */

/** psql field separator (ASCII unit separator: never part of a name in practice). */
export const SEP = '\u001f';
const SYSTEM_SCHEMAS = `('pg_catalog','information_schema')`;
const USER_RELATION = `n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp' AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = c.oid AND dep.deptype = 'e')`;
/** MySQL's own accounts, present in every 8.x and 9.x data directory. */
const MYSQL_SYSTEM_USERS = `('mysql.sys','mysql.session','mysql.infoschema')`;
const MYSQL_SYSTEM_SCHEMAS = `('mysql','information_schema','performance_schema','sys')`;
/** MySQL/MariaDB: tables counted per statement: one UNION ALL of exact counts. */
export const COUNT_CHUNK = 100;

/** psql statements: the exec default. MySQL statements: as long as a count over big tables may take. */
const PG_TIMEOUT_MS = 30 * 60 * 1000;
const MYSQL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const singleLine = (value: string) => ![...value].some((c) => [0, 10, 13].includes(c.charCodeAt(0)));
const identifier = (max: number) => z.string().min(1).max(max).refine(singleLine, 'Expected a single-line identifier');

/** What a node needs besides the statement's name to build its text. */
export const upgradeStatementArgs = z.object({
  /** `postgres.otherDatabases`: the row's database, the one the upgrade carries over. */
  dbName: identifier(100).optional(),
  /** `mysql.tableCounts`: the tables of one chunk, and the index of its first among all of them. */
  tables: z.array(z.object({ schema: identifier(64), table: identifier(64) }).strict()).min(1).max(COUNT_CHUNK).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  /** `mongo.setFeatureCompatibilityVersion`: the release the data directory is told it runs now (`7.0`). */
  series: z.string().regex(/^\d+\.\d+$/).optional(),
}).strict();
export type UpgradeStatementArgs = z.infer<typeof upgradeStatementArgs>;
export interface UpgradeTable {
  schema: string;
  table: string;
}

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const mysqlIdent = (name: string) => `\`${name.replace(/`/g, '``')}\``;

/** The managed MongoDB user, as `lib/databaseCommands.ts` names it. */
const MONGO_USER = 'nine';
/** `sh -c` around mongosh: the script comes as `$1`, the password on fd 3 (a pipe, never a file, never argv). */
const MONGO_EVAL_SH = 'exec mongosh --nodb --quiet --eval "$1" 3<&0';
/** What mongosh evaluates: it reads the password from fd 3, signs in on loopback, and prints the statement. */
const mongoScript = (expression: string) =>
  `const pw = require('fs').readFileSync('/dev/fd/3', 'utf8').trim(); const c = connect('mongodb://127.0.0.1:27017/admin'); c.auth('${MONGO_USER}', pw); db = c; print(${expression});`;

interface Spec {
  /** `mysql` also serves MariaDB; `mongo` is a mongosh expression. */
  family: 'postgres' | 'mysql' | 'mongo';
  timeoutMs: number;
  /** The arguments the statement reads; any other is refused on a node. */
  args: readonly (keyof UpgradeStatementArgs)[];
  /** PostgreSQL: the database the statement connects to (default: the row's). */
  database?: string;
  build: (args: UpgradeStatementArgs) => string;
}

/** The PostgreSQL majors an upgrade can target are in lib/databaseUpgrade.ts; these are the words both hosts run. */
export const UPGRADE_STATEMENTS = {
  'postgres.serverVersionNum': { family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [], build: () => `SELECT current_setting('server_version_num')` },
  'postgres.databaseSize': { family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [], build: () => 'SELECT pg_database_size(current_database())' },
  'postgres.otherDatabases': {
    family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: ['dbName'],
    build: (a) => `SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres', ${literal(a.dbName!)}) ORDER BY 1`,
  },
  'postgres.otherRoles': { family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [], build: () => `SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> current_user ORDER BY 1` },
  'postgres.tablesInPostgresDb': {
    family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [], database: 'postgres',
    build: () => `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','m','v','S') AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname !~ '^pg_'`,
  },
  /** A node asks this until the server accepts connections (the panel host asks pg_isready). */
  'postgres.ping': { family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [], build: () => 'SELECT 1' },
  'postgres.analyze': { family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [], build: () => 'ANALYZE' },
  'postgres.fingerprint.rows': {
    family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [],
    build: () =>
      `SELECT n.nspname || '.' || c.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','m') AND ${USER_RELATION} ORDER BY 1`,
  },
  'postgres.fingerprint.sequences': {
    family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [],
    build: () => `SELECT schemaname || '.' || sequencename, coalesce(last_value::text, 'null') FROM pg_sequences WHERE schemaname NOT IN ${SYSTEM_SCHEMAS} ORDER BY 1`,
  },
  // NOT NULL constraints are catalogued in pg_constraint from PostgreSQL 18
  // (contype 'n'), so they are left out: the count would differ by major alone.
  // An index is a class of its own: pg_index joins it (pg_class has no
  // `indexrelid`; until N12 this read `c.indexrelid` and failed the whole upgrade).
  'postgres.fingerprint.objects': {
    family: 'postgres', timeoutMs: PG_TIMEOUT_MS, args: [],
    build: () => `SELECT
    (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_RELATION}),
    (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE k.contype <> 'n' AND n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname !~ '^pg_'),
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND ${USER_RELATION}),
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND ${USER_RELATION}),
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname !~ '^pg_' AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e')),
    (SELECT coalesce(string_agg(extname, ',' ORDER BY extname), '') FROM pg_extension)`,
  },
  'mysql.serverVersion': { family: 'mysql', timeoutMs: MYSQL_TIMEOUT_MS, args: [], build: () => 'SELECT VERSION()' },
  /** A node asks this until the server accepts connections. */
  'mysql.ping': { family: 'mysql', timeoutMs: MYSQL_TIMEOUT_MS, args: [], build: () => 'SELECT 1' },
  'mysql.fastShutdown': { family: 'mysql', timeoutMs: MYSQL_TIMEOUT_MS, args: [], build: () => 'SET GLOBAL innodb_fast_shutdown = 0' },
  'mysql.nativeAccounts': {
    family: 'mysql', timeoutMs: MYSQL_TIMEOUT_MS, args: [],
    build: () => `SELECT CONCAT(user, '@', host) FROM mysql.user WHERE plugin = 'mysql_native_password' AND user NOT IN ${MYSQL_SYSTEM_USERS} ORDER BY 1`,
  },
  'mysql.userTables': {
    family: 'mysql', timeoutMs: MYSQL_TIMEOUT_MS, args: [],
    build: () => `SELECT HEX(TABLE_SCHEMA), HEX(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED') AND TABLE_SCHEMA NOT IN ${MYSQL_SYSTEM_SCHEMAS} ORDER BY TABLE_SCHEMA, TABLE_NAME`,
  },
  'mysql.tableCounts': {
    family: 'mysql', timeoutMs: MYSQL_TIMEOUT_MS, args: ['tables', 'offset'],
    build: (a) => (a.tables as UpgradeTable[]).map((t, k) => `SELECT ${(a.offset as number) + k}, COUNT(*) FROM ${mysqlIdent(t.schema)}.${mysqlIdent(t.table)}`).join(' UNION ALL '),
  },
  'mysql.objects': {
    family: 'mysql', timeoutMs: MYSQL_TIMEOUT_MS, args: [],
    build: () => {
      const notSystem = (col: string) => `${col} NOT IN ${MYSQL_SYSTEM_SCHEMAS}`;
      return `SELECT
    (SELECT COUNT(*) FROM (SELECT DISTINCT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE ${notSystem('TABLE_SCHEMA')}) x),
    (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE ${notSystem('CONSTRAINT_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.VIEWS WHERE ${notSystem('TABLE_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE ${notSystem('TRIGGER_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ${notSystem('ROUTINE_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.EVENTS WHERE ${notSystem('EVENT_SCHEMA')}),
    (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE ${notSystem('SCHEMA_NAME')})`;
    },
  },
  'mysql.users': { family: 'mysql', timeoutMs: MYSQL_TIMEOUT_MS, args: [], build: () => 'SELECT HEX(CONCAT(user, \'@\', host)) FROM mysql.user ORDER BY 1' },
  // ── MongoDB (N12): the server moves one release at a time, and its data directory has a release of its own ──
  // Each is an expression mongosh prints, as `lib/databaseCommands.ts` runs a probe.
  'mongo.serverVersion': { family: 'mongo', timeoutMs: PG_TIMEOUT_MS, args: [], build: () => 'db.version()' },
  /** The release the DATA runs (`6.0`), which can lag behind the binary: a binary starts on its own release and the one before. */
  'mongo.featureCompatibilityVersion': {
    family: 'mongo', timeoutMs: PG_TIMEOUT_MS, args: [],
    build: () => 'db.adminCommand({ getParameter: 1, featureCompatibilityVersion: 1 }).featureCompatibilityVersion.version',
  },
  /** A node asks this until the server accepts connections. */
  'mongo.ping': { family: 'mongo', timeoutMs: PG_TIMEOUT_MS, args: [], build: () => 'db.adminCommand({ ping: 1 }).ok' },
  // `confirm: true` is required from 7.0 on: the answer says the change cannot be undone without support.
  'mongo.setFeatureCompatibilityVersion': {
    family: 'mongo', timeoutMs: PG_TIMEOUT_MS, args: ['series'],
    build: (a) => `JSON.stringify(db.adminCommand({ setFeatureCompatibilityVersion: '${a.series}', confirm: true }))`,
  },
  /** `[database, kind, exact count, indexes]` for every collection of every database that is not a system one, in order. */
  'mongo.inventory': {
    family: 'mongo', timeoutMs: MYSQL_TIMEOUT_MS, args: [],
    build: () => "JSON.stringify(db.adminCommand({ listDatabases: 1 }).databases.map((x) => x.name).filter((n) => !['admin', 'config', 'local'].includes(n)).sort().map((n) => { const dd = db.getSiblingDB(n); return dd.getCollectionInfos({}).sort((a, b) => a.name.localeCompare(b.name)).map((ci) => [n + '.' + ci.name, ci.type, dd.getCollection(ci.name).countDocuments({}), dd.getCollection(ci.name).getIndexes().length]); }))",
  },
  'mongo.users': {
    family: 'mongo', timeoutMs: MYSQL_TIMEOUT_MS, args: [],
    build: () => "JSON.stringify(db.getSiblingDB('admin').getUsers().users.map((u) => u._id).sort())",
  },
} as const satisfies Record<string, Spec>;
export type UpgradeStatementName = keyof typeof UPGRADE_STATEMENTS;
export type UpgradeStatementFamily = Spec['family'];

/** How a MongoDB statement is run as the managed user — on the panel host and on a node alike: the script is `$1`, the password goes to stdin and reaches mongosh on fd 3. */
export function mongoStatementArgv(container: string, expression: string): string[] {
  return ['exec', '-i', container, 'sh', '-c', MONGO_EVAL_SH, 'sh', mongoScript(expression)];
}

export interface UpgradeStatement {
  readonly name: UpgradeStatementName;
  /** PostgreSQL and MySQL: SQL. MongoDB: the expression mongosh prints. */
  readonly text: string;
  readonly family: UpgradeStatementFamily;
  /** PostgreSQL: the database to connect to (default: the row's). */
  readonly database?: string;
  /** The bound the statement runs under on either host. */
  readonly timeoutMs: number;
  /** What a node needs to build the same text; empty when the statement needs none. */
  readonly args: UpgradeStatementArgs;
}

const noArgs: UpgradeStatementArgs = {};

/** A statement for the panel host to run — and for a node to be asked for by name. */
export function upgradeStatement<N extends UpgradeStatementName>(name: N, args: UpgradeStatementArgs = noArgs): UpgradeStatement {
  const spec: Spec = UPGRADE_STATEMENTS[name];
  return { name, text: spec.build(args), timeoutMs: spec.timeoutMs, family: spec.family, ...(spec.database ? { database: spec.database } : {}), args: { ...args } };
}

/** The exact row counts of `tables` (at most {@link COUNT_CHUNK} of them), `offset` being the index of the first among all tables. */
export const tableCountStatement = (tables: UpgradeTable[], offset: number) => upgradeStatement('mysql.tableCounts', { tables, offset });

/** The release the data directory is told it runs now (`series`); the answer is JSON with `ok`. */
export const mongoSetFeatureCompatibility = (series: string) => upgradeStatement('mongo.setFeatureCompatibilityVersion', { series });

/** The family a database engine's statements belong to. */
export const statementFamilyOf = (engine: string): UpgradeStatementFamily => (engine === 'postgres' ? 'postgres' : engine === 'mongo' ? 'mongo' : 'mysql');

const PING: Record<UpgradeStatementFamily, UpgradeStatementName> = { postgres: 'postgres.ping', mysql: 'mysql.ping', mongo: 'mongo.ping' };
/** What a host asks until the engine's server accepts connections; it prints `1`. */
export const pingStatement = (engine: string) => upgradeStatement(PING[statementFamilyOf(engine)]);

/**
 * The statement a node was asked for by name: the catalogue's own text, built
 * here from arguments that were validated against what that statement reads.
 * Throws for a name that is not in the catalogue and for any argument it does
 * not take.
 */
export function resolveUpgradeStatement(name: string, raw: unknown = {}): UpgradeStatement {
  if (!Object.hasOwn(UPGRADE_STATEMENTS, name)) throw new Error('Unknown upgrade statement');
  const spec: Spec = UPGRADE_STATEMENTS[name as UpgradeStatementName];
  const parsed = upgradeStatementArgs.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid upgrade statement arguments');
  const args = parsed.data;
  const given = Object.keys(args) as (keyof UpgradeStatementArgs)[];
  if (given.some((key) => !spec.args.includes(key)) || spec.args.some((key) => args[key] === undefined)) {
    throw new Error(`Invalid upgrade statement arguments for ${name}`);
  }
  return upgradeStatement(name as UpgradeStatementName, args);
}
