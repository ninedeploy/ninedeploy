import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { eq, isNotNull } from 'drizzle-orm';
import { type DB, servers } from '@ninedeploy/db';
import type { ServiceSwarmStatus, SwarmNode, SwarmStatus } from '@ninedeploy/schemas';
import { MAX_REPLICAS, TRAEFIK_CONTAINER } from '../engine/dockerNames.js';
import { ENCRYPTED_OVERLAY_ARGS, ensureEncryptedOverlay, SwarmOrchestrator, swarmStackRoot } from '../kernel/drivers/swarmOrchestrator.js';
import { capture, run } from './exec.js';
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
/**
 * The node label that marks a node holding this service's preloaded image:
 * `nd.preload.<slug>=<image id prefix>` on the nodes that received it, and a
 * constraint that requires it (security review M1d: positive, so a node the
 * panel never sent the image to can never qualify).
 */
export const swarmPreloadLabel = (slug: string): string => `nd.preload.${slug}`;
/** The label value of one image: the first 12 hex of its id or digest. */
export const swarmImageTag = (imageIdOrDigest: string): string => imageIdOrDigest.replace(/^.*sha256:/, '').slice(0, 12);
/**
 * Security review M1c: the panel's own node (at init) and every node joined
 * through the panel carry `nd.member=1`, and every Swarm service requires it,
 * so a node that joined the swarm any other way (a leaked token) never runs a task.
 */
export const SWARM_MEMBER_LABEL = 'nd.member';
export const SWARM_MEMBER_CONSTRAINT = `node.labels.${SWARM_MEMBER_LABEL}==1`;
/** A Swarm node id as Docker prints it (security review M3). */
export const RE_SWARM_NODE_ID = /^[a-z0-9]{25}$/;

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

/**
 * Security review L1: the ONE test every reader of `services.runtimeId` uses.
 * A runtime is a Swarm service only when its id is `nd-<slug>_web` for THIS
 * row's own slug, and the row is a Swarm service or a non-compose service that
 * left Swarm; never a compose service whose `container_name` happens to look
 * like one (`nd-victim_web`). Returns the Swarm service name, or null.
 */
