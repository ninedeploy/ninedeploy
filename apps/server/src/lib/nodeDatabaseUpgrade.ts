import { stat, statfs } from 'node:fs/promises';
import type { Database, DB } from '@ninedeploy/db';
import { agentOp } from './agentClient.js';
import { assertNodeCapability } from './agentCapabilities.js';
import { decrypt } from './crypto.js';
import { ENGINES, withDatabaseOperationLock } from '../engine/database.js';
import type { DatabaseUpgradeDeps } from './databaseUpgrade.js';
import { NODE_UPGRADE_CAPABILITY, NODE_UPGRADE_FEATURE, NODE_UPGRADE_REPLY, helperName, helperOf, hostView, type UpgradeHelper } from './databaseUpgradeNames.js';
import { pingStatement, type UpgradeStatement } from './databaseUpgradeSql.js';
import { nodeContainerState, nodeDatabaseRuntime, nodeDatabaseVolumeLabels, type NodeDatabaseAgent, type NodeDatabaseDeps } from './nodeDatabase.js';

/**
 * N12: {@link DatabaseUpgradeDeps} for a database on a NODE — the hands of
 * the major upgrade (lib/databaseUpgrade.ts) on the node's Docker. The journal
 * itself does not know the difference: it asks for the same things it asks of
 * the panel host — a statement, a helper, a copy, a clean stop, a start — and
 * this module performs each through the node's agent (`db.upgrade`,
 * capability `db.upgrade`; an agent too old for it is told to update before
 * anything is planned).
 *
 * What differs from the panel host, and why:
 *
 *  - A statement goes by NAME (lib/databaseUpgradeSql.ts): the agent builds
 *    the text from the catalogue it shares with the panel host. A request
 *    never carries SQL, and an answer the agent channel would have cut is
 *    refused instead of compared.
 *  - The copy is started detached and watched: it runs for as long as it
 *    takes whatever happens to the request that started it.
 *  - The slow, clean stop and the counts over big tables run as long requests
 *    (lib/agentClient.ts: posted without the five-minute header cap).
 *  - The safety dump and the restore use the node's sealed stream channel
 *    (`db.dump`, `db.restore`) into and out of the panel's backups directory.
 *  - Services reach a node database through its own bridge by container name,
 *    and the container keeps its name: there are no service bridges to rejoin.
 *
 * Locks: the database's operation lock (`database-<id>`), the one its backups,
 * restores and imports take — held across the whole upgrade.
 */

/** The agent caller (tests inject one): an op with its output lines and its budget. */
export type NodeUpgradeAgent = (
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
  opts?: { tolerateExit?: boolean; timeoutMs?: number },
) => Promise<{ exitCode: number; lines: string[] }>;

/** How the journal names a helper, as the agent's `helper` operand names it. */
const agentHelper = (helper: UpgradeHelper): 'old' | 'new' | 'copy' => (helper === 'fence' ? 'old' : helper === 'staging' ? 'new' : 'copy');

/** The bound of a clean stop, as on the panel host (`stopContainerClean`). */
export const NODE_STOP_BOUND_SEC = 3600;
/** The longest a copy may run, as on the panel host (`copyDockerVolume`). */
export const NODE_COPY_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** How long the panel waits before it looks at the copier again (doubling, up to {@link NODE_COPY_POLL_MAX_MS}). */
export const NODE_COPY_POLL_MS = 2_000;
export const NODE_COPY_POLL_MAX_MS = 15_000;
/** The line the agent route puts first when it had to drop the oldest lines of an answer. */
const OMITTED = /^… \d+ earlier output line\(s\) omitted by the agent$/;

interface NodeState {
  state: string;
  exitCode: number | null;
  imageId: string;
  imageTag: string;
}

export interface NodeDatabaseUpgradeOptions {
  agent?: NodeUpgradeAgent;
  openStream?: NodeDatabaseDeps['openStream'];
  assertCapable?: NodeDatabaseDeps['assertCapable'];
  /** Whether the node's agent can run an upgrade at all (default: the queue-time capability check). */
  assertHost?: (d: Database) => Promise<void>;
  /** Free bytes where the panel keeps the safety dump (default: the panel's own disk). */
  freeBytes?: (dir: string) => Promise<number>;
  fileSize?: (file: string) => Promise<number>;
  pollMs?: number;
  copyTimeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
}

