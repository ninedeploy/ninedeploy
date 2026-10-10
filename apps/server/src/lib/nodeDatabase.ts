import { createReadStream, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Database, databases, type DB } from '@ninedeploy/db';
import { isNotNull } from 'drizzle-orm';
import type { MultiNodeCapability } from '@ninedeploy/schemas';
import {
  createBackupReadStream,
  type DatabaseImportPlan,
  ENGINES,
  resolveVolumePath,
  type RetainedVolumeAdoption,
  withDatabaseOperationLock,
} from '../engine/database.js';
import { agentVersionAtLeast, assertNodeCapability } from './agentCapabilities.js';
import { agentOp } from './agentClient.js';
import { type AgentStreamHandle, openAgentStream } from './agentStream.js';
import { createBackupCipher, decrypt } from './crypto.js';
import {
  AGENT_REDIS_FAMILY_VERSION,
  DUMPABLE_ENGINES,
  NODE_ENGINES_NEEDING_NEWER_AGENT,
  mysqlHelpCommand,
  parseSizeOutput,
  probeCommand,
  probeSucceeded,
  sandboxFlagFrom,
  sizeCommand,
} from './databaseCommands.js';
import { HttpError } from './errors.js';
import { sleep } from './exec.js';
import { parseNodeVolumeList } from './nodeVolumes.js';

/**
 * Managed databases on a node, panel side (multi-node T6, design §5.3, §5.4).
 *
 * A node database row keeps `container_name` / `volume_name` NULL — the
 * rollback marker 0.15 refuses to act on (§5.8) — and its real names in
 * `node_container_name` / `node_volume_name`. Everything here talks to the
 * node's agent: `docker.runSpec` and the volume ops to start it, `db.manage`
 * (`docker.restart`, `db.exec`) for the rest, and the sealed stream channel
 * (`db.dump`, `db.restore`) for backups, restores and 0.14 imports, whose
 * files land in — and come from — the panel's own backups directory in the
 * panel host's format.
 *
 * Networking (owner decision O7): the database joins ONLY its own bridge
 * `nd-dbnet-<slug>` on the node, never the node's shared `ninedeploy`
 * network. A service on the same node is connected to that bridge after its
 * container starts (the pipeline), and disconnected on detach.
 */

/** What a node needs to host a database: runSpec + volumes to start it, db.manage + stream for the rest. */
export const NODE_DATABASE_CAPS: readonly MultiNodeCapability[] = ['db.manage', 'stream', 'docker.runSpec', 'volume.manage'];
/** How a refusal names the feature (nodeFeatureRefusals pins it). */
export const NODE_DATABASE_FEATURE = 'host a managed database';

/** The node database's dedicated bridge (O7). */
export const nodeDatabaseNetwork = (slug: string): string => `nd-dbnet-${slug}`;
/** The node database's container and volume names (the `node_*` columns; `nd-db-<slug>` by convention). */
export const nodeContainerOf = (d: Pick<Database, 'slug' | 'nodeContainerName'>): string => d.nodeContainerName ?? `nd-db-${d.slug}`;
export const nodeVolumeOf = (d: Pick<Database, 'slug' | 'nodeVolumeName'>): string => d.nodeVolumeName ?? `nd-db-${d.slug}-data`;

/** The agent caller (tests inject one). Without `tolerateExit` a non-zero exit throws, like `agentOp`. */
export type NodeDatabaseAgent = (
  op: string,
  params: Record<string, unknown>,
  opts?: { tolerateExit?: boolean },
) => Promise<{ exitCode: number; lines: string[] }>;

export interface NodeDatabaseDeps {
  agent?: NodeDatabaseAgent;
  openStream?: (db: DB, serverId: number, kind: 'db.dump' | 'db.restore', params: Record<string, unknown>) => Promise<AgentStreamHandle>;
  /** Capability check (default: the queue-time `assertNodeCapability`, cached 5 min). */
  assertCapable?: (db: DB, serverId: number, caps: readonly MultiNodeCapability[], feature: string) => Promise<void>;
}