export function swarmRuntimeOf(svc: { runtimeId?: string | null; slug?: string | null; orchestrator?: string | null; type?: string | null }): string | null {
  const runtimeId = svc.runtimeId;
  if (!isSwarmRuntimeId(runtimeId) || !svc.slug || swarmSlugOf(runtimeId) !== svc.slug) return null;
  if (svc.orchestrator !== 'swarm' && svc.type === 'compose') return null;
  return runtimeId;
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
 * Security review M1a: rotate the worker join token after every join and
 * leave, so a token that left the panel (sent to a node, visible there) is
 * dead once used. The new token is discarded. True when it rotated.
 */
export async function rotateWorkerJoinToken(): Promise<boolean> {
  return capture('docker', ['swarm', 'join-token', '--rotate', '-q', 'worker'], { timeoutMs: READ_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
}

/** `docker node update <flag> <value> -- <node>`; best effort, true when Docker accepted it. */
export async function updateNodeLabel(nodeId: string, flag: '--label-add' | '--label-rm', value: string): Promise<boolean> {
  if (!RE_SWARM_NODE_ID.test(nodeId)) return false;
  return run('docker', ['node', 'update', flag, value, '--', nodeId], { timeoutMs: READ_TIMEOUT_MS }, () => undefined)
    .then(() => true)
    .catch(() => false);
}

/**
 * Security review M1b: is `addr` one of this host's own interface addresses?
 * Then `swarm init` binds the management port there only (`--listen-addr`).
 * In a docker install the panel sees its container's interfaces, not the
 * host's, so this answers false and the default bind stays, with a warning.
 */
export function isLocalInterfaceAddr(addr: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): boolean {
  const want = addr.toLowerCase();
  return Object.values(interfaces).some((list) => (list ?? []).some((i) => i.address.toLowerCase() === want));
}

/** What the manager knows about a node (`docker node inspect`), for the join check (M3). */
export interface ManagerNodeView {
  id: string;
  role: string;
  addr: string;
  /** `Status.State`: ready, down, unknown, disconnected. */
  state: string;
  labels: Record<string, string>;
}

/**
 * `docker node inspect` of `nodeId`. Docker resolves the argument by full id,
 * then by node NAME (the hostname), then by id prefix, so the node this
 * answers for need not be `nodeId` — callers compare `view.id` (or use
 * {@link exactSwarmNode}). Null when the manager knows no such node.
 */
export async function inspectSwarmNode(nodeId: string): Promise<ManagerNodeView | null> {
  if (!RE_SWARM_NODE_ID.test(nodeId)) return null;
  try {
    const raw = await capture('docker', ['node', 'inspect', '--format', '{{json .}}', '--', nodeId], { timeoutMs: READ_TIMEOUT_MS });
    const j = JSON.parse(raw.trim()) as { ID?: string; Spec?: { Role?: string; Labels?: Record<string, string> }; Status?: { Addr?: string; State?: string } };
    if (!j.ID) return null;
    return { id: j.ID, role: j.Spec?.Role ?? '', addr: j.Status?.Addr ?? '', state: j.Status?.State ?? '', labels: j.Spec?.Labels ?? {} };
  } catch {
    return null;
  }
}

/**
 * Review M3 (verification): the node whose FULL id is `nodeId`, or null. A
 * name or prefix match (another node whose hostname is that string) is never
 * it, so no docker node command acts on a node the panel did not link.
 */
export async function exactSwarmNode(nodeId: string): Promise<ManagerNodeView | null> {
  const view = await inspectSwarmNode(nodeId);
  return view && view.id === nodeId ? view : null;
}

/** Refuse a swarm node id already linked to another server row (there is no unique index; this is the guard). Exact, full-id comparison. */
export async function swarmNodeLinkedElsewhere(db: DB, nodeId: string, serverId: number): Promise<{ id: number; name: string } | null> {
  const rows = await db.select({ id: servers.id, name: servers.name, swarmNodeId: servers.swarmNodeId }).from(servers).where(eq(servers.swarmNodeId, nodeId));
  return rows.find((r) => r.id !== serverId && r.swarmNodeId === nodeId) ?? null;
}

/**
 * Security review M3: the node id an agent reports is a claim. Before it is
 * linked to a server row (and labelled a member), the manager must confirm it:
 * a well-formed id that the manager knows AS AN ID (Docker would also resolve
 * a node's hostname, so a node naming itself after another node's id is
 * refused), a worker, not the panel's own node, not linked to another server,
 * and the address the manager sees is the server's host (a hostname host
 * matches when it resolves to that address — this trusts that host's DNS).
 * The confirmed id is the manager's `view.id`, the only id used from then on.
 */
export async function verifyJoinedNode(
  db: DB,
  server: { id: number; host: string },
  reported: string | null,
  deps: { resolve?: (host: string) => Promise<string[]> } = {},
): Promise<{ nodeId: string } | { refusal: string }> {
  if (!reported || !RE_SWARM_NODE_ID.test(reported)) return { refusal: `the node reported a malformed swarm node id (${JSON.stringify(reported ?? '').slice(0, 60)})` };
  const view = await inspectSwarmNode(reported);
  if (!view) return { refusal: `the manager does not know swarm node ${reported}` };
  if (view.id !== reported) return { refusal: `the manager resolves ${reported} to another node (${view.id}), by name or prefix, not by id` };
  const nodeId = view.id;
  const local = await localSwarmInfo();
  if (nodeId === local.nodeId) return { refusal: "the node reported the panel host's own swarm node id" };
  const other = await swarmNodeLinkedElsewhere(db, nodeId, server.id);
  if (other) return { refusal: `swarm node ${nodeId} is already linked to server "${other.name}" (#${other.id})` };
  if (view.role !== 'worker') return { refusal: `swarm node ${nodeId} is a ${view.role || 'node of unknown role'}, not a worker` };
  const host = server.host.replace(/^\[|\]$/g, '').toLowerCase();
  const addr = view.addr.toLowerCase();
  if (addr && addr === host) return { nodeId };
  const resolve =
    deps.resolve ??
    (async (h: string) => (await lookup(h, { all: true }).catch(() => [] as Array<{ address: string }>)).map((r) => r.address.toLowerCase()));
  if (addr && isIP(host) === 0 && (await resolve(host)).includes(addr)) return { nodeId };
  return { refusal: `swarm node ${nodeId} reaches the manager from ${view.addr || 'an unknown address'}, not from the server's host ${server.host}` };
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
    const state = await capture('docker', ['node', 'inspect', '--format', '{{.Status.State}}', '--', info.nodeId], { timeoutMs: READ_TIMEOUT_MS }).catch(() => '');
    if (state.trim() && state.trim() !== 'ready') return `The panel host's Swarm node is ${state.trim()}, not ready.`;
  }
  return null;
}

// ── the runtime of one Swarm service ───────────────────────────────────────

/**
 * Join Traefik to the service's overlay (the Swarm twin of
 * `ensureServiceBridge`), creating the attachable, ENCRYPTED overlay first
 * (IPsec data plane: Swarm nodes are usually separate hosts, often across the
 * public internet; there is no switch to turn it off). An existing network of
 * that name that is not an encrypted overlay is refused (security review L3).
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
export async function serviceSwarmView(svc: { runtimeId: string | null; slug: string; orchestrator?: string | null; type?: string }): Promise<ServiceSwarmStatus> {
  const runtimeId = swarmRuntimeOf(svc);
  if (!runtimeId) return { stack: null, desired: 0, running: 0, tasks: [] };
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

// ── registry credentials for `--with-registry-auth` ────────────────────────

const DOCKER_HUB_AUTH_KEY = 'https://index.docker.io/v1/';

/**
 * The `auths` key the Docker CLI looks a registry up by: Docker Hub (any of
 * its names, or none) is `https://index.docker.io/v1/`; anything else is the
 * bare `host[:port]`, without scheme or path, lowercased.
 */
export function dockerAuthKey(server: string | undefined): string {
  const host = (server ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  if (host === '' || host === 'docker.io' || host === 'index.docker.io' || host === 'registry-1.docker.io') return DOCKER_HUB_AUTH_KEY;
  return host;
}

/**
 * Security review M4: run `fn` with a Docker client config directory of its
 * own (0700, under the data directory, removed in `finally`), so a Swarm
 * deploy never reads or forwards the panel's shared Docker config. Nothing is
 * shared between deploys, so no registry lock is needed. `fn` should return
 * as soon as `stack deploy` has submitted the spec: the credential then leaves
 * the panel's disk while the update converges.
 *
 * With registry auth the panel WRITES `<dir>/config.json` itself (0600,
 * exclusive create) as `{"auths": {"<key>": {"auth": base64(user:pass)}}}`
 * and never runs `docker login`: against an empty config, `login` detects the
 * platform's default credential helper (wincred, osxkeychain, desktop, pass,
 * secretservice) and stores the password system-wide, where deleting the
 * directory does not reach it. A config that already holds `auths` makes the
 * CLI skip that detection. Without auth the directory stays empty and `fn`
 * forwards nothing.
 */
export async function withDeployDockerConfig<T>(
  auth: { username: string; password: string; server?: string } | undefined,
  log: (line: string) => void,
  fn: (dockerConfig: string) => Promise<T>,
): Promise<T> {
  const parent = swarmStackRoot();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  // mkdtemp creates the directory 0700 and fails if the path exists.
  const dir = mkdtempSync(join(parent, '.docker-'));
  try {
    if (auth) {
      const key = dockerAuthKey(auth.server);
      log(`Using the registry credential for ${key} in a private client config for this Swarm deploy only (removed once the deploy is submitted)`);
      const body = { auths: { [key]: { auth: Buffer.from(`${auth.username}:${auth.password}`).toString('base64') } } };
      writeFileSync(join(dir, 'config.json'), `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 });
    }
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The server row of a NineDeploy node by its Swarm node id. */
export async function serverForSwarmNode(db: DB, nodeId: string): Promise<{ id: number; name: string } | null> {
  const row = await db.query.servers.findFirst({ where: eq(servers.swarmNodeId, nodeId) });
  return row ? { id: row.id, name: row.name } : null;
}
