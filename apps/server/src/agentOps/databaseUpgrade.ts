import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PG_DB, PG_USER, mysqlClientConfig } from '../lib/databaseCommands.js';
import { NODE_UPGRADE_CAPABILITY, NODE_UPGRADE_REPLY } from '../lib/databaseUpgradeNames.js';
import { SEP, UPGRADE_STATEMENTS, resolveUpgradeStatement } from '../lib/databaseUpgradeSql.js';
import { spawnValidated, spawnValidatedStream } from '../lib/spawnValidated.js';
import type { AgentOpModule } from './index.js';
import { RE_IMAGE, RE_PATH } from './operands.js';

/**
 * Major upgrades of a node database (N12, capability `db.upgrade`): the hands
 * of lib/databaseUpgrade.ts on the node. The panel keeps the whole journal —
 * the steps, the comparison, the switch, the rollback and the recovery after a
 * restart are the same code for the panel host and for a node — and asks this
 * module only for what touches the node's Docker:
 *
 *  - `state`:   what became of the database's container, or of a helper;
 *  - `run`:     a HELPER — a database image on a volume with NO network: the
 *               fence (the old image on the old volume) or the staging copy
 *               (the new image on the new one);
 *  - `copy`:    the copier, a detached helper that copies the old volume into
 *               the new one (the panel watches it; it outlives a lost request);
 *  - `sql`:     ONE statement of the fixed catalogue
 *               (lib/databaseUpgradeSql.ts), built here from its name: a
 *               request never carries SQL;
 *  - `measure`: the size of a directory, and the free room where it lives;
 *  - `stop`:    the slow, clean stop of a helper; answers its exit code;
 *  - `remove`:  a helper.
 *
 * Sealed only: the env of a helper carries the database's credentials, and so
 * does the root password of a MySQL statement. Everything is bound to ONE
 * database by its labels (`ninedeploy.database.id` and `.slug`): a volume or
 * a container that is not this database's is refused before anything runs, a
 * helper's name is derived here from the slug, and a container under such a
 * name is removed only when it carries the `database-upgrade` label of the
 * same database.
 */

/** What a helper's `ninedeploy.managed` label says it is (a database's own container says `database`). */
export const UPGRADE_HELPER_LABEL = 'database-upgrade';

/** Most a statement's answer may be: the op channel carries lines, a larger answer would be cut. */
export const SQL_ANSWER_CAP = 8 * 1024 * 1024;

/** The copier's whole command: every file with its ownership, modes and links, then to disk. */
export const COPY_SCRIPT = 'cp -a /from/. /to/ && sync';

const SHORT_MS = 120_000;
/** Missing is an answer, not a failure (`No such container`, `No such volume`). */
const MISSING = /No such (container|object|volume)/i;

const singleLine = (value: string) => ![...value].some((c) => [0, 10, 13].includes(c.charCodeAt(0)));
const absolutePath = (max: number) => z.string().min(1).max(max).refine((v) => v.startsWith('/') && !v.includes(':') && RE_PATH(v), 'Expected an absolute path');
const image = z.string().max(255).regex(RE_IMAGE);

/** The database an upgrade op is about. Its names are the row's on the node. */
const identity = z.object({
  databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  engine: z.enum(['postgres', 'mysql', 'mariadb']),
  container: z.string().max(128).regex(/^nd-db-[a-z0-9][a-z0-9_.-]*$/),
}).strict();
export type NodeUpgradeIdentity = z.infer<typeof identity>;

const helper = z.enum(['old', 'new', 'copy']);
type Helper = z.infer<typeof helper>;
const managedVolume = z.string().max(128).regex(/^nd-db-[a-z0-9][a-z0-9_.-]*$/);
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('database') }).strict(),
  z.object({ kind: z.literal('helper'), helper }).strict(),
]);

