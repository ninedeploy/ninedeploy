import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { serviceTargets, services, servers, settings, type DB } from '@ninedeploy/db';
import {
  agentDockerRunCommand,
  type CloudServer,
  type HetznerOptions,
  type HetznerServerCreate,
  type HetznerStatus,
  hetznerServerCreate,
} from '@ninedeploy/schemas';
import { NODE_DOCKER_INSTALL_SCRIPT } from '../engine/serverProvisioner.js';
import { VERSION } from '../version.js';
import { agentOp, agentPing, generateAgentToken } from './agentClient.js';
import { decrypt, encrypt } from './crypto.js';
import { guardedFetch } from './egressGuard.js';
import { HttpError, conflict, notFound } from './errors.js';
import { serverDeleteBlockers } from './serverDependents.js';
import { getSettingJson, getSettingString, setSettingJson, setSettingString } from './settings.js';

/**
 * Hetzner Cloud servers (G4.3).
 *
 * The panel creates a VM whose cloud-init installs Docker (the same
 * per-distribution script the SSH bootstrap uses) and starts the NineDeploy
 * agent with a fresh token, registers it as a node (`offline`), and marks it
 * online once the agent answers a sealed ping. Deleting it removes the VM and
 * the node row, refused while the node hosts anything.
 *
 * Migration-free: the API token is one encrypted setting, and the link from a
 * node to its VM is a settings row per node (`cloud_server:<serverId>`).
 *
 * The first agent key's hash travels in the VM's user data, which Hetzner
 * keeps and serves to the metadata endpoint — readable from ANY container on
 * the node, so a member who deploys there could take the agent over. The
 * panel therefore rekeys the node (`agent.rekey`) right after the first
 * sealed ping, before it counts as online and before anything is deployed
 * to it; the hash in the metadata then opens nothing. A rekey that was cut
 * short (panel restart) is finished by {@link sweepCloudNodes}.
 */

const API = 'https://api.hetzner.cloud/v1';
const TOKEN_KEY = 'hetzner_cloud_token_encrypted';
const LINK_PREFIX = 'cloud_server:';
const linkKey = (serverId: number) => `${LINK_PREFIX}${serverId}`;
/** The new agent token of a rekey in progress (encrypted), kept until the agent answers with it. */
const REKEY_PREFIX = 'cloud_rekey:';
const rekeyKey = (serverId: number) => `${REKEY_PREFIX}${serverId}`;
const MANAGED_LABEL = 'managed-by';
const MANAGED_VALUE = 'ninedeploy';

/** Distributions the agent bootstrap installs Docker on (Hetzner `os_flavor`). */
const SUPPORTED_FLAVORS = new Set(['ubuntu', 'debian', 'rocky', 'alma', 'centos', 'fedora']);

// ── token ──────────────────────────────────────────────────────────────────

async function readToken(db: DB): Promise<string | null> {
  const raw = await getSettingString(db, TOKEN_KEY, null);
  if (!raw) return null;
  try {
    return decrypt(raw);
  } catch {
    return null;
  }
}

async function requireToken(db: DB): Promise<string> {
  const token = await readToken(db);
  if (!token) throw new HttpError(409, 'hetzner_not_configured', 'Save a Hetzner Cloud API token first (Servers → Hetzner Cloud).');
  return token;
}

export async function hetznerStatus(db: DB): Promise<HetznerStatus> {
  const token = await readToken(db);
  return { configured: token !== null, tokenHint: token ? `…${token.slice(-4)}` : null };
}

/** Prove the token (a read call) before storing it. */
export async function saveHetznerToken(db: DB, token: string): Promise<HetznerStatus> {
  await hetzner(token, 'GET', '/locations?per_page=1');
  await setSettingString(db, TOKEN_KEY, encrypt(token));
  return hetznerStatus(db);
}

export async function deleteHetznerToken(db: DB): Promise<void> {
  await db.delete(settings).where(eq(settings.key, TOKEN_KEY));
}

// ── API ────────────────────────────────────────────────────────────────────

export class HetznerApiError extends HttpError {
  constructor(
    readonly upstreamStatus: number,
    message: string,
  ) {
    super(upstreamStatus === 401 || upstreamStatus === 403 ? 400 : 502, 'hetzner_api_error', message);
  }
}

