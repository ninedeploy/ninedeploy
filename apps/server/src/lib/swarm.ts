import { randomBytes } from 'node:crypto';
import { eq, isNotNull } from 'drizzle-orm';
import { type DB, servers } from '@ninedeploy/db';
import type { ServiceSwarmStatus, SwarmNode, SwarmStatus } from '@ninedeploy/schemas';
import { MAX_REPLICAS, TRAEFIK_CONTAINER } from '../engine/dockerNames.js';
import { ENCRYPTED_OVERLAY_ARGS, ensureEncryptedOverlay, SwarmOrchestrator } from '../kernel/drivers/swarmOrchestrator.js';
import { capture, run } from './exec.js';
import { acquireRegistryLock, registryLockKey } from './registryLock.js';
import { getSetting, getSettingString, setSetting, setSettingString } from './settings.js';
import type { ContainerStat } from './stats.js';

/**
 * Swarm (multi-node, design §7; owner decision O4): opt-in per service, the
 * panel host as the only manager, NineDeploy nodes joined as workers through
 * their agents. Nothing here runs until an operator initialises Swarm
 * (`POST /v1/swarm/init`) and enables it (`PUT /v1/swarm/settings`); a
 * service reaches Swarm only with `services.orchestrator = 'swarm'`.
 *
 * This module is the panel-host side: the cluster state, the names a Swarm
 * service runs under, and the runtime operations the routes that read
 * `services.runtimeId` branch to for a Swarm runtime (logs, stop / start /
 * restart, the terminal's local task, stats, removal).
 */

// ── settings (design §7.2) ─────────────────────────────────────────────────

/** Deploys of Swarm services are refused until an operator enables Swarm. Default false. */
export const SWARM_ENABLED_KEY = 'swarm_enabled';
/** The address `swarm init` advertised; nodes join `<addr>:2377`. */
export const SWARM_ADVERTISE_ADDR_KEY = 'swarm_advertise_addr';
export const SWARM_MANAGER_PORT = 2377;

export const swarmEnabled = (db: DB): Promise<boolean> => getSetting(db, SWARM_ENABLED_KEY, false);
export const setSwarmEnabled = (db: DB, enabled: boolean): Promise<void> => setSetting(db, SWARM_ENABLED_KEY, enabled);
export const swarmAdvertiseAddr = (db: DB): Promise<string | null> => getSettingString(db, SWARM_ADVERTISE_ADDR_KEY, null);
export const setSwarmAdvertiseAddr = (db: DB, addr: string): Promise<void> => setSettingString(db, SWARM_ADVERTISE_ADDR_KEY, addr);

// ── names (design §7.4) ────────────────────────────────────────────────────

/** The stack of one Swarm service. */
export const swarmStackName = (slug: string): string => `nd-${slug}`;
/** Its one Swarm service, whose VIP Traefik routes to: `services.runtimeId`. */
export const swarmServiceName = (slug: string): string => `${swarmStackName(slug)}_web`;
/** Its attachable overlay network, which Traefik joins. */
export const swarmNetworkName = (slug: string): string => `nd-swarm-${slug}`;
/** The node label that keeps tasks off a node lacking a preloaded image (`=0`). */
export const swarmPreloadLabel = (slug: string): string => `nd.preload.${slug}`;

/**
 * A Swarm runtime id is `nd-<slug>_web`. No other runtime can look like one:
 * container and PM2 runtimes are `<slug>-<deploymentId>`, compose runtimes
 * `ndcmp-<slug>-<service>-1`, and a slug never contains `_`.
 */
const RE_SWARM_RUNTIME = /^nd-([a-z0-9][a-z0-9-]*)_web$/;
export function isSwarmRuntimeId(runtimeId: string | null | undefined): runtimeId is string {
  return typeof runtimeId === 'string' && RE_SWARM_RUNTIME.test(runtimeId);
}
/** The slug of a Swarm runtime id, or null. */
export function swarmSlugOf(runtimeId: string | null | undefined): string | null {
  return typeof runtimeId === 'string' ? (RE_SWARM_RUNTIME.exec(runtimeId)?.[1] ?? null) : null;
}

const READ_TIMEOUT_MS = 30_000;
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── the panel host's daemon (the manager) ──────────────────────────────────

export interface LocalSwarmInfo {
  /** `docker info` `.Swarm.LocalNodeState` (inactive, pending, active, error, locked), or `unreachable`. */
  localState: string;
  controlAvailable: boolean;
  nodeId: string | null;
  nodeAddr: string | null;
}

/** `docker info --format '{{json .Swarm}}'` on the panel host. Never throws. */
export async function localSwarmInfo(): Promise<LocalSwarmInfo> {
  try {
    const raw = await capture('docker', ['info', '--format', '{{json .Swarm}}'], { timeoutMs: READ_TIMEOUT_MS });
    return parseSwarmInfo(raw);
  } catch {
    return { localState: 'unreachable', controlAvailable: false, nodeId: null, nodeAddr: null };
  }
}