const defaultAssert = (db: DB, serverId: number, caps: readonly MultiNodeCapability[], feature: string) =>
  assertNodeCapability(db, serverId, { cap: caps, feature, sealedRequired: true });

/** Refuse a node that cannot host databases (422 node_agent_outdated / node_transport_unsealed, 502 node_unreachable). */
export function assertNodeDatabaseCapable(db: DB, serverId: number, deps: NodeDatabaseDeps = {}): Promise<void> {
  return (deps.assertCapable ?? defaultAssert)(db, serverId, NODE_DATABASE_CAPS, NODE_DATABASE_FEATURE);
}

/**
 * 0.15.6: keydb and dragonfly run on a node only when its agent's `db.exec` /
 * `db.dump` / `db.restore` know them (an older agent refuses the engine name).
 * Throws 422 `node_agent_outdated` with the usual update hint; every engine
 * that existed before is accepted whatever the agent's version (its own
 * capability check already ran).
 */
export function assertNodeAgentKnowsEngine(engine: string, agentVersion: string | null, nodeName: string): void {
  if (!NODE_ENGINES_NEEDING_NEWER_AGENT.has(engine) || agentVersionAtLeast(agentVersion, AGENT_REDIS_FAMILY_VERSION)) return;
  throw new HttpError(
    422,
    'node_agent_outdated',
    `The agent on node ${nodeName} (${agentVersion ? `version ${agentVersion}` : 'an older release'}) cannot run ${engine} databases. ` +
      `Update the node agent to v${AGENT_REDIS_FAMILY_VERSION} or newer (re-run the node's bootstrap from the Servers page, or pull and restart the matching ninedeploy agent image on the node).`,
  );
}

/** Labels a node database volume carries: the panel host's provenance labels plus the row id (adoption). */
export function nodeDatabaseVolumeLabels(d: Database, extra: Record<string, string> = {}): Record<string, string> {
  const cfg = ENGINES[d.engine];
  if (!cfg) throw new Error(`Unknown engine: ${d.engine}`);
  const labels: Record<string, string> = {
    'ninedeploy.managed': 'database',
    'ninedeploy.database.slug': d.slug,
    'ninedeploy.database.name': d.name,
    'ninedeploy.database.engine': d.engine,
    'ninedeploy.database.image': cfg.image(d.version ?? undefined),
    'ninedeploy.database.container': nodeContainerOf(d),
    'ninedeploy.database.id': String(d.id),
    'ninedeploy.owner': String(d.ownerUserId ?? ''),
    ...extra,
  };
  // The agent refuses multi-line or oversized values; empty ones are skipped like the panel host's.
  return Object.fromEntries(Object.entries(labels).filter(([, v]) => v !== '' && v.length <= 256 && !/[\0\r\n]/.test(v)));
}

/** The node's answer to `docker.inspect {format: 'state'}`: the container's state, or `missing`. Throws when the node cannot answer. */
export async function nodeContainerState(agent: NodeDatabaseAgent, name: string): Promise<string> {
  const res = await agent('docker.inspect', { name, format: 'state' }, { tolerateExit: true });
  if (res.exitCode !== 0) return 'missing';
  return (res.lines.find((l) => l.includes('|')) ?? res.lines[0] ?? '').split('|')[0]?.trim() || 'missing';
}

/** Write an agent→panel stream to `destFile` through the backup cipher (`encryptFileInPlace`'s envelope, never plaintext on disk). */
async function writeEncrypted(readable: Readable, done: Promise<unknown>, destFile: string): Promise<void> {
  const tmp = `${destFile}.${randomUUID()}.part`;
  const { cipher, header } = createBackupCipher();
  let headerWritten = false;
  const envelope = new Transform({
    transform(chunk, _encoding, callback) {
      if (!headerWritten) {
        this.push(header);
        headerWritten = true;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (!headerWritten) this.push(header);
      this.push(cipher.getAuthTag());
      callback();
    },
  });
  try {
    await Promise.all([pipeline(readable, cipher, envelope, createWriteStream(tmp, { mode: 0o600 })), done]);
    renameSync(tmp, destFile);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created */
    }
    throw err;
  }
}