async function hetzner<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await guardedFetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new HttpError(502, 'hetzner_unreachable', `Hetzner Cloud API unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: { message?: string; code?: string } };
      if (data.error?.message) detail = `${data.error.code ?? res.status}: ${data.error.message}`.slice(0, 300);
    } catch {
      /* not JSON */
    }
    throw new HetznerApiError(res.status, `Hetzner Cloud refused ${method} ${path.split('?')[0]}: ${detail}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ── options ────────────────────────────────────────────────────────────────

interface ApiServerType {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  architecture: string;
  deprecated?: boolean;
  deprecation?: unknown;
  locations?: Array<{ name: string; deprecation?: unknown }>;
  prices?: Array<{ location: string }>;
}

export async function hetznerOptions(db: DB): Promise<HetznerOptions> {
  const token = await requireToken(db);
  const [locations, types, images, keys] = await Promise.all([
    hetzner<{ locations: Array<{ name: string; city: string; country: string }> }>(token, 'GET', '/locations?per_page=50'),
    hetzner<{ server_types: ApiServerType[] }>(token, 'GET', '/server_types?per_page=50'),
    hetzner<{ images: Array<{ name: string | null; description: string; os_flavor: string; architecture: string; deprecated: string | null }> }>(
      token,
      'GET',
      '/images?type=system&status=available&per_page=50',
    ),
    hetzner<{ ssh_keys: Array<{ id: number; name: string; fingerprint: string }> }>(token, 'GET', '/ssh_keys?per_page=50'),
  ]);
  return {
    locations: locations.locations.map((l) => ({ name: l.name, city: l.city, country: l.country })),
    serverTypes: types.server_types
      .filter((t) => !t.deprecated && !t.deprecation)
      .map((t) => ({
        name: t.name,
        description: t.description,
        cores: t.cores,
        memoryGb: t.memory,
        diskGb: t.disk,
        architecture: t.architecture,
        locations: (t.locations?.filter((l) => !l.deprecation).map((l) => l.name) ?? t.prices?.map((p) => p.location) ?? []).sort(),
      })),
    images: images.images
      .filter((i) => i.name && SUPPORTED_FLAVORS.has(i.os_flavor) && !i.deprecated)
      .map((i) => ({ name: i.name as string, description: i.description, architecture: i.architecture }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sshKeys: keys.ssh_keys.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint })),
  };
}

// ── create ─────────────────────────────────────────────────────────────────

/** The provider behind a cloud node (G4.3: Hetzner first, then DigitalOcean and Vultr). */
export type CloudProvider = 'hetzner' | 'digitalocean' | 'vultr';

/** The settings row that links a node to its VM; shared by every provider. */
export interface StoredLink {
  provider: CloudProvider;
  /** Hetzner and DigitalOcean number their VMs; Vultr uses UUIDs. */
  providerServerId: number | string;
  name: string;
  location: string;
  serverType: string;
  image: string;
  ipv4: string;
  createdAt: string;
  /** The first key (the one in the user data) was replaced. */
  rekeyed?: boolean;
}

/** The VM's cloud-init user data: Docker for its distribution, then the agent. */
export function hetznerUserData(agentPort: number, tokenSha256: string, imageTag: string = `v${VERSION}`): string {
  return [
    '#!/bin/sh',
    '# NineDeploy node bootstrap (cloud-init user data).',
    NODE_DOCKER_INSTALL_SCRIPT.trim(),
    'docker rm -f ninedeploy-agent 2>/dev/null || true',
    agentDockerRunCommand({ hostPort: agentPort, imageTag, tokenSha256, requireRekey: true }),
    '',
  ].join('\n');
}

export interface CreatedCloudServer {
  serverId: number;
  providerServerId: number | string;
  ipv4: string;
}

export async function createHetznerServer(
  db: DB,
  raw: HetznerServerCreate,
  opts: { waitForAgent?: (serverId: number, host: string, port: number, token: string) => void } = {},
): Promise<CreatedCloudServer> {
  const input = hetznerServerCreate.parse(raw);
  const token = await requireToken(db);
  const agentToken = generateAgentToken();
  const tokenSha256 = createHash('sha256').update(agentToken).digest('hex');

  const created = await hetzner<{ server: { id: number; public_net?: { ipv4?: { ip?: string } | null } } }>(token, 'POST', '/servers', {
    name: input.name,
    server_type: input.serverType,
    location: input.location,
    image: input.image,
    ssh_keys: input.sshKeyIds,
    user_data: hetznerUserData(input.agentPort, tokenSha256),
    labels: { [MANAGED_LABEL]: MANAGED_VALUE },
    start_after_create: true,
    public_net: { enable_ipv4: true, enable_ipv6: true },
  });
  const providerServerId = created.server.id;
  const ipv4 = created.server.public_net?.ipv4?.ip;
  const undo = () => hetzner(token, 'DELETE', `/servers/${providerServerId}`).catch(() => undefined);
  if (!ipv4) {
    await undo();
    throw new HttpError(502, 'hetzner_no_ipv4', 'Hetzner created the server without a public IPv4 address; it was deleted again.');
  }
  return recordCloudNode(db, {
    link: { provider: 'hetzner', providerServerId, name: input.name, location: input.location, serverType: input.serverType, image: input.image, ipv4 },
    agentPort: input.agentPort,
    agentToken,
    undo,
    ...(opts.waitForAgent ? { waitForAgent: opts.waitForAgent } : {}),
  });
}

