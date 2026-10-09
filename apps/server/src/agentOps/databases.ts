import { randomUUID } from 'node:crypto';
import {
  dumpCommands,
  dumpTmpPath,
  importTmpPath,
  isDatabaseEngine,
  mysqlHelpCommand,
  probeCommand,
  REDIS_DUMP_PATH,
  restoreCommand,
  restoreTmpPath,
  SANDBOX_FLAGS,
  sizeCommand,
} from '../lib/databaseCommands.js';
import { STREAM_HARD_CAP_MS } from '../lib/agentStream.js';
import { spawnValidated, spawnValidatedStream } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import { type Params, str } from './operands.js';
import type { PreparedStream, StreamKindHandler } from './stream.js';

/**
 * Managed databases on a node (multi-node T6, capability `db.manage`, design
 * §1.1, §1.5, §5.4). The node owner's switch is `NINEDEPLOY_AGENT_DATABASES`
 * (agentOps/index.ts): off removes the capability and refuses every op here.
 *
 * Everything is SEALED only: each op and stream carries the database password.
 * Nothing here runs a caller's argv. A request names a managed database
 * container (`nd-db-*`, labelled `ninedeploy.managed=database` by the
 * `docker.runSpec` that started it), an engine from the fixed list and an
 * enumerated query or mode; the argv comes from lib/databaseCommands.ts, the
 * same builders whose output equals what the panel host runs for its own
 * databases (pinned against the v0.15.0 recording) — so a node dump is the
 * same file a panel dump is.
 *
 *  - `docker.restart {name}`: restart a managed database container.
 *  - `db.exec {container, engine, query, password}`: `size`, `probe` (a real
 *    sign-in with the stored credentials) or `mysqlHelp` (the sandbox probe).
 *  - stream `db.dump` (agent→panel): the panel host's dump into a temp file
 *    inside the container, streamed out with `cat`, then removed.
 *  - stream `db.restore` (panel→agent): the verified file is `docker cp`d in
 *    and restored with the panel host's restore (`mode: 'restore'`) or 0.14
 *    import (`mode: 'import'`, the plan fields are enums) argv.
 */

const RE_DB_CONTAINER = /^nd-db-[a-z0-9][a-z0-9_.-]*$/;
/** Restores and imports run as long as the panel host's (`IMPORT_TIMEOUT_MS`, 6 h). */
const DB_LONG_TIMEOUT_MS = STREAM_HARD_CAP_MS;
const DB_SHORT_TIMEOUT_MS = 120_000;

/** A managed database container name, or a refusal. */
function containerOperand(value: unknown, what = 'database container'): string {
  if (typeof value !== 'string' || value.length > 128 || !RE_DB_CONTAINER.test(value)) throw new Error(`Invalid ${what} (nd-db-*)`);
  return value;
}

function engineOperand(value: unknown): string {
  if (!isDatabaseEngine(value)) throw new Error('Invalid database engine');
  return value;
}

/** The database password: a single line (it reaches an argv element, never a shell). */
function passwordOperand(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error('Invalid database password');
  return value;
}

/** Refuse anything but the keys an op takes. */
function knownKeys(params: Params, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) if (!allowed.includes(key)) throw new Error(`Invalid database param: ${key}`);
}

/** Run docker, collecting its output (for the result line or the error message). */
async function docker(argv: string[], timeoutMs = DB_SHORT_TIMEOUT_MS): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await spawnValidated('docker', argv, (l) => lines.push(l), { timeoutMs });
  return { code, lines };
}

/** Run docker or throw with the tail of its output (never the argv: it can carry the password). */
async function mustDocker(argv: string[], what: string, timeoutMs = DB_SHORT_TIMEOUT_MS): Promise<string[]> {
  const res = await docker(argv, timeoutMs);
  if (res.code !== 0) throw new Error(`${what} exited with ${res.code}: ${res.lines.join(' ').slice(-500)}`);
  return res.lines;
}

/**
 * The container must exist and carry the managed-database label the panel
 * set when it started it: a name match alone would let a request reach any
 * container someone named `nd-db-…` on the node.
 */