const quiet = () => undefined;
const freeBytesOf = async (dir: string): Promise<number> => {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
};

/** The journal's deps for `row`, a database on a node. */
export function nodeDatabaseUpgradeDeps(db: DB, row: Database, opts: NodeDatabaseUpgradeOptions = {}): DatabaseUpgradeDeps {
  const serverId = row.serverId;
  if (serverId == null) throw new Error('not a node database');
  const d = hostView(row);
  const agent: NodeUpgradeAgent = opts.agent ?? ((op, params, sink, o) => agentOp(db, serverId, op, params, sink, o));
  const plain: NodeDatabaseAgent = (op, params, o) => agent(op, params, quiet, o);
  const runtimeOpts: NodeDatabaseDeps = { agent: plain, openStream: opts.openStream, assertCapable: opts.assertCapable };
  const identity = {
    databaseId: d.id,
    slug: d.slug,
    engine: d.engine,
    container: d.containerName,
  };
  const password = () => decrypt(row.passwordEncrypted);
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** The last line an op said that is not its result: what went wrong. */
  const lastWord = (lines: string[]) => (lines.filter((l) => l.trim() !== '' && !l.startsWith(NODE_UPGRADE_REPLY)).at(-1) ?? '').slice(-300);
  const why = (lines: string[]) => (lastWord(lines) ? `: ${lastWord(lines)}` : '');

  // The budget of each step is agentClient.ts's, from what the step names (a slow stop, a statement's own bound): the agent stops the child at the same bound.
  const call = (log: (line: string) => void, action: string, params: Record<string, unknown> = {}) =>
    agent('db.upgrade', { database: identity, action, ...params }, log, { tolerateExit: true });
  const must = async (log: (line: string) => void, what: string, action: string, params: Record<string, unknown> = {}): Promise<string[]> => {
    const res = await call(log, action, params);
    if (res.exitCode !== 0) throw new Error(`the node could not ${what}${why(res.lines) || ` (exit ${res.exitCode})`}`);
    return res.lines;
  };
  const replyOf = <T>(lines: string[]): T => {
    const line = lines.find((l) => l.startsWith(NODE_UPGRADE_REPLY));
    if (!line) throw new Error('the node answered without a result line');
    return JSON.parse(line.slice(NODE_UPGRADE_REPLY.length)) as T;
  };
  /** The container a statement or a measure runs in: the database's own, or one of its helpers — nothing else. */
  const target = (container: string): { kind: 'database' } | { kind: 'helper'; helper: 'old' | 'new' | 'copy' } => {
    const helper = helperOf(d, container);
    if (helper) return { kind: 'helper', helper: agentHelper(helper) };
    if (container === d.containerName) return { kind: 'database' };
    throw new Error(`${container} is neither this database's container nor one of its upgrade helpers`);
  };
  const state = async (log: (line: string) => void, container: string): Promise<NodeState | null> => {
    const value = replyOf<Partial<NodeState> & { state: string }>(await must(log, `read the state of ${container}`, 'state', { target: target(container) }));
    return value.state === 'missing' || typeof value.imageId !== 'string' ? null : (value as NodeState);
  };
  const statement = async (log: (line: string) => void, container: string, s: UpgradeStatement, secret: string): Promise<string> => {
    // The budget is the statement's own bound (the agent stops it there) plus the answer's way back.
    const res = await call(log, 'sql', { target: target(container), statement: s.name, ...(Object.keys(s.args).length > 0 ? { args: s.args } : {}), password: secret });
    if (res.lines.some((l) => OMITTED.test(l))) throw new Error(`the node's answer to ${s.name} was too large for the agent channel; nothing was compared`);
    if (res.exitCode !== 0) throw new Error(`the statement ${s.name} failed on the node${why(res.lines) || ` (exit ${res.exitCode})`}`);
    return res.lines.length > 0 ? `${res.lines.join('\n')}\n` : '';
  };
  const measure = async (log: (line: string) => void, container: string, what: 'size' | 'free', dir: string): Promise<string[]> =>
    (await must(log, `measure ${dir} in ${container}`, 'measure', { target: target(container), what, dir })).map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  /** `docker.volumeInspect` doubles as the existence probe (exit 0 = it is there). */
  const volumeExists = async (name: string): Promise<boolean> => (await plain('docker.volumeInspect', { name }, { tolerateExit: true })).exitCode === 0;
  const helperOnly = (container: string): UpgradeHelper => {
    const helper = helperOf(d, container);
    if (!helper) throw new Error(`${container} is not an upgrade helper of ${d.name}`);
    return helper;
  };
  /** The node's shape of a row the journal hands over in its reading shape. */
  const nodeRow = (x: Database): Database => ({
    ...x,
    containerName: null,
    volumeName: null,
    nodeContainerName: x.containerName || x.nodeContainerName,
    nodeVolumeName: x.volumeName || x.nodeVolumeName,
  });

  const waitReady = async (container: string, x: Database, log: (line: string) => void): Promise<boolean> => {
    // As on the panel host: a server that upgrades its data directory on start
    // answers only afterwards, so the bound is long; a container that exited
    // (a failed upgrade) ends the wait.
    const boundSec = x.engine === 'postgres' ? 180 : 1800;
    const ping = pingStatement(x.engine);
    const deadline = Date.now() + boundSec * 1000;
    let last = '';
    while (Date.now() < deadline) {
      try {
        if ((await statement(quiet, container, ping, password())).trim() === '1') return true;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      const now = await nodeContainerState(plain, container);
      if (now !== 'running' && now !== 'restarting') {
        log(`${container} ${now === 'missing' ? 'is gone' : `is ${now}`} before it accepted connections${last ? ` (${last.slice(0, 200)})` : ''}`);
        return false;
      }
      await wait(2_000);
    }
    log(`${container} did not accept connections within ${boundSec} s${last ? ` (${last.slice(0, 200)})` : ''}`);
    return false;
  };

  return {
    psql: (container, s) => statement(quiet, container, s, ''),
    sql: (_x, container, s) => statement(quiet, container, s, password()),

    containerImage: async (container) => {
      const st = await state(quiet, container);
      return st && st.imageId && st.imageTag ? { id: st.imageId, tag: st.imageTag } : null;
    },
    containerRunning: async (container) => (await nodeContainerState(plain, container)) === 'running',
    pull: async (image, log) => {
      log(`Pulling ${image} on node #${serverId} …`);
      // A node pull fails fast (r417): the agent's own bound, as for a database's start.
      await plain('docker.pull', { image });
    },
    stopAndRemove: async (container, log) => {
      const helper = helperOf(d, container);
      if (helper) {
        await must(log, `remove ${container}`, 'remove', { helper: agentHelper(helper) });
        return;
      }
      if (container !== d.containerName) throw new Error(`${container} is not this database's container`);
      // The database's own container: a graceful stop, as long as the panel
      // host gives it, then the removal. The volume stays.
      await agent('docker.stop', { name: container, graceSeconds: 60 }, log, { tolerateExit: true });
      await agent('docker.rm', { name: container }, log, { tolerateExit: true });
    },
    runIsolated: async (x, spec, log) => {
      const cfg = ENGINES[x.engine];
      if (!cfg) throw new Error(`Unknown engine: ${x.engine}`);
      // As on the panel host: the row's credentials, then what the step adds.
      const env = { ...cfg.env(password()), ...spec.env };
      await must(log, `start ${spec.name}`, 'run', {
        helper: agentHelper(helperOnly(spec.name)), image: spec.image, volume: spec.volume, mount: spec.mount, ...(x.memLimitMb > 0 ? { memLimitMb: x.memLimitMb } : {}), env,
      });
    },
    dataDirBytes: async (container, dir) => {
      const n = Number.parseInt((await measure(quiet, container, 'size', dir)).join(' ').trim().split(/\s+/)[0] ?? '', 10);
      if (!Number.isFinite(n)) throw new Error(`could not measure ${dir} in ${container}`);
      return n;
    },
    freeBytesIn: async (container, dir) => {
      const lines = await measure(quiet, container, 'free', dir);
      const n = Number.parseInt((lines.at(-1) ?? '').trim().split(/\s+/)[3] ?? '', 10);
      if (!Number.isFinite(n)) throw new Error(`could not read the free space of ${dir} in ${container}`);
      return n;
    },
    stopClean: async (container, log) => {
      const helper = agentHelper(helperOnly(container));
      return replyOf<{ exitCode: number | null }>(await must(log, `stop ${container} cleanly`, 'stop', { helper, timeoutSec: NODE_STOP_BOUND_SEC })).exitCode;
    },
    copyVolume: async (from, to, image, name, log) => {
      if (name !== helperName(d, 'copier')) throw new Error(`${name} is not the copier of ${d.name}`);
      log(`Copying volume ${from} → ${to} on node #${serverId} …`);
      await must(log, 'start the copy', 'copy', { image, from, to });
      const boundMs = opts.copyTimeoutMs ?? NODE_COPY_TIMEOUT_MS;
      const deadline = Date.now() + boundMs;
      let pause = opts.pollMs ?? NODE_COPY_POLL_MS;
      for (;;) {
        await wait(pause);
        pause = Math.min(pause * 2, NODE_COPY_POLL_MAX_MS);
        const st = await state(quiet, name);
        if (!st) throw new Error('the copy helper is gone before it finished');
        if (st.state === 'created') throw new Error('the copy helper was never started');
        if (st.state === 'exited' || st.state === 'dead') {
          // The helper holds the new volume while it exists: gone before the answer is read.
          await agent('db.upgrade', { database: identity, action: 'remove', helper: 'copy' }, quiet, { tolerateExit: true }).catch(() => undefined);
          if (st.exitCode !== 0) throw new Error(`copying the volume exited with ${st.exitCode ?? 'an unknown code'}`);
          return;
        }
        if (Date.now() > deadline) throw new Error(`the copy did not finish within ${Math.round(boundMs / 60_000)} minutes`);
      }
    },
    waitReady,
    dump: (x, file, log) => nodeDatabaseRuntime(db, nodeRow(x), runtimeOpts).dumpHeld(file, log),
    restore: (x, file, log) => nodeDatabaseRuntime(db, nodeRow(x), runtimeOpts).restoreHeld(file, log),
    createVolume: (name, labels, log) => agent('docker.volumeCreate', { name, labels, ifExists: 'fail' }, log).then(() => undefined),
    volumeExists,
    // Resolves false when it is still there afterwards, as on the panel host.
    removeVolume: async (name, log) => {
      await agent('docker.volumeRm', { name }, log, { tolerateExit: true });
      return !(await volumeExists(name));
    },
    // A node's start first clears whatever an upgrade left on the volume (nodeDatabase.ts), so nothing else runs beside a leftover helper.
    start: (x, log) => nodeDatabaseRuntime(db, nodeRow(x), runtimeOpts).start(log),
    // Services join the database's own bridge on the node by container name, which does not change.
    attachBridges: async () => undefined,
    freeBytes: opts.freeBytes ?? freeBytesOf,
    maintenance: (x, log, op) => withDatabaseOperationLock(x.id, log, op),
    fileSize: opts.fileSize ?? (async (file: string): Promise<number> => (await stat(file).catch(() => null))?.size ?? 0),
    // As every volume a node database has: the provenance labels plus the row's id, which is what the agent binds an upgrade to.
    volumeLabels: (target) => nodeDatabaseVolumeLabels(target),
    assertHost: opts.assertHost ?? ((x) => assertNodeCapability(db, x.serverId!, { cap: [NODE_UPGRADE_CAPABILITY], feature: NODE_UPGRADE_FEATURE, sealedRequired: true })),
  };
}