/**
 * Register a VM the provider just created as an `offline` node and link it
 * (shared by every provider). `undo` deletes the VM when the node cannot be
 * recorded, so a failed create never leaves a paid VM behind.
 */
export async function recordCloudNode(
  db: DB,
  args: {
    link: Omit<StoredLink, 'createdAt' | 'rekeyed'>;
    agentPort: number;
    agentToken: string;
    undo: () => Promise<unknown>;
    waitForAgent?: (serverId: number, host: string, port: number, token: string) => void;
  },
): Promise<CreatedCloudServer> {
  const { link, agentPort, agentToken, undo } = args;
  // (host, port) is unique: a recycled IP still registered as another node.
  const existing = await db.query.servers.findFirst({ where: and(eq(servers.host, link.ipv4), eq(servers.port, agentPort)) });
  if (existing) {
    await undo();
    throw conflict(`Node "${existing.name}" is still registered at ${link.ipv4}:${agentPort}; delete it, then create the server again.`);
  }
  const [row] = await db
    .insert(servers)
    .values({ name: link.name, host: link.ipv4, port: agentPort, tokenEncrypted: encrypt(agentToken), status: 'offline' })
    .returning();
  if (!row) {
    await undo();
    throw new HttpError(500, 'node_not_recorded', 'Could not record the node');
  }
  const stored: StoredLink = { ...link, createdAt: new Date().toISOString(), rekeyed: false };
  await setSettingJson(db, linkKey(row.id), stored);
  args.waitForAgent?.(row.id, link.ipv4, agentPort, agentToken);
  return { serverId: row.id, providerServerId: link.providerServerId, ipv4: link.ipv4 };
}

// ── rekey ────────────────────────────────────────────────────────────────

/** A cloud node still on its first key: it must not be marked online or used yet. */
export async function cloudNodeAwaitingRekey(db: DB, serverId: number): Promise<boolean> {
  const link = await getSettingJson<StoredLink>(db, linkKey(serverId));
  return link?.rekeyed === false;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export interface RekeyDeps {
  ping?: typeof agentPing;
  op?: typeof agentOp;
  /** How long to wait for the restarted agent to answer with the new key. */
  settleMs?: number;
  stepMs?: number;
}

async function finishRekey(db: DB, serverId: number, token: string): Promise<void> {
  await db
    .update(servers)
    .set({ tokenEncrypted: encrypt(token), status: 'online', lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(servers.id, serverId));
  const link = await getSettingJson<StoredLink>(db, linkKey(serverId));
  if (link) await setSettingJson(db, linkKey(serverId), { ...link, rekeyed: true });
  await db.delete(settings).where(eq(settings.key, rekeyKey(serverId)));
}

/**
 * Replace a cloud node's first agent key. The new token is stored (encrypted)
 * before the agent hears of it, and the node row switches only once the
 * agent answers with it, so a cut-short rekey never locks the panel out:
 * {@link sweepCloudNodes} finishes it from the stored token. Resolves true
 * when the node answers with the new key.
 */
export function rekeyCloudNode(db: DB, serverId: number, deps: RekeyDeps = {}): Promise<boolean> {
  // One rekey per node at a time (the waiter and the sweep can meet here).
  const running = rekeysInFlight.get(serverId);
  if (running) return running;
  const run = rekeyCloudNodeOnce(db, serverId, deps).finally(() => rekeysInFlight.delete(serverId));
  rekeysInFlight.set(serverId, run);
  return run;
}

const rekeysInFlight = new Map<number, Promise<boolean>>();

async function rekeyCloudNodeOnce(db: DB, serverId: number, deps: RekeyDeps): Promise<boolean> {
  const ping = deps.ping ?? agentPing;
  const op = deps.op ?? agentOp;
  const node = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!node) return false;
  const answers = async (token: string) => {
    try {
      await ping(node.host, node.port, token);
      return true;
    } catch {
      return false;
    }
  };

  // A pending token is never replaced: the agent may have written its hash
  // and be about to restart with it. It is finished, or sent again.
  const pendingRaw = await getSettingString(db, rekeyKey(serverId), null);
  let fresh: string;
  if (pendingRaw) {
    let pending: string;
    try {
      pending = decrypt(pendingRaw);
    } catch {
      throw new Error(`cloud node ${serverId}: the pending agent key cannot be decrypted; not starting another rekey`);
    }
    if (await answers(pending)) {
      await finishRekey(db, serverId, pending);
      return true;
    }
    // Neither key answers: the agent is down or restarting; try again later.
    if (!(await answers(decrypt(node.tokenEncrypted)))) return false;
    fresh = pending;
  } else {
    // Only an agent that answers with its first key can be rekeyed.
    if (!(await answers(decrypt(node.tokenEncrypted)))) return false;
    fresh = generateAgentToken();
    await setSettingString(db, rekeyKey(serverId), encrypt(fresh));
  }
  await op(db, serverId, 'agent.rekey', { tokenSha256: sha256(fresh) }, () => undefined);
  const settle = deps.settleMs ?? 60_000;
  const step = deps.stepMs ?? 2_000;
  const until = Date.now() + settle;
  for (;;) {
    try {
      await ping(node.host, node.port, fresh);
      await finishRekey(db, serverId, fresh);
      return true;
    } catch {
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, step));
    }
  }
}