async function assertManagedDatabase(name: string): Promise<void> {
  const res = await docker(['inspect', '--format', '{{index .Config.Labels "ninedeploy.managed"}}', name]);
  if (res.code !== 0) throw new Error(`Database container ${name} does not exist on this node`);
  if ((res.lines.find((l) => l.trim() !== '') ?? '').trim() !== 'database') {
    throw new Error(`Container ${name} is not a managed database on this node`);
  }
}

/** `docker.restart {name}`. */
async function restartOp(params: Params, onLine: (line: string) => void): Promise<number> {
  knownKeys(params, ['name']);
  const name = containerOperand(params['name']);
  await assertManagedDatabase(name);
  return spawnValidated('docker', ['restart', name], onLine);
}

const DB_QUERIES = ['size', 'probe', 'mysqlHelp'] as const;

/** `db.exec {container, engine, query, password}`: one enumerated query; its output lines are the answer. */
async function execOp(params: Params, onLine: (line: string) => void): Promise<number> {
  knownKeys(params, ['container', 'engine', 'query', 'password']);
  const cn = containerOperand(params['container']);
  const engine = engineOperand(params['engine']);
  const query = params['query'];
  if (!DB_QUERIES.includes(query as (typeof DB_QUERIES)[number])) throw new Error('Invalid database query');
  const password = params['password'] === undefined ? '' : passwordOperand(params['password']);
  const argv =
    query === 'size' ? sizeCommand(engine, cn, password) : query === 'probe' ? probeCommand(engine, cn, password) : mysqlHelpCommand(engine, cn);
  if (argv === null) {
    onLine(`ND-DB-UNSUPPORTED ${query} ${engine}`);
    return 0;
  }
  await assertManagedDatabase(cn);
  return spawnValidated('docker', argv, onLine, { timeoutMs: DB_SHORT_TIMEOUT_MS });
}

export const databaseOps: AgentOpModule = {
  name: 'agentOps/databases.ts',
  caps: ['db.manage'],
  ops: {
    'docker.restart': { cap: 'db.manage', sealedOnly: true, run: (p, onLine) => restartOp(p, onLine) },
    'db.exec': { cap: 'db.manage', sealedOnly: true, run: (p, onLine) => execOp(p, onLine) },
  },
};

// ── stream kinds ─────────────────────────────────────────────────────────────

/** `db.dump {container, engine, password}` (agent→panel). */
export const dbDumpKind: StreamKindHandler = {
  keys: ['container', 'engine', 'password'],
  async prepare(params) {
    const cn = containerOperand(params['container']);
    const engine = engineOperand(params['engine']);
    const password = passwordOperand(params['password']);
    // The panel host's own refusal, before the channel exists.
    const plan = dumpCommands(engine, cn, dumpTmpPath(randomUUID()), password);
    await assertManagedDatabase(cn);
    return {
      direction: 'agent-to-panel',
      async start() {
        try {
          await mustDocker(plan.dump, 'the dump', DB_LONG_TIMEOUT_MS);
        } catch (err) {
          if (plan.cleanup) await docker(plan.cleanup).catch(() => undefined);
          throw err;
        }
        const child = spawnValidatedStream('docker', ['exec', cn, 'cat', plan.file], { timeoutMs: DB_LONG_TIMEOUT_MS });
        const cleanup = async () => {
          if (plan.cleanup) await docker(plan.cleanup).catch(() => undefined);
        };
        return {
          stream: child.stdout,
          done: child.exit.then(
            async ({ code, stderr }) => {
              await cleanup();
              if (code !== 0) throw new Error(`reading the dump exited with ${code}: ${stderr.trim().slice(-500)}`);
              return { engine };
            },
            async (err: unknown) => {
              await cleanup();
              throw err;
            },
          ),
          abort: () => {
            child.kill();
            void cleanup();
          },
        };
      },
    } satisfies PreparedStream;
  },
};

const IMPORT_FORMATS: Readonly<Record<string, readonly string[]>> = {
  postgres: ['pg_custom', 'pg_plain'],
  mysql: ['mysql_sql'],
  mariadb: ['mysql_sql'],
  mongo: ['mongo_archive'],
  redis: ['rdb'],
  valkey: ['rdb'],
};