/** The runtime methods for a database row on a node. Same shape as the panel host's (lib/databaseRuntime.ts). */
export function nodeDatabaseRuntime(db: DB, d: Database, deps: NodeDatabaseDeps = {}) {
  const serverId = d.serverId;
  if (serverId == null) throw new Error('not a node database');
  const agent: NodeDatabaseAgent = deps.agent ?? ((op, params, opts) => agentOp(db, serverId, op, params, () => undefined, opts));
  const openStream = deps.openStream ?? ((dbArg, id, kind, params) => openAgentStream(dbArg, id, kind, params));
  const container = nodeContainerOf(d);
  const volume = nodeVolumeOf(d);
  const network = nodeDatabaseNetwork(d.slug);
  const password = () => decrypt(d.passwordEncrypted);

  const dumpUnlocked = async (file: string, log: (line: string) => void): Promise<void> => {
    if (!DUMPABLE_ENGINES.has(d.engine)) throw new Error(`backup not supported for ${d.engine}`);
    log(`Dumping ${d.name} on node #${serverId} …`);
    const handle = await openStream(db, serverId, 'db.dump', { container, engine: d.engine, password: password() });
    if (handle.direction !== 'agent-to-panel') throw new Error('db.dump answered the wrong stream direction');
    handle.done.catch(() => undefined);
    try {
      await writeEncrypted(handle.readable, handle.done, file);
    } catch (err) {
      handle.abort('the panel could not store the dump');
      throw err;
    }
  };

  const streamInto = async (source: Readable, params: Record<string, unknown>): Promise<void> => {
    const handle = await openStream(db, serverId, 'db.restore', { container, engine: d.engine, password: password(), ...params });
    if (handle.direction !== 'panel-to-agent') throw new Error('db.restore answered the wrong stream direction');
    handle.done.catch(() => undefined);
    try {
      await Promise.all([pipeline(source, handle.writable), handle.done]);
    } catch (err) {
      handle.abort('the panel could not send the dump');
      throw err;
    }
  };

  return {
    where: 'node' as const,
    serverId,
    container,
    volume,
    network,

    /** Create the network and volume if missing, pull, then `docker.runSpec` on the database's own bridge. */
    async start(log: (line: string) => void, opts: { labels?: Record<string, string> } = {}): Promise<void> {
      const cfg = ENGINES[d.engine];
      if (!cfg) throw new Error(`Unknown engine: ${d.engine}`);
      await (deps.assertCapable ?? defaultAssert)(db, serverId, ['db.manage', 'docker.runSpec', 'volume.manage'], NODE_DATABASE_FEATURE);
      if ((await nodeContainerState(agent, container)) === 'running') {
        log(`${container} already running on node #${serverId} — reusing`);
        return;
      }
      // An existing network is a refused create: harmless.
      await agent('docker.networkCreate', { name: network, driver: 'bridge' }).catch(() => undefined);
      const volumeExists = (await agent('docker.volumeInspect', { name: volume }, { tolerateExit: true })).exitCode === 0;
      if (volumeExists) log(`Reusing volume ${volume} on node #${serverId}`);
      else {
        log(`Creating volume ${volume} on node #${serverId} …`);
        await agent('docker.volumeCreate', { name: volume, labels: nodeDatabaseVolumeLabels(d, opts.labels) });
      }
      const image = cfg.image(d.version ?? undefined);
      log(`Pulling database image ${image} on node #${serverId} …`);
      await agent('docker.pull', { image });
      // Remove a stale (stopped) container of the same name; the volume keeps the data.
      await agent('docker.rm', { name: container }).catch(() => undefined);
      const pw = password();
      const vars = cfg.env(pw);
      let envFile: string | undefined;
      if (Object.keys(vars).length > 0) {
        const wrote = await agent('file.writeEnv', { name: container, env: vars });
        envFile = wrote.lines.find((l) => l.startsWith('wrote '))?.slice('wrote '.length) ?? `.agent-env/${container}.env`;
      }
      const labels: Record<string, string> = { 'ninedeploy.database.slug': d.slug, 'ninedeploy.database.id': String(d.id) };
      for (const [k, v] of Object.entries(opts.labels ?? {})) if (/^ninedeploy\.[a-z0-9][a-z0-9._-]{0,127}$/.test(k)) labels[k] = v;
      const spec: Record<string, unknown> = {
        name: container,
        image,
        restart: 'unless-stopped',
        network,
        volumes: [{ name: volume, mount: resolveVolumePath(cfg, d.version) }],
        labels,
        managed: 'database',
        ...(envFile ? { envFile } : {}),
        // redis/valkey/keydb/dragonfly: the password follows the image (r644), then the engine's own flags, as on the panel host.
        ...(cfg.authViaArg ? { cmd: ['--requirepass', pw, ...(cfg.extraArgs ?? [])] } : {}),
        ...(d.cpuShares > 0 ? { cpuShares: d.cpuShares } : {}),
        ...(d.cpuLimitMilli > 0 ? { cpuLimitMilli: d.cpuLimitMilli } : {}),
        ...(d.memLimitMb > 0 ? { memLimitMb: d.memLimitMb } : {}),
      };
      log(`Starting ${d.engine} database ${d.name} (${container}) on node #${serverId} …`);
      try {
        await agent('docker.runSpec', spec);
      } catch (err) {
        if ((await nodeContainerState(agent, container).catch(() => 'missing')) === 'running') {
          log(`${container} is running despite the run failure — adopting it`);
          return;
        }
        await agent('docker.rm', { name: container }).catch(() => undefined);
        throw err;
      } finally {
        if (envFile) await agent('file.deleteEnv', { name: container }).catch(() => undefined);
      }
    },

    /** Remove the container; the volume (the data) stays. Throws when the node cannot be reached. */
    async stop(log: (line: string) => void): Promise<void> {
      log(`Stopping ${container} on node #${serverId} (volume retained) …`);
      await agent('docker.rm', { name: container });
    },

    async restart(log: (line: string) => void): Promise<void> {
      await (deps.assertCapable ?? defaultAssert)(db, serverId, ['db.manage'], NODE_DATABASE_FEATURE);
      log(`Restarting ${container} on node #${serverId} …`);
      await agent('docker.restart', { name: container });
    },

    async logs(lines = 100): Promise<string[]> {
      try {
        const res = await agent('docker.logs', { name: container }, { tolerateExit: true });
        return res.exitCode === 0 ? res.lines.filter(Boolean).slice(-lines) : [];
      } catch {
        return [];
      }
    },

    async size(): Promise<number> {
      if (sizeCommand(d.engine, container, '') === null) return 0;
      try {
        const res = await agent('db.exec', { container, engine: d.engine, query: 'size', password: password() }, { tolerateExit: true });
        return res.exitCode === 0 ? parseSizeOutput(d.engine, res.lines.join('\n')) : 0;
      } catch {
        return 0;
      }
    },

    async probeCredentials(attempts = 5, delayMs = 2_000): Promise<boolean> {
      if (probeCommand(d.engine, container, '') === null) return false;
      for (let i = 0; i < attempts; i++) {
        try {
          const res = await agent('db.exec', { container, engine: d.engine, query: 'probe', password: password() }, { tolerateExit: true });
          if (res.exitCode === 0 && probeSucceeded(d.engine, res.lines.filter((l) => l.trim() !== '').join('\n'))) return true;
        } catch {
          /* not ready yet, or the node did not answer */
        }
        if (i < attempts - 1) await sleep(delayMs);
      }
      return false;
    },

    async probeMysqlSandboxFlag(): Promise<string | null> {
      if (mysqlHelpCommand(d.engine, container) === null) return null;
      try {
        const res = await agent('db.exec', { container, engine: d.engine, query: 'mysqlHelp', password: password() }, { tolerateExit: true });
        return res.exitCode === 0 ? sandboxFlagFrom(d.engine, res.lines.join('\n')) : null;
      } catch {
        return null;
      }
    },

    /** Dump into `file` (the panel's backups directory), encrypted at rest. Serialised with restores and imports of this database. */
    backup(file: string, log: (line: string) => void): Promise<void> {
      return withDatabaseOperationLock(d.id, log, () => dumpUnlocked(file, log));
    },

    /** Restore an encrypted (or legacy plaintext) backup file from the panel into the node database. */
    restore(file: string, log: (line: string) => void): Promise<void> {
      if (!DUMPABLE_ENGINES.has(d.engine)) return Promise.reject(new Error(`restore not supported for ${d.engine}`));
      return withDatabaseOperationLock(d.id, log, async () => {
        log(`Restoring ${d.name} on node #${serverId} …`);
        await streamInto(await createBackupReadStream(file), { mode: 'restore' });
      });
    },

    /** 0.14 import: the safety backup and the import under one lock, as on the panel host. `file` is the staged plaintext dump. */
    import(file: string, plan: DatabaseImportPlan, log: (line: string) => void): Promise<void> {
      return withDatabaseOperationLock(d.id, log, async () => {
        if (plan.safetyBackup) {
          log('Taking the pre-import safety backup');
          try {
            await dumpUnlocked(plan.safetyBackup.file, log);
          } catch (err) {
            await plan.safetyBackup.onFailed(err);
            throw err;
          }
          await plan.safetyBackup.onDone();
        }
        await streamInto(createReadStream(file), {
          mode: 'import',
          format: plan.format,
          ...(plan.gzip !== undefined ? { gzip: plan.gzip } : {}),
          ...(plan.clean !== undefined ? { clean: plan.clean } : {}),
          ...(plan.singleTransaction !== undefined ? { singleTransaction: plan.singleTransaction } : {}),
          ...(plan.drop !== undefined ? { drop: plan.drop } : {}),
          sandboxFlag: plan.sandboxFlag ?? null,
        });
      });
    },

    /**
     * Nodes never adopt a retained volume (design §12): a volume under this
     * name that this row did not create is refused (409). The row's own volume
     * from a failed first attempt carries its id and is reused.
     */
    async adoptRetainedVolume(_log: (line: string) => void): Promise<RetainedVolumeAdoption> {
      const exists = (await agent('docker.volumeInspect', { name: volume }, { tolerateExit: true })).exitCode === 0;
      if (!exists) return { action: 'fresh' };
      const listed = parseNodeVolumeList((await agent('docker.volumeList', {})).lines).find((v) => v.name === volume);
      if (listed?.labels['ninedeploy.database.id'] === String(d.id)) return { action: 'no-rekey-needed' };
      throw new HttpError(409, 'node_volume_exists', `Volume ${volume} already exists on node #${serverId}; a database on a node never adopts a retained volume. Remove it on the node, or pick another name.`);
    },

    /** Nodes: a service joins the database's bridge after its container starts (the pipeline). */
    async attachToServiceBridges(_slugs: string[], _log: (line: string) => void): Promise<void> {},

    /** Delete: the container and the bridge; the volume only with `purgeVolume`. */
    async remove(opts: { purgeVolume: boolean }, log: (line: string) => void): Promise<void> {
      log(`Removing ${container} on node #${serverId} …`);
      await agent('docker.rm', { name: container });
      await agent('docker.networkRm', { name: network }).catch(() => undefined);
      if (opts.purgeVolume) {
        log(`Deleting volume ${volume} on node #${serverId} …`);
        await agent('docker.volumeRm', { name: volume });
      }
    },

    /** The container's state on the node (`running`, `exited`, … or `missing`). Throws when the node cannot answer. */
    state(): Promise<string> {
      return nodeContainerState(agent, container);
    },

    /** Put a service container on this database's bridge (idempotent). */
    async connect(serviceContainer: string): Promise<void> {
      const res = await agent('docker.networkConnect', { network, container: serviceContainer }, { tolerateExit: true });
      if (res.exitCode !== 0 && !res.lines.some((l) => /already exists|already attached|endpoint with name/i.test(l))) {
        throw new Error(`could not connect ${serviceContainer} to ${network}: ${res.lines.join(' ').slice(-300)}`);
      }
    },

    /** Take a service container off this database's bridge (detach). Best effort. */
    async disconnect(serviceContainer: string): Promise<void> {
      await agent('docker.networkDisconnect', { network, container: serviceContainer }, { tolerateExit: true }).catch(() => undefined);
    },
  };
}