/** `db.upgrade`: every field of every action, and nothing else. */
export const nodeUpgradeRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state'), database: identity, target }).strict(),
  z.object({
    action: z.literal('run'), database: identity, helper, image, volume: managedVolume, mount: absolutePath(4096),
    memLimitMb: z.number().int().min(0).max(4_194_304).optional(),
    env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().max(32768).refine(singleLine, 'Expected a single-line value')),
  }).strict(),
  z.object({ action: z.literal('remove'), database: identity, helper }).strict(),
  z.object({ action: z.literal('stop'), database: identity, helper, timeoutSec: z.number().int().min(1).max(3600) }).strict(),
  z.object({ action: z.literal('copy'), database: identity, image, from: managedVolume, to: managedVolume }).strict(),
  z.object({ action: z.literal('sql'), database: identity, target, statement: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()).optional(), password: z.string().max(1024).refine(singleLine, 'Expected a single-line password') }).strict(),
  z.object({ action: z.literal('measure'), database: identity, target, what: z.enum(['size', 'free']), dir: absolutePath(4096) }).strict(),
]);

/** The helper `helper` of a database on a node: a managed database name (see lib/databaseUpgradeNames.ts). */
export const nodeHelperName = (id: Pick<NodeUpgradeIdentity, 'slug'>, which: Helper): string => `nd-db-upg-${id.slug}-${which}`;

type Labels = Record<string, string>;

async function docker(argv: string[], timeoutMs = SHORT_MS): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await spawnValidated('docker', argv, (l) => lines.push(l), { timeoutMs });
  return { code, lines };
}

/** Run docker or throw with the tail of its output (never the argv: it may hold a statement). */
async function mustDocker(argv: string[], what: string, timeoutMs = SHORT_MS): Promise<string[]> {
  const res = await docker(argv, timeoutMs);
  if (res.code !== 0) throw new Error(`${what} exited with ${res.code}: ${res.lines.join(' ').slice(-500)}`);
  return res.lines;
}

/**
 * Run docker and collect its STDOUT alone, bounded: stderr stays apart, so a
 * warning never lands in an answer the panel parses.
 */
async function collected(argv: string[], opts: { timeoutMs: number; stdin?: string }): Promise<{ code: number; out: string; stderr: string }> {
  const child = spawnValidatedStream('docker', argv, { timeoutMs: opts.timeoutMs, stdin: opts.stdin === undefined ? 'ignore' : 'pipe' });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let cut = false;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= SQL_ANSWER_CAP) chunks.push(chunk);
    else if (!cut) {
      cut = true;
      child.kill();
    }
  });
  const { code, stderr } = await child.exit;
  if (cut) throw new Error(`The answer is larger than ${SQL_ANSWER_CAP} bytes; the agent channel would cut it`);
  return { code, out: Buffer.concat(chunks).toString('utf8'), stderr };
}

/** The labels of a container or a volume; null when there is none; throws when Docker cannot say. */
async function labelsOf(kind: 'container' | 'volume', name: string): Promise<Labels | null> {
  const res = await docker(kind === 'container'
    ? ['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}', name]
    : ['volume', 'inspect', '--format', '{{json .Labels}}', name]);
  if (res.code !== 0) {
    if (res.lines.some((l) => MISSING.test(l))) return null;
    throw new Error(`Could not inspect ${kind} ${name}: ${res.lines.join(' ').slice(-300)}`);
  }
  const text = res.lines.find((l) => l.trim() !== '') ?? '';
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Labels) : {};
  } catch {
    throw new Error(`Could not read the labels of ${kind} ${name}`);
  }
}

/** Whether `labels` are the ones this database's `managed` things carry. */
const owned = (labels: Labels | null, managed: string, id: NodeUpgradeIdentity): labels is Labels =>
  labels !== null && labels['ninedeploy.managed'] === managed && labels['ninedeploy.database.id'] === String(id.databaseId) && labels['ninedeploy.database.slug'] === id.slug;

interface State {
  state: string;
  exitCode: number | null;
  imageId: string;
  imageTag: string;
}

/** What became of container `name`; null when there is none. */
async function stateOf(name: string): Promise<State | null> {
  const res = await docker(['inspect', '--type', 'container', '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{.Image}}|{{.Config.Image}}', name], 30_000);
  if (res.code !== 0) {
    if (res.lines.some((l) => MISSING.test(l))) return null;
    throw new Error(`Could not inspect container ${name}: ${res.lines.join(' ').slice(-300)}`);
  }
  const [state, exit, imageId, imageTag] = (res.lines.find((l) => l.includes('|')) ?? '').split('|');
  if (!state) throw new Error(`Could not read the state of container ${name}`);
  return { state: state.trim(), exitCode: /^\d+$/.test(exit ?? '') ? Number(exit) : null, imageId: imageId ?? '', imageTag: imageTag ?? '' };
}