/**
 * Ping the new node's agent until it answers with its first key (cloud-init
 * takes a few minutes), then rekey it; the node turns online with the new
 * key. In-process: after a panel restart {@link sweepCloudNodes} takes over.
 */
export function waitForAgentInBackground(
  db: DB,
  log: FastifyBaseLogger,
  opts: { intervalMs?: number; timeoutMs?: number; ping?: typeof agentPing; rekey?: (serverId: number) => Promise<boolean> } = {},
): (serverId: number, host: string, port: number, token: string) => void {
  const interval = opts.intervalMs ?? 15_000;
  const deadline = opts.timeoutMs ?? 20 * 60_000;
  const ping = opts.ping ?? agentPing;
  const rekey = opts.rekey ?? ((id: number) => rekeyCloudNode(db, id));
  return (serverId, host, port, token) => {
    const started = Date.now();
    const attempt = async () => {
      try {
        await ping(host, port, token);
      } catch {
        if (Date.now() - started >= deadline) {
          log.warn({ component: 'hetzner', serverId }, 'cloud node agent did not answer in time; the cloud node sweep keeps trying');
          return;
        }
        setTimeout(() => void attempt(), interval).unref();
        return;
      }
      try {
        if (await rekey(serverId)) log.info({ component: 'hetzner', serverId }, 'cloud node rekeyed; node online');
        else log.warn({ component: 'hetzner', serverId }, 'cloud node rekey not confirmed yet; the cloud node sweep finishes it');
      } catch (err) {
        log.warn({ err, component: 'hetzner', serverId }, 'cloud node rekey failed; the cloud node sweep retries');
      }
    };
    setTimeout(() => void attempt(), interval).unref();
  };
}

/** Finish the rekey of every cloud node still on its first key (after a restart, or a rekey cut short). */
export async function sweepCloudNodes(db: DB, log: FastifyBaseLogger, deps: RekeyDeps = {}): Promise<void> {
  for (const { serverId, link } of await readCloudLinks(db)) {
    if (link.rekeyed) continue;
    try {
      if (await rekeyCloudNode(db, serverId, deps)) log.info({ component: 'hetzner', serverId }, 'cloud node rekeyed by the sweep');
    } catch (err) {
      log.warn({ err, component: 'hetzner', serverId }, 'cloud node rekey failed');
    }
  }
}

// ── list and delete ────────────────────────────────────────────────────────

/** Every linked cloud node, of every provider (or of one). */
export async function readCloudLinks(db: DB, provider?: CloudProvider): Promise<Array<{ serverId: number; link: StoredLink }>> {
  const rows = await db.query.settings.findMany();
  const out: Array<{ serverId: number; link: StoredLink }> = [];
  for (const r of rows) {
    if (!r.key.startsWith(LINK_PREFIX)) continue;
    const serverId = Number(r.key.slice(LINK_PREFIX.length));
    const link = (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) as StoredLink | null;
    if (Number.isSafeInteger(serverId) && link && (provider === undefined || link.provider === provider)) out.push({ serverId, link });
  }
  return out.sort((a, b) => a.serverId - b.serverId);
}