export type NodeDatabaseRuntime = ReturnType<typeof nodeDatabaseRuntime>;

/**
 * Put a node service's new container on the bridge of every database on the
 * same node it is attached to (O7; the pipeline, after the container starts
 * and before the healthcheck). Throws when a join fails: the service would
 * come up unable to reach its database.
 */
export async function connectServiceToNodeDatabases(
  db: DB,
  serverId: number,
  serviceContainer: string,
  attached: ReadonlyArray<{ id: number; slug: string }>,
  log: (line: string) => void,
  deps: NodeDatabaseDeps = {},
): Promise<void> {
  const agent: NodeDatabaseAgent = deps.agent ?? ((op, params, opts) => agentOp(db, serverId, op, params, () => undefined, opts));
  for (const a of attached) {
    const network = nodeDatabaseNetwork(a.slug);
    log(`Connecting ${serviceContainer} to ${network} on node #${serverId}`);
    const res = await agent('docker.networkConnect', { network, container: serviceContainer }, { tolerateExit: true });
    if (res.exitCode !== 0 && !res.lines.some((l) => /already exists|already attached|endpoint with name/i.test(l))) {
      throw new Error(`could not connect ${serviceContainer} to the database network ${network} on node #${serverId}: ${res.lines.join(' ').slice(-300)}`);
    }
  }
}

