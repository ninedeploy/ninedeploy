import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';
import { type CloudServer, type VultrOptions, type VultrServerCreate, type VultrStatus, vultrServerCreate } from '@ninedeploy/schemas';
import { generateAgentToken } from './agentClient.js';
import { decrypt, encrypt } from './crypto.js';
import { guardedFetch } from './egressGuard.js';
import { HttpError } from './errors.js';
import {
  type CreatedCloudServer,
  assertCloudNodeRemovable,
  cloudLink,
  cloudServerRows,
  forgetCloudNode,
  hetznerUserData,
  readCloudLinks,
  recordCloudNode,
} from './hetznerCloud.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * Vultr instances (G4.3, the third provider). The flow is Hetzner's
 * (lib/hetznerCloud.ts) and DigitalOcean's: the same user data, node row,
 * link row `cloud_server:<serverId>`, immediate rekey (Vultr serves the user
 * data on its metadata endpoint too) and sweep.
 *
 * Differences: Vultr names instances by UUID, takes the user data base64
 * encoded, and answers the create call with `main_ip` 0.0.0.0. The address is
 * read back until it is real; an instance that gets none is deleted again.
 */

const API = 'https://api.vultr.com/v2';
const TOKEN_KEY = 'vultr_token_encrypted';
/** Every instance the panel creates carries this tag, so the list reads only ours. */
export const VULTR_TAG = 'ninedeploy';
/** Distributions the agent bootstrap installs Docker on (Vultr OS `family`). */
const SUPPORTED_FAMILIES = new Set(['ubuntu', 'debian', 'fedora', 'rockylinux', 'almalinux', 'centos']);

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
  if (!token) throw new HttpError(409, 'vultr_not_configured', 'Save a Vultr API key first (Servers → Vultr).');
  return token;
}

export async function vultrStatus(db: DB): Promise<VultrStatus> {
  const token = await readToken(db);
  return { configured: token !== null, tokenHint: token ? `…${token.slice(-4)}` : null };
}

/** Prove the key (a read call) before storing it. */
export async function saveVultrToken(db: DB, token: string): Promise<VultrStatus> {
  await vultr(token, 'GET', '/account');
  await setSettingString(db, TOKEN_KEY, encrypt(token));
  return vultrStatus(db);
}

export async function deleteVultrToken(db: DB): Promise<void> {
  await db.delete(settings).where(eq(settings.key, TOKEN_KEY));
}

export class VultrApiError extends HttpError {
  constructor(
    readonly upstreamStatus: number,
    message: string,
  ) {
    super(upstreamStatus === 401 || upstreamStatus === 403 ? 400 : 502, 'vultr_api_error', message);
  }
}