const optBool = (params: Params, key: string): boolean | undefined => {
  const v = params[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`Invalid ${key}`);
  return v;
};

/** redis/valkey: stop (a graceful shutdown SAVEs over the file), copy, always start again (r232). */
async function replaceRedisData(cn: string, file: string): Promise<void> {
  await mustDocker(['stop', cn], 'docker stop');
  try {
    await mustDocker(['cp', file, `${cn}:${REDIS_DUMP_PATH}`], 'docker cp', DB_LONG_TIMEOUT_MS);
  } finally {
    await mustDocker(['start', cn], 'docker start');
  }
}

/** Copy `file` into the container at `tmp`, run `argv`, always remove `tmp`. */
async function runAgainstCopy(cn: string, file: string, tmp: string, argv: string[], what: string): Promise<void> {
  try {
    await mustDocker(['cp', file, `${cn}:${tmp}`], 'docker cp', DB_LONG_TIMEOUT_MS);
    await mustDocker(argv, what, DB_LONG_TIMEOUT_MS);
  } finally {
    await docker(['exec', cn, 'rm', '-f', tmp]).catch(() => undefined);
  }
}

/**
 * `db.restore {container, engine, password, mode, …plan}` (panel→agent): the
 * bytes land in the transfer file first and are applied only after the
 * panel's end-to-end check matched (agentOps/stream.ts), so a cut stream
 * never touches the database.
 */
export const dbRestoreKind: StreamKindHandler = {
  keys: ['container', 'engine', 'password', 'mode', 'format', 'gzip', 'clean', 'singleTransaction', 'drop', 'sandboxFlag'],
  async prepare(params) {
    const cn = containerOperand(params['container']);
    const engine = engineOperand(params['engine']);
    const password = passwordOperand(params['password']);
    const mode = params['mode'] ?? 'restore';
    if (mode !== 'restore' && mode !== 'import') throw new Error('Invalid restore mode');
    let apply: (file: string) => Promise<void>;
    if (mode === 'restore') {
      if (engine === 'redis' || engine === 'valkey') apply = (file) => replaceRedisData(cn, file);
      else {
        const tmp = restoreTmpPath(randomUUID());
        const argv = restoreCommand(engine, cn, tmp, password);
        apply = (file) => runAgainstCopy(cn, file, tmp, argv, 'the restore');
      }
      for (const key of ['format', 'gzip', 'clean', 'singleTransaction', 'drop', 'sandboxFlag']) {
        if (params[key] !== undefined) throw new Error(`Invalid restore param: ${key}`);
      }
    } else {
      const format = str(params, 'format');
      if (format === undefined || !(IMPORT_FORMATS[engine] ?? []).includes(format)) throw new Error('Invalid import format');
      const sandbox = params['sandboxFlag'];
      if (sandbox !== undefined && sandbox !== null && !(typeof sandbox === 'string' && SANDBOX_FLAGS.has(sandbox))) throw new Error('Invalid sandboxFlag');
      const plan = {
        format: format as import('../engine/database.js').DatabaseImportFormat,
        gzip: optBool(params, 'gzip'),
        clean: optBool(params, 'clean'),
        singleTransaction: optBool(params, 'singleTransaction'),
        drop: optBool(params, 'drop'),
        sandboxFlag: (sandbox as string | null | undefined) ?? null,
      };
      if (format === 'rdb') apply = (file) => replaceRedisData(cn, file);
      else {
        // The panel host's import argv (engine/database.ts `importCommand`),
        // built — and so validated — before anything is copied.
        const { importCommand } = await import('../engine/database.js');
        const tmp = importTmpPath(randomUUID());
        const argv = importCommand(engine, cn, tmp, plan, password);
        apply = (file) => runAgainstCopy(cn, file, tmp, argv, 'the import');
      }
    }
    await assertManagedDatabase(cn);
    return {
      direction: 'panel-to-agent',
      gunzip: false,
      async apply(file) {
        await apply(file);
        return { engine, mode };
      },
    } satisfies PreparedStream;
  },
};