/** Parse the `.Swarm` JSON `docker info` prints (the agent's `swarm.info` answers the same). */
export function parseSwarmInfo(raw: string): LocalSwarmInfo {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1);
  try {
    const j = JSON.parse(line ?? '') as { LocalNodeState?: string; ControlAvailable?: boolean; NodeID?: string; NodeAddr?: string };
    return {
      localState: j.LocalNodeState || 'inactive',
      controlAvailable: j.ControlAvailable === true,
      nodeId: j.NodeID || null,
      nodeAddr: j.NodeAddr || null,
    };
  } catch {
    return { localState: 'unknown', controlAvailable: false, nodeId: null, nodeAddr: null };
  }
}

/** `<advertise addr>:2377`: what a worker joins (IPv6 in brackets). */
export async function swarmManagerAddr(db: DB, info?: LocalSwarmInfo): Promise<string | null> {
  const addr = (await swarmAdvertiseAddr(db)) ?? (info ?? (await localSwarmInfo())).nodeAddr;
  if (!addr) return null;
  return addr.includes(':') ? `[${addr}]:${SWARM_MANAGER_PORT}` : `${addr}:${SWARM_MANAGER_PORT}`;
}

/** Every Swarm node, linked to its NineDeploy server row when one joined through its agent. Empty off a manager. */
export async function listSwarmNodes(db: DB): Promise<SwarmNode[]> {
  let raw: string;
  try {
    raw = await capture('docker', ['node', 'ls', '--format', '{{json .}}'], { timeoutMs: READ_TIMEOUT_MS });
  } catch {
    return [];
  }
  const rows = await db.select({ id: servers.id, swarmNodeId: servers.swarmNodeId }).from(servers).where(isNotNull(servers.swarmNodeId));
  const byNode = new Map(rows.map((r) => [r.swarmNodeId as string, r.id]));
  const out: SwarmNode[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const n = JSON.parse(line) as { ID?: string; Hostname?: string; ManagerStatus?: string; Availability?: string; Status?: string };
      if (!n.ID) continue;
      out.push({
        id: n.ID,
        hostname: n.Hostname ?? '',
        role: n.ManagerStatus ? 'manager' : 'worker',
        availability: (n.Availability ?? '').toLowerCase(),
        state: (n.Status ?? '').toLowerCase(),
        serverId: byNode.get(n.ID) ?? null,
      });
    } catch {
      /* not a node line */
    }
  }
  return out;
}

/** `GET /v1/swarm`. Join tokens are never part of it. */
export async function swarmStatusView(db: DB): Promise<SwarmStatus> {
  const info = await localSwarmInfo();
  return {
    enabled: await swarmEnabled(db),
    localState: info.localState,
    controlAvailable: info.controlAvailable,
    managerAddr: info.localState === 'active' ? await swarmManagerAddr(db, info) : null,
    nodes: info.controlAvailable ? await listSwarmNodes(db) : [],
  };
}

/** The worker join token (`docker swarm join-token -q worker`). Never logged, stored or returned. */
export async function workerJoinToken(): Promise<string> {
  const token = (await capture('docker', ['swarm', 'join-token', '-q', 'worker'], { timeoutMs: READ_TIMEOUT_MS })).trim();
  if (!/^SWMTKN-1-[a-z0-9-]+$/.test(token)) throw new Error('The panel host did not return a Swarm worker join token');
  return token;
}

/**
 * Why a Swarm service cannot deploy now (design §7.4 step 1), or null:
 * Swarm enabled, the panel host an active manager, and its own node ready.
 */
export async function swarmClusterRefusal(db: DB): Promise<string | null> {
  if (!(await swarmEnabled(db))) {
    return 'Swarm is not enabled on this panel: an operator initialises and enables it in Settings → Swarm (POST /v1/swarm/init, PUT /v1/swarm/settings), or set this service back to plain containers.';
  }
  const info = await localSwarmInfo();
  if (info.localState !== 'active' || !info.controlAvailable) {
    return `The panel host is not an active Swarm manager (state: ${info.localState}); Swarm services deploy only from the manager.`;
  }
  if (info.nodeId) {
    const state = await capture('docker', ['node', 'inspect', '--format', '{{.Status.State}}', info.nodeId], { timeoutMs: READ_TIMEOUT_MS }).catch(() => '');
    if (state.trim() && state.trim() !== 'ready') return `The panel host's Swarm node is ${state.trim()}, not ready.`;
  }
  return null;
}

// ── the runtime of one Swarm service ───────────────────────────────────────

