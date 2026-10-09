import { randomUUID } from 'node:crypto';
import { createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { databases, type DB, servers, services, serviceVolumeAttachments } from '@ninedeploy/db';
import type { HostVolumeEntry } from '@ninedeploy/schemas';
import { createBackupReadStream } from '../engine/database.js';
import { agentOp } from './agentClient.js';
import { assertNodeCapability } from './agentCapabilities.js';
import { type OpenAgentStreamOptions, openAgentStream, type StreamDone } from './agentStream.js';
import { createBackupCipher } from './crypto.js';
import { badRequest, HttpError, notFound } from './errors.js';
import { resolveVolumeOwner } from './inventory.js';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';
import { isNodeManagedVolume, NODE_VOLUME_CREATE_FEATURE } from './remoteVolumes.js';

/**
 * Volumes on a node, panel side (multi-node, design §4.2, §4.3): list,
 * create, size and usage through the agent's `volume.manage` ops, and backup
 * and restore through the sealed stream channel (`volume.export` /
 * `volume.import`).
 *
 * A node volume backup lands in the panel's `<backupsDir>` with the panel
 * host's file name and format: the agent tars the volume with the same pinned
 * helper image and the same `tar -czf - -C /v .`, and the panel writes the
 * bytes through the backup cipher straight to disk (the plaintext archive
 * never touches the panel's disk) — byte-for-byte the envelope
 * `backupVolume` produces with `encryptFileInPlace`. A restore streams the
 * decrypted archive back into the agent's staging script, which is the panel
 * host's `volumeRestoreScript`. So a node backup restores on the panel host
 * and back (with the operator's `acrossHosts` confirmation).
 *
 * Browsing and editing files inside a node volume is not offered (design
 * §4.3 lists no such route): the file manager stays panel-host only and
 * refuses `?serverId=` (modules/volumes.ts).
 */

/** The agent caller with the exit-code tolerance the panel's `agentOp` offers (tests inject one). */
export type NodeAgentOp = (
  serverId: number,
  op: string,
  params: Record<string, unknown>,
  opts?: { tolerateExit?: boolean },
) => Promise<{ exitCode: number; lines: string[] }>;

const defaultOp =
  (db: DB): NodeAgentOp =>
  (serverId, op, params, opts) =>
    agentOp(db, serverId, op, params, () => undefined, opts);

/**
 * `?serverId=` on the volume routes (design §4.3): absent or empty = the
 * panel host (null); otherwise a positive integer, or a 400.
 */
export function volumeHostId(query: unknown): number | null {
  const raw = (query as { serverId?: unknown } | undefined)?.serverId;
  if (raw === undefined || raw === '') return null;
  const id = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw badRequest('serverId must be a positive integer');
  return id;
}

/** The server row of a node, or a 404. */
export async function requireNode(db: DB, serverId: number): Promise<{ id: number; name: string }> {
  const row = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!row) throw notFound(`Server #${serverId} not found`);
  return { id: row.id, name: row.name };
}

/** Exit code the agent's `docker.volumeCreate` answers for `ifExists: 'fail'` on an existing volume. */
const VOLUME_EXISTS_EXIT = 3;