// ── reachability (plugins/nodeDatabases.ts writes it, the API reads it) ─────

/** What the status loop last learned about a node: reachable or not, and when it last answered. */
export interface NodeReachability {
  reachable: boolean;
  lastSeenAt: Date | null;
}
const reachability = new Map<number, NodeReachability>();

/** Record one status sweep of a node (an unreachable node keeps its last `lastSeenAt`). */
export function recordNodeReachability(serverId: number, reachable: boolean, at: Date = new Date()): void {
  const prev = reachability.get(serverId);
  reachability.set(serverId, { reachable, lastSeenAt: reachable ? at : (prev?.lastSeenAt ?? null) });
}

/** The last sweep's answer for a node, or null before the first sweep. */
export function nodeReachability(serverId: number): NodeReachability | null {
  return reachability.get(serverId) ?? null;
}

/** Test hook. */
export function resetNodeReachability(): void {
  reachability.clear();
}

/** `GET /v1/servers` → `databases`: how many managed databases each node hosts (design §5.7). */
export async function databasesPerServer(db: DB): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  try {
    const rows = await db.select({ serverId: databases.serverId }).from(databases).where(isNotNull(databases.serverId));
    for (const r of rows) counts.set(r.serverId as number, (counts.get(r.serverId as number) ?? 0) + 1);
  } catch {
    /* informational: the list still answers */
  }
  return counts;
}