/** The list rows of one provider's nodes; `remote` is the provider's status per VM id, null when it could not be read. */
export async function cloudServerRows(db: DB, provider: CloudProvider, remote: Map<number | string, string> | null): Promise<CloudServer[]> {
  const out: CloudServer[] = [];
  for (const { serverId, link } of await readCloudLinks(db, provider)) {
    const node = await db.query.servers.findFirst({ where: eq(servers.id, serverId), columns: { status: true } });
    out.push({
      serverId,
      name: link.name,
      provider,
      providerServerId: link.providerServerId,
      location: link.location,
      serverType: link.serverType,
      image: link.image,
      ipv4: link.ipv4,
      providerStatus: remote ? (remote.get(link.providerServerId) ?? 'deleted') : null,
      nodeStatus: node ? (link.rekeyed === false && node.status === 'online' ? 'rekeying' : node.status) : 'removed',
      createdAt: link.createdAt,
    });
  }
  return out;
}

export async function listHetznerServers(db: DB): Promise<CloudServer[]> {
  if ((await readCloudLinks(db, 'hetzner')).length === 0) return [];
  const token = await readToken(db);
  let remote: Map<number, string> | null = null;
  if (token) {
    try {
      const res = await hetzner<{ servers: Array<{ id: number; status: string }> }>(
        token,
        'GET',
        `/servers?per_page=50&label_selector=${encodeURIComponent(`${MANAGED_LABEL}=${MANAGED_VALUE}`)}`,
      );
      remote = new Map(res.servers.map((s) => [s.id, s.status]));
    } catch {
      remote = null;
    }
  }
  return cloudServerRows(db, 'hetzner', remote);
}

/** The link of a cloud node of this provider, or 404. */
export async function cloudLink(db: DB, serverId: number, provider: CloudProvider, label: string): Promise<StoredLink> {
  const link = await getSettingJson<StoredLink>(db, linkKey(serverId));
  if (!link || link.provider !== provider) throw notFound(`No ${label} server is linked to this node`);
  return link;
}

/** Refuse deleting a cloud node's VM while the node hosts services, databases or Swarm work. Answers whether the node row exists. */
export async function assertCloudNodeRemovable(db: DB, serverId: number): Promise<boolean> {
  const node = await db.query.servers.findFirst({ where: eq(servers.id, serverId), columns: { id: true } });
  if (node) {
    const blockers = await serverDeleteBlockers(db, serverId);
    if (blockers.length > 0) throw new HttpError(409, blockers[0]!.code, blockers.map((b) => b.message).join(' '));
    const primary = await db.query.services.findMany({ where: eq(services.serverId, serverId), columns: { name: true } });
    const targets = await db.query.serviceTargets.findMany({ where: eq(serviceTargets.serverId, serverId), columns: { serviceId: true } });
    if (primary.length > 0 || targets.length > 0) {
      throw new HttpError(
        409,
        'server_hosts_services',
        `This node still hosts ${primary.length + targets.length} service placement(s)${primary.length ? ` (${primary.map((s) => s.name).join(', ')})` : ''}. Move or delete them first.`,
      );
    }
  }
  return node !== undefined;
}

/** After the VM is gone: the node row, its link and any pending rekey. */
export async function forgetCloudNode(db: DB, serverId: number, nodeExists: boolean): Promise<void> {
  if (nodeExists) await db.delete(servers).where(eq(servers.id, serverId));
  await db.delete(settings).where(eq(settings.key, linkKey(serverId)));
  await db.delete(settings).where(eq(settings.key, rekeyKey(serverId)));
}

/** Delete the VM and its node row. Refused while the node hosts services, databases or Swarm work. */
export async function deleteHetznerServer(db: DB, serverId: number): Promise<{ providerServerId: number | string; name: string }> {
  const link = await cloudLink(db, serverId, 'hetzner', 'Hetzner');
  const token = await requireToken(db);
  const nodeExists = await assertCloudNodeRemovable(db, serverId);
  try {
    await hetzner(token, 'DELETE', `/servers/${link.providerServerId}`);
  } catch (err) {
    // Already gone on Hetzner: finish the cleanup here.
    if (!(err instanceof HetznerApiError && err.upstreamStatus === 404)) throw err;
  }
  await forgetCloudNode(db, serverId, nodeExists);
  return { providerServerId: link.providerServerId, name: link.name };
}