/** `docker volume ls --format '{{json .}}'` lines → name, labels, mountpoint (managed names only). */
export function parseNodeVolumeList(lines: readonly string[]): Array<{ name: string; labels: Record<string, string>; mountpoint: string | null }> {
  const out: Array<{ name: string; labels: Record<string, string>; mountpoint: string | null }> = [];
  for (const line of lines) {
    let row: { Name?: unknown; Labels?: unknown; Mountpoint?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    if (typeof row.Name !== 'string' || !isNodeManagedVolume(row.Name)) continue;
    const labels: Record<string, string> = {};
    if (typeof row.Labels === 'string') {
      for (const pair of row.Labels.split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
    out.push({ name: row.Name, labels, mountpoint: typeof row.Mountpoint === 'string' ? row.Mountpoint : null });
  }
  return out;
}

/** One container that mounts a volume, from `docker.volumeUsage`. */
export interface NodeVolumeUser {
  container: string;
  running: boolean;
}

/** `docker.volumeUsage` lines (`<name>\t<state>\t<mounts>`) → volume name → the containers mounting it. */
export function parseNodeVolumeUsage(lines: readonly string[]): Map<string, NodeVolumeUser[]> {
  const usage = new Map<string, NodeVolumeUser[]>();
  for (const line of lines) {
    const [container, state, mounts] = line.split('\t');
    if (!container || state === undefined || mounts === undefined) continue;
    for (const raw of mounts.split(',')) {
      const volume = raw.trim();
      if (!isNodeManagedVolume(volume)) continue;
      const users = usage.get(volume) ?? [];
      users.push({ container: container.replace(/^\//, ''), running: state.trim() === 'running' || state.trim() === 'restarting' });
      usage.set(volume, users);
    }
  }
  return usage;
}

/** The containers on the node that mount `name` (running or not). Throws when the node cannot answer. */
export async function nodeVolumeUsers(db: DB, serverId: number, name: string, op: NodeAgentOp = defaultOp(db)): Promise<NodeVolumeUser[]> {
  const res = await op(serverId, 'docker.volumeUsage', {});
  return parseNodeVolumeUsage(res.lines).get(name) ?? [];
}

/** Whether `name` exists on the node (`docker.volumeInspect` exits 0). Transport failures throw. */
export async function nodeVolumeExists(db: DB, serverId: number, name: string, op: NodeAgentOp = defaultOp(db)): Promise<boolean> {
  return (await op(serverId, 'docker.volumeInspect', { name }, { tolerateExit: true })).exitCode === 0;
}

/** `du -sb` of a node volume through the agent; 0 when it cannot be measured (as on the panel host). */
async function nodeVolumeSize(serverId: number, name: string, op: NodeAgentOp): Promise<number> {
  try {
    const res = await op(serverId, 'docker.volumeSize', { name }, { tolerateExit: true });
    if (res.exitCode !== 0) return 0;
    for (const line of res.lines) {
      const n = Number(line.trim().split(/\s+/)[0]);
      if (Number.isSafeInteger(n) && n >= 0) return n;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Owners of node volumes: only a service or database ON THIS NODE owns one
 * (the same rules as the panel host's `resolveVolumeOwner`; a node database
 * names its volume in `node_volume_name`). A namesake owned elsewhere leaves
 * the node's copy ownerless — retained data, as on the panel host.
 */
async function nodeVolumeOwners(db: DB, serverId: number, names: readonly string[]) {
  const [svcs, dbs, atts] = await Promise.all([db.select().from(services), db.select().from(databases), db.select().from(serviceVolumeAttachments)]);
  const hostSvcs = svcs.filter((s) => s.serverId === serverId);
  const hostDbs = dbs.filter((d) => d.serverId === serverId).map((d) => ({ ...d, volumeName: d.nodeVolumeName ?? d.volumeName, containerName: d.nodeContainerName ?? d.containerName }));
  const ids = new Set(hostSvcs.map((s) => s.id));
  const hostAtts = atts.filter((a) => ids.has(a.serviceId));
  return new Map(names.map((name) => [name, resolveVolumeOwner(hostSvcs, hostDbs, name, hostAtts)] as const));
}

/** One node volume as `GET /v1/volumes?serverId=` lists it. */
export type NodeVolumeEntry = HostVolumeEntry & { retainedFrom?: { name: string | null; engine: string | null } };

/**
 * `GET /v1/volumes?serverId=`: the node's managed volumes, with the panel
 * host's item shape plus `serverId`. `inUse` is true while a running
 * container on the node mounts the volume. Needs `volume.manage` (422
 * `node_agent_outdated` otherwise, after `agent.ping` only).
 */
export async function listNodeVolumes(db: DB, serverId: number, op: NodeAgentOp = defaultOp(db)): Promise<NodeVolumeEntry[]> {
  await requireNode(db, serverId);
  await assertNodeCapability(db, serverId, { cap: 'volume.manage', feature: 'list node volumes', sealedRequired: false });
  const listed = parseNodeVolumeList((await op(serverId, 'docker.volumeList', {})).lines);
  const usage = parseNodeVolumeUsage((await op(serverId, 'docker.volumeUsage', {})).lines);
  const owners = await nodeVolumeOwners(db, serverId, listed.map((v) => v.name));
  const out: NodeVolumeEntry[] = [];
  for (const v of listed) {
    const owner = owners.get(v.name) ?? null;
    const entry: NodeVolumeEntry = {
      name: v.name,
      sizeBytes: await nodeVolumeSize(serverId, v.name, op),
      owner: owner ? { kind: owner.kind, id: owner.refId, name: owner.name, ...(owner.engine ? { engine: owner.engine } : {}) } : null,
      inUse: (usage.get(v.name) ?? []).some((u) => u.running),
      serverId,
    };
    if (!owner && v.labels['ninedeploy.managed'] === 'database') {
      entry.retainedFrom = {
        name: v.labels['ninedeploy.database.name'] ?? v.labels['ninedeploy.database.slug'] ?? null,
        engine: v.labels['ninedeploy.database.engine'] ?? null,
      };
    }
    out.push(entry);
  }
  return out;
}

/**
 * `POST /v1/volumes` with a `serverId`: create a managed volume on the node,
 * labelled `ninedeploy.managed=volume` and `ninedeploy.owner=<user>`. Refuses
 * an existing volume with 409 `node_volume_exists` (it is never adopted
 * silently). Needs `volume.manage`.
 */
export async function createNodeVolume(
  db: DB,
  serverId: number,
  name: string,
  labels: Record<string, string>,
  op: NodeAgentOp = defaultOp(db),
): Promise<void> {
  await requireNode(db, serverId);
  await assertNodeCapability(db, serverId, { cap: 'volume.manage', feature: NODE_VOLUME_CREATE_FEATURE, sealedRequired: false });
  const res = await op(serverId, 'docker.volumeCreate', { name, labels, ifExists: 'fail' }, { tolerateExit: true });
  if (res.exitCode === VOLUME_EXISTS_EXIT) throw new HttpError(409, 'node_volume_exists', `Volume ${name} already exists on node #${serverId}`);
  if (res.exitCode !== 0) throw new Error(`Could not create volume ${name} on node #${serverId}: ${res.lines.join(' ').slice(-300)}`);
}

// ── backup and restore through the stream channel ───────────────────────────

/** One backup or restore at a time per node volume (the panel host serialises per volume the same way). */
const withNodeVolumeOperation = createKeyedOperationGuard<string>();

/**
 * Back a node volume up into `destFile` (the panel's backups directory),
 * encrypted at rest exactly like a panel-host volume backup. The bytes are
 * written to a 0600 sibling and renamed into place only after the stream's
 * end-to-end check passed, so a cut or corrupted transfer leaves no file
 * that looks like a backup. Refuses (422/502, before anything but
 * `agent.ping`) when the node cannot stream or export.
 */
export function backupNodeVolume(
  db: DB,
  serverId: number,
  name: string,
  destFile: string,
  log: (line: string) => void,
  opts: OpenAgentStreamOptions = {},
): Promise<StreamDone> {
  return withNodeVolumeOperation(`${serverId}:${name}`, async () => {
    log(`Snapshotting volume ${name} on node #${serverId} …`);
    const handle = await openAgentStream(db, serverId, 'volume.export', { volume: name }, opts);
    if (handle.direction !== 'agent-to-panel') throw new Error('volume.export answered the wrong stream direction');
    const done = handle.done;
    done.catch(() => undefined);
    const tmp = `${destFile}.${randomUUID()}.part`;
    const { cipher, header } = createBackupCipher();
    let headerWritten = false;
    // The envelope `encryptFileInPlace` (engine/database.ts) writes: the
    // header, the ciphertext, then the 16-byte GCM tag.
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
      const [, result] = await Promise.all([pipeline(handle.readable, cipher, envelope, createWriteStream(tmp, { mode: 0o600 })), done]);
      renameSync(tmp, destFile);
      log(`Snapshot of ${name} on node #${serverId} written to ${destFile} (${result.bytes} bytes streamed)`);
      return result;
    } catch (err) {
      handle.abort('the panel could not store the backup');
      try {
        unlinkSync(tmp);
      } catch {
        /* never created */
      }
      throw err;
    }
  });
}

/**
 * Restore `srcFile` (an encrypted or legacy-plaintext volume backup on the
 * panel) into a node volume. The decrypted archive streams to the agent, which
 * verifies it end to end and then runs the panel host's staging restore —
 * a corrupt archive leaves the volume as it was. The agent refuses while a
 * running container mounts the volume; callers check that first for the
 * "stop the service" message.
 */
export function restoreNodeVolume(
  db: DB,
  serverId: number,
  name: string,
  srcFile: string,
  log: (line: string) => void,
  opts: OpenAgentStreamOptions = {},
): Promise<StreamDone> {
  return withNodeVolumeOperation(`${serverId}:${name}`, async () => {
    log(`Restoring volume ${name} on node #${serverId} …`);
    const handle = await openAgentStream(db, serverId, 'volume.import', { volume: name }, opts);
    if (handle.direction !== 'panel-to-agent') throw new Error('volume.import answered the wrong stream direction');
    const done = handle.done;
    done.catch(() => undefined);
    try {
      const [, result] = await Promise.all([pipeline(await createBackupReadStream(srcFile), handle.writable), done]);
      log(`Volume ${name} on node #${serverId} restored`);
      return result;
    } catch (err) {
      handle.abort('the panel could not read the backup');
      throw err;
    }
  });
}