/**
 * Join Traefik to the service's overlay (the Swarm twin of
 * `ensureServiceBridge`), creating the attachable, ENCRYPTED overlay first
 * (IPsec data plane: Swarm nodes are usually separate hosts, often across the
 * public internet; there is no switch to turn it off). An existing overlay
 * without encryption — created by hand or by an earlier tool — is reported on
 * the deploy log, never recreated: that would cut every running task off.
 * Idempotent.
 */
export async function ensureSwarmNetwork(slug: string, log: (line: string) => void): Promise<string> {
  const name = swarmNetworkName(slug);
  await ensureEncryptedOverlay(name, true, log);
  const traefik = await capture('docker', ['inspect', TRAEFIK_CONTAINER, '--format', '{{json .NetworkSettings.Networks}}'], { timeoutMs: READ_TIMEOUT_MS }).catch(
    () => '',
  );
  if (traefik && !traefik.includes(`"${name}"`)) {
    log(`attaching traefik to ${name}`);
    await run('docker', ['network', 'connect', name, TRAEFIK_CONTAINER], { timeoutMs: READ_TIMEOUT_MS }, log);
  }
  return name;
}

/**
 * Can this manager create an encrypted overlay at all? `swarm init` and
 * `join` ask before they report success, so a daemon that cannot (no IPsec
 * support, a Windows host) says so up front instead of at the first deploy.
 * Creates and removes a throwaway `nd-swarm-probe-<hex>`. Null when it can.
 */