function assertHelper(labels: Labels | null, name: string, id: NodeUpgradeIdentity): asserts labels is Labels {
  if (!owned(labels, UPGRADE_HELPER_LABEL, id)) {
    throw new Error(`Container ${name} is not an upgrade helper of database #${id.databaseId} on this node; nothing was done to it`);
  }
}

/** Remove a helper by name — only ever this database's own. A missing one is done. */
async function removeHelper(name: string, id: NodeUpgradeIdentity): Promise<void> {
  const labels = await labelsOf('container', name);
  if (labels === null) return;
  assertHelper(labels, name, id);
  await mustDocker(['rm', '-f', name], `removing ${name}`);
}

const helperLabels = (id: NodeUpgradeIdentity, which: Helper): string[] => [
  '--label', `ninedeploy.managed=${UPGRADE_HELPER_LABEL}`,
  '--label', `ninedeploy.database.id=${id.databaseId}`,
  '--label', `ninedeploy.database.slug=${id.slug}`,
  '--label', `ninedeploy.database.upgrade=${which}`,
];

/** A volume of this database (the old one, or the new one the panel created with the same labels); throws otherwise. */
async function ownedVolume(name: string, id: NodeUpgradeIdentity): Promise<void> {
  const labels = await labelsOf('volume', name);
  if (!owned(labels, 'database', id)) {
    throw new Error(labels === null ? `Volume ${name} does not exist on this node` : `Volume ${name} does not belong to database #${id.databaseId} on this node`);
  }
}

type Target = z.infer<typeof target>;

/** The container a statement or a measure runs in: the database's own, or one of its helpers. */
async function boundContainer(id: NodeUpgradeIdentity, t: Target): Promise<string> {
  const name = t.kind === 'database' ? id.container : nodeHelperName(id, t.helper);
  const labels = await labelsOf('container', name);
  const ok = t.kind === 'database' ? owned(labels, 'database', id) : owned(labels, UPGRADE_HELPER_LABEL, id);
  if (!ok) {
    throw new Error(labels === null ? `Container ${name} does not exist on this node` : `Container ${name} does not belong to database #${id.databaseId} on this node`);
  }
  return name;
}

/** Where the agent keeps the env files of the containers it starts (agent.ts `ENV_DIR`). */
const envRoot = (): string => {
  const root = path.join(process.cwd(), '.agent-env');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
};