async function vultr<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await guardedFetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new HttpError(502, 'vultr_unreachable', `Vultr API unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = `${res.status}: ${data.error}`.slice(0, 300);
    } catch {
      /* not JSON */
    }
    throw new VultrApiError(res.status, `Vultr refused ${method} ${path.split('?')[0]}: ${detail}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ── options ────────────────────────────────────────────────────────────────

interface ApiPlan {
  id: string;
  vcpu_count: number;
  ram: number;
  disk: number;
  monthly_cost: number;
  locations: string[];
  gpu_vram_gb?: number;
}

export async function vultrOptions(db: DB): Promise<VultrOptions> {
  const token = await requireToken(db);
  const [regions, plans, os, keys] = await Promise.all([
    vultr<{ regions: Array<{ id: string; city: string; country: string }> }>(token, 'GET', '/regions?per_page=500'),
    vultr<{ plans: ApiPlan[] }>(token, 'GET', '/plans?per_page=500'),
    vultr<{ os: Array<{ id: number; name: string; arch: string; family: string }> }>(token, 'GET', '/os?per_page=500'),
    vultr<{ ssh_keys: Array<{ id: string; name: string }> }>(token, 'GET', '/ssh-keys?per_page=500'),
  ]);
  return {
    regions: regions.regions.map((r) => ({ id: r.id, city: r.city, country: r.country })),
    plans: plans.plans
      // GPU plans need drivers the bootstrap does not install; a plan offered nowhere cannot be created.
      .filter((p) => !p.gpu_vram_gb && p.locations.length > 0)
      .map((p) => ({
        id: p.id,
        vcpus: p.vcpu_count,
        memoryGb: p.ram / 1024,
        diskGb: p.disk,
        priceMonthly: p.monthly_cost,
        regions: [...p.locations].sort(),
      })),
    images: os.os
      .filter((o) => o.arch === 'x64' && SUPPORTED_FAMILIES.has(o.family))
      .map((o) => ({ id: o.id, name: o.name, family: o.family }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sshKeys: keys.ssh_keys.map((k) => ({ id: k.id, name: k.name })),
  };
}

// ── create ─────────────────────────────────────────────────────────────────

interface ApiInstance {
  id: string;
  status: string;
  main_ip?: string;
  os?: string;
}

/** Vultr reports 0.0.0.0 until the address is assigned. */
const publicIpv4 = (i: ApiInstance): string | undefined => (i.main_ip && i.main_ip !== '0.0.0.0' ? i.main_ip : undefined);

export interface VultrCreateDeps {
  waitForAgent?: (serverId: number, host: string, port: number, token: string) => void;
  /** How long to wait for the instance's public IPv4, and how often to look. */
  addressTimeoutMs?: number;
  addressStepMs?: number;
}

export async function createVultrServer(db: DB, raw: VultrServerCreate, deps: VultrCreateDeps = {}): Promise<CreatedCloudServer> {
  const input = vultrServerCreate.parse(raw);
  const token = await requireToken(db);
  const agentToken = generateAgentToken();
  const tokenSha256 = createHash('sha256').update(agentToken).digest('hex');

  const created = await vultr<{ instance: ApiInstance }>(token, 'POST', '/instances', {
    region: input.region,
    plan: input.plan,
    os_id: input.osId,
    label: input.name,
    hostname: input.name,
    sshkey_id: input.sshKeyIds,
    user_data: Buffer.from(hetznerUserData(input.agentPort, tokenSha256)).toString('base64'),
    tags: [VULTR_TAG],
    enable_ipv6: true,
    backups: 'disabled',
  });
  const providerServerId = created.instance.id;
  const undo = () => vultr(token, 'DELETE', `/instances/${encodeURIComponent(providerServerId)}`).catch(() => undefined);

  // The address is assigned some seconds after the create call answers.
  let ipv4 = publicIpv4(created.instance);
  const until = Date.now() + (deps.addressTimeoutMs ?? 180_000);
  const step = deps.addressStepMs ?? 3_000;
  while (!ipv4 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, step));
    try {
      ipv4 = publicIpv4((await vultr<{ instance: ApiInstance }>(token, 'GET', `/instances/${encodeURIComponent(providerServerId)}`)).instance);
    } catch {
      /* a transient read error: look again */
    }
  }
  if (!ipv4) {
    await undo();
    throw new HttpError(502, 'vultr_no_ipv4', 'Vultr did not give the instance a public IPv4 address in time; it was deleted again.');
  }
  return recordCloudNode(db, {
    link: {
      provider: 'vultr',
      providerServerId,
      name: input.name,
      location: input.region,
      serverType: input.plan,
      image: created.instance.os || `os ${input.osId}`,
      ipv4,
    },
    agentPort: input.agentPort,
    agentToken,
    undo,
    ...(deps.waitForAgent ? { waitForAgent: deps.waitForAgent } : {}),
  });
}

// ── list and delete ────────────────────────────────────────────────────────

export async function listVultrServers(db: DB): Promise<CloudServer[]> {
  if ((await readCloudLinks(db, 'vultr')).length === 0) return [];
  const token = await readToken(db);
  let remote: Map<number | string, string> | null = null;
  if (token) {
    try {
      const res = await vultr<{ instances: ApiInstance[] }>(token, 'GET', `/instances?per_page=500&tag=${VULTR_TAG}`);
      remote = new Map(res.instances.map((i) => [i.id, i.status]));
    } catch {
      remote = null;
    }
  }
  return cloudServerRows(db, 'vultr', remote);
}

/** Delete the instance and its node row. Refused while the node hosts services, databases or Swarm work. */
export async function deleteVultrServer(db: DB, serverId: number): Promise<{ providerServerId: number | string; name: string }> {
  const link = await cloudLink(db, serverId, 'vultr', 'Vultr');
  const token = await requireToken(db);
  const nodeExists = await assertCloudNodeRemovable(db, serverId);
  try {
    await vultr(token, 'DELETE', `/instances/${encodeURIComponent(String(link.providerServerId))}`);
  } catch (err) {
    // Already gone on Vultr: finish the cleanup here.
    if (!(err instanceof VultrApiError && err.upstreamStatus === 404)) throw err;
  }
  await forgetCloudNode(db, serverId, nodeExists);
  return { providerServerId: link.providerServerId, name: link.name };
}