export async function encryptedOverlayRefusal(): Promise<string | null> {
  const name = `nd-swarm-probe-${randomBytes(4).toString('hex')}`;
  try {
    await run('docker', ['network', 'create', ...ENCRYPTED_OVERLAY_ARGS, '--attachable', name], { timeoutMs: READ_TIMEOUT_MS }, () => undefined);
  } catch (err) {
    return (
      `The panel host's swarm cannot create an encrypted overlay network (docker network create --driver overlay --opt encrypted): ${msg(err)}. ` +
      'NineDeploy routes Swarm services only over encrypted overlays; encrypted overlays need IPsec (ESP, IP protocol 50) and do not work on Windows nodes.'
    );
  }
  await run('docker', ['network', 'rm', name], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch(() => undefined);
  return null;
}

/** Remove a Swarm service's stack and its overlay (Traefik leaves it first). Best effort, never throws. */
export async function removeSwarmStack(db: DB, slug: string, log: (line: string) => void): Promise<void> {
  const network = swarmNetworkName(slug);
  await run('docker', ['network', 'disconnect', '--force', network, TRAEFIK_CONTAINER], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch(() => undefined);
  // Even when the driver has no state for it (never recorded, or lost): `stack rm` is idempotent.
  await run('docker', ['stack', 'rm', swarmStackName(slug)], { timeoutMs: 120_000 }, () => undefined).catch(() => undefined);
  try {
    await new SwarmOrchestrator(db).removeStack(swarmStackName(slug));
    log(`removed the Swarm stack ${swarmStackName(slug)}`);
  } catch (err) {
    log(`warning: could not remove the Swarm stack ${swarmStackName(slug)}: ${msg(err)}`);
  }
  // The driver removes the networks it recorded; one created before its state was written goes here.
  await run('docker', ['network', 'rm', network], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch(() => undefined);
}

/** `docker service scale <svc>=<n>` (stop = 0, start = the service's replicas). */
export async function scaleSwarmService(runtimeId: string, replicas: number): Promise<void> {
  const n = Math.max(0, Math.min(Math.floor(replicas), MAX_REPLICAS));
  await capture('docker', ['service', 'scale', '--detach', `${runtimeId}=${n}`], { timeoutMs: 120_000 });
}

/** Restart every task (design §7.4: `docker service update --force`). */
export async function restartSwarmService(runtimeId: string): Promise<void> {
  await capture('docker', ['service', 'update', '--force', '--detach', runtimeId], { timeoutMs: 120_000 });
}

/** `docker service logs` — every task, wherever it runs (design §7.4). */
export async function swarmServiceLogs(runtimeId: string, tail = 300): Promise<string> {
  return capture('docker', ['service', 'logs', '--tail', String(tail), '--timestamps', runtimeId], { maxOutputBytes: 8 * 1024 * 1024, timeoutMs: 60_000 });
}

/** The running task containers of a Swarm service on the PANEL host, in task-slot order. */
export async function localSwarmTasks(runtimeId: string): Promise<string[]> {
  const out = await capture('docker', ['ps', '--filter', `label=com.docker.swarm.service.name=${runtimeId}`, '--format', '{{.Names}}'], {
    timeoutMs: READ_TIMEOUT_MS,
  }).catch(() => '');
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${runtimeId}.`))
    .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]) || a.localeCompare(b));
}

/**
 * The local task container a shell or a job runs in (design §7.4: a task on
 * the panel host, else a refusal naming where the replica runs).
 */
export async function localSwarmTaskFor(runtimeId: string, replica = 1): Promise<{ container: string } | { refusal: string }> {
  const local = await localSwarmTasks(runtimeId);
  const slot = local.find((name) => name.split('.')[1] === String(replica)) ?? (replica === 1 ? local[0] : undefined);
  if (slot) return { container: slot };
  const where = await capture('docker', ['service', 'ps', '--filter', 'desired-state=running', '--format', '{{.Name}} {{.Node}}', runtimeId], {
    timeoutMs: READ_TIMEOUT_MS,
  }).catch(() => '');
  const node = where
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([name]) => name === `${runtimeId}.${replica}`)?.[1];
  return {
    refusal: node
      ? `Replica ${replica} of this Swarm service runs on node ${node}, not on the panel host; open a node terminal there.`
      : `No replica of this Swarm service runs on the panel host; open a node terminal on the node that runs it.`,
  };
}

/** Stats of a Swarm service: its local tasks summed (design §7.4: local tasks only). */
export function swarmContainerStat(containers: ReadonlyMap<string, ContainerStat>, runtimeId: string): ContainerStat | undefined {
  let found: ContainerStat | undefined;
  for (const [name, st] of containers) {
    if (!name.startsWith(`${runtimeId}.`)) continue;
    found = found
      ? { name: runtimeId, cpuPct: found.cpuPct + st.cpuPct, memBytes: found.memBytes + st.memBytes, memLimitBytes: found.memLimitBytes + st.memLimitBytes }
      : { ...st, name: runtimeId };
  }
  return found;
}

/** `GET /v1/services/:id/swarm` (design §7.5). A service not on Swarm has no stack. */
export async function serviceSwarmView(svc: { runtimeId: string | null }): Promise<ServiceSwarmStatus> {
  if (!isSwarmRuntimeId(svc.runtimeId)) return { stack: null, desired: 0, running: 0, tasks: [] };
  const runtimeId = svc.runtimeId;
  const stack = runtimeId.slice(0, -'_web'.length);
  let desired = 0;
  let running = 0;
  const counts = await capture('docker', ['service', 'ls', '--filter', `name=${runtimeId}`, '--format', '{{.Name}} {{.Replicas}}'], { timeoutMs: READ_TIMEOUT_MS }).catch(
    () => '',
  );
  for (const line of counts.split('\n')) {
    const [name, replicas] = line.trim().split(/\s+/);
    const m = /^(\d+)\/(\d+)/.exec(replicas ?? '');
    if (name === runtimeId && m) [running, desired] = [Number(m[1]), Number(m[2])];
  }
  const raw = await capture('docker', ['service', 'ps', '--no-trunc', '--format', '{{json .}}', runtimeId], { timeoutMs: READ_TIMEOUT_MS }).catch(() => '');
  const tasks: ServiceSwarmStatus['tasks'] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('{') || tasks.length >= 50) continue;
    try {
      const t = JSON.parse(line) as { Node?: string; CurrentState?: string; Error?: string; Image?: string };
      tasks.push({ node: t.Node ?? '', state: t.CurrentState ?? '', error: t.Error ? t.Error : null, image: t.Image ?? '' });
    } catch {
      /* not a task line */
    }
  }
  return { stack, desired, running, tasks };
}

// ── registry login for `--with-registry-auth` ──────────────────────────────

/**
 * Log the panel host's Docker in for the duration of `fn`, so
 * `stack deploy --with-registry-auth` hands the credential to the workers
 * that pull the image; always logs out. Serialised per registry (r230).
 */
export async function withPanelRegistryLogin<T>(
  auth: { username: string; password: string; server?: string } | undefined,
  log: (line: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  if (!auth) return fn();
  const release = await acquireRegistryLock(registryLockKey(null, auth.server));
  try {
    log(`Logging in to ${auth.server ?? 'docker.io'} on the panel host for the Swarm deploy …`);
    await run('docker', ['login', '--username', auth.username, '--password-stdin', ...(auth.server ? [auth.server] : [])], { timeoutMs: 120_000 }, log, Buffer.from(`${auth.password}\n`));
    try {
      return await fn();
    } finally {
      await run('docker', ['logout', ...(auth.server ? [auth.server] : [])], {}, () => undefined).catch(() => undefined);
    }
  } finally {
    release();
  }
}

/** The server row of a NineDeploy node by its Swarm node id. */
export async function serverForSwarmNode(db: DB, nodeId: string): Promise<{ id: number; name: string } | null> {
  const row = await db.query.servers.findFirst({ where: eq(servers.swarmNodeId, nodeId) });
  return row ? { id: row.id, name: row.name } : null;
}