async function run(params: Record<string, unknown>, onLine: (line: string) => void): Promise<number> {
  const req = nodeUpgradeRequest.parse(params);
  const id = req.database;
  const reply = (value: unknown) => onLine(`${NODE_UPGRADE_REPLY}${JSON.stringify(value)}`);
  switch (req.action) {
    case 'state': {
      const name = req.target.kind === 'database' ? id.container : nodeHelperName(id, req.target.helper);
      const state = await stateOf(name);
      if (!state) {
        reply({ state: 'missing' });
        return 0;
      }
      const labels = await labelsOf('container', name);
      const ok = req.target.kind === 'database' ? owned(labels, 'database', id) : owned(labels, UPGRADE_HELPER_LABEL, id);
      if (!ok) throw new Error(`Container ${name} does not belong to database #${id.databaseId} on this node`);
      reply(state);
      return 0;
    }
    case 'run': {
      const name = nodeHelperName(id, req.helper);
      // A leftover of an earlier attempt goes first, and only ever this database's own.
      await removeHelper(name, id);
      await ownedVolume(req.volume, id);
      // The credentials reach the helper as a 0600 env file and never as argv
      // (the panel host's runIsolatedDatabase does the same); the file is gone
      // whether or not the container starts.
      const dir = mkdtempSync(path.join(envRoot(), 'upgrade-'));
      try {
        const file = path.join(dir, 'database.env');
        writeFileSync(file, `${Object.entries(req.env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
        onLine(`Starting ${name} (${req.image}, no network) …`);
        await mustDocker([
          'run', '-d', '--name', name, '--network', 'none', '--restart', 'no', '--pull', 'never', ...helperLabels(id, req.helper),
          ...(req.memLimitMb ? ['--memory', `${req.memLimitMb}m`, '--memory-swap', `${req.memLimitMb}m`] : []),
          '-v', `${req.volume}:${req.mount}`, '--env-file', file, req.image,
        ], `starting ${name}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      reply({ started: name });
      return 0;
    }
    case 'remove': {
      await removeHelper(nodeHelperName(id, req.helper), id);
      return 0;
    }
    case 'stop': {
      const name = nodeHelperName(id, req.helper);
      const labels = await labelsOf('container', name);
      if (labels === null) {
        reply({ exitCode: null });
        return 0;
      }
      assertHelper(labels, name, id);
      onLine(`Stopping ${name} (a slow, clean shutdown; up to ${req.timeoutSec} s) …`);
      await docker(['stop', '--time', String(req.timeoutSec), name], (req.timeoutSec + 120) * 1000);
      const state = await stateOf(name);
      // Removed either way: a stop that ran out of time ends in SIGKILL, and the caller reads that from the code.
      await docker(['rm', '-f', name]);
      reply({ exitCode: state && state.state === 'exited' ? state.exitCode : null });
      return 0;
    }
    case 'copy': {
      const name = nodeHelperName(id, 'copy');
      if (req.from === req.to) throw new Error('The source and the target are the same volume');
      await ownedVolume(req.from, id);
      await ownedVolume(req.to, id);
      await removeHelper(name, id);
      onLine(`Starting ${name} (copying ${req.from} into ${req.to}, no network) …`);
      // Detached on purpose: a copy runs for as long as it takes, whatever
      // happens to this request; the panel watches the helper by name.
      await mustDocker([
        'run', '-d', '--name', name, '--network', 'none', '--restart', 'no', '--pull', 'never', ...helperLabels(id, 'copy'),
        '--entrypoint', 'sh', '-v', `${req.from}:/from:ro`, '-v', `${req.to}:/to`, req.image, '-c', COPY_SCRIPT,
      ], `starting ${name}`);
      reply({ started: name });
      return 0;
    }
    case 'sql': {
      const name = await boundContainer(id, req.target);
      const statement = resolveUpgradeStatement(req.statement, req.args);
      const family = id.engine === 'postgres' ? 'postgres' : 'mysql';
      if (UPGRADE_STATEMENTS[statement.name].family !== family) throw new Error(`Statement ${statement.name} does not run on ${id.engine}`);
      const argv = family === 'postgres'
        ? ['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', PG_USER, '-d', statement.database ?? PG_DB, '-At', '-F', SEP, '-c', statement.text]
        // The password travels as a `[client]` option file on stdin: never in
        // argv (the host's and the container's process lists) nor in the environment.
        : ['exec', '-i', name, id.engine === 'mariadb' ? 'mariadb' : 'mysql', '--defaults-extra-file=/dev/stdin', '-h127.0.0.1', '-uroot', '-N', '-B', '-e', statement.text];
      const { code, out, stderr } = await collected(argv, { timeoutMs: statement.timeoutMs, ...(family === 'mysql' ? { stdin: mysqlClientConfig(req.password) } : {}) });
      if (code !== 0) {
        if (stderr.trim()) onLine(stderr.trim().slice(-500));
        return code;
      }
      for (const line of out.split('\n')) if (line !== '') onLine(line.replace(/\r$/, ''));
      return 0;
    }
    case 'measure': {
      const name = await boundContainer(id, req.target);
      const argv = req.what === 'size' ? ['exec', name, 'du', '-sb', req.dir] : ['exec', name, 'df', '-PB1', req.dir];
      const { code, out, stderr } = await collected(argv, { timeoutMs: SHORT_MS });
      if (code !== 0) {
        if (stderr.trim()) onLine(stderr.trim().slice(-500));
        return code;
      }
      for (const line of out.split('\n')) if (line.trim() !== '') onLine(line);
      return 0;
    }
  }
}

export const databaseUpgradeOps: AgentOpModule = {
  name: 'agentOps/databaseUpgrade.ts',
  caps: [NODE_UPGRADE_CAPABILITY],
  ops: {
    'db.upgrade': { cap: NODE_UPGRADE_CAPABILITY, sealedOnly: true, run },
  },
};
