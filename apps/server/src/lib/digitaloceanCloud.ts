import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';
import {
  type CloudServer,
  type DigitalOceanOptions,
  type DigitalOceanServerCreate,
  type DigitalOceanStatus,
  digitalOceanServerCreate,
} from '@ninedeploy/schemas';
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
 * DigitalOcean droplets (G4.3, the second provider). The flow is Hetzner's
 * (lib/hetznerCloud.ts), and so is everything after the VM exists: the node
 * row, the link row `cloud_server:<serverId>`, the immediate rekey (the first
 * key's hash sits in the droplet's user data, which the metadata service
 * serves to any container on it) and the sweep that finishes a rekey cut
 * short.
 *
 * One difference: a droplet has no address when it is created. Its public
 * IPv4 is read back until it appears; a droplet that gets none is deleted
 * again.
 */

const API = 'https://api.digitalocean.com/v2';
const TOKEN_KEY = 'digitalocean_token_encrypted';
/** Every droplet the panel creates carries this tag, so the list reads only ours. */
export const DIGITALOCEAN_TAG = 'ninedeploy';
/** Distributions the agent bootstrap installs Docker on (DigitalOcean `distribution`). */
const SUPPORTED_DISTRIBUTION = /^(ubuntu|debian|fedora|rocky|alma|centos)/i;

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
  if (!token) throw new HttpError(409, 'digitalocean_not_configured', 'Save a DigitalOcean API token first (Servers → DigitalOcean).');
  return token;
}

export async function digitalOceanStatus(db: DB): Promise<DigitalOceanStatus> {
  const token = await readToken(db);
  return { configured: token !== null, tokenHint: token ? `…${token.slice(-4)}` : null };
}

/** Prove the token (a read call) before storing it. */
export async function saveDigitalOceanToken(db: DB, token: string): Promise<DigitalOceanStatus> {
  await digitalocean(token, 'GET', '/account');
  await setSettingString(db, TOKEN_KEY, encrypt(token));
  return digitalOceanStatus(db);
}

export async function deleteDigitalOceanToken(db: DB): Promise<void> {
  await db.delete(settings).where(eq(settings.key, TOKEN_KEY));
}

export class DigitalOceanApiError extends HttpError {
  constructor(
    readonly upstreamStatus: number,
    message: string,
  ) {
    super(upstreamStatus === 401 || upstreamStatus === 403 ? 400 : 502, 'digitalocean_api_error', message);
  }
}

async function digitalocean<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await guardedFetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new HttpError(502, 'digitalocean_unreachable', `DigitalOcean API unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { id?: string; message?: string };
      if (data.message) detail = `${data.id ?? res.status}: ${data.message}`.slice(0, 300);
    } catch {
      /* not JSON */
    }
    throw new DigitalOceanApiError(res.status, `DigitalOcean refused ${method} ${path.split('?')[0]}: ${detail}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ── options ────────────────────────────────────────────────────────────────

interface ApiSize {
  slug: string;
  description?: string;
  vcpus: number;
  memory: number;
  disk: number;
  price_monthly: number;
  regions: string[];
  available: boolean;
}

export async function digitalOceanOptions(db: DB): Promise<DigitalOceanOptions> {
  const token = await requireToken(db);
  const [regions, sizes, images, keys] = await Promise.all([
    digitalocean<{ regions: Array<{ slug: string; name: string; available: boolean }> }>(token, 'GET', '/regions?per_page=200'),
    digitalocean<{ sizes: ApiSize[] }>(token, 'GET', '/sizes?per_page=200'),
    digitalocean<{ images: Array<{ slug: string | null; distribution: string; name: string; status?: string; regions: string[] }> }>(
      token,
      'GET',
      '/images?type=distribution&per_page=200',
    ),
    digitalocean<{ ssh_keys: Array<{ id: number; name: string; fingerprint: string }> }>(token, 'GET', '/account/keys?per_page=200'),
  ]);
  return {
    regions: regions.regions.filter((r) => r.available).map((r) => ({ slug: r.slug, name: r.name })),
    sizes: sizes.sizes
      .filter((s) => s.available)
      .map((s) => ({
        slug: s.slug,
        description: s.description ?? s.slug,
        vcpus: s.vcpus,
        memoryGb: s.memory / 1024,
        diskGb: s.disk,
        priceMonthly: s.price_monthly,
        regions: [...s.regions].sort(),
      })),
    images: images.images
      .filter((i) => i.slug && SUPPORTED_DISTRIBUTION.test(i.distribution) && (i.status ?? 'available') === 'available')
      .map((i) => ({ slug: i.slug as string, description: `${i.distribution} ${i.name}`, regions: [...i.regions].sort() }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    sshKeys: keys.ssh_keys.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint })),
  };
}

// ── create ─────────────────────────────────────────────────────────────────

interface ApiDroplet {
  id: number;
  status: string;
  networks?: { v4?: Array<{ ip_address: string; type: string }> };
}

const publicIpv4 = (d: ApiDroplet): string | undefined => d.networks?.v4?.find((n) => n.type === 'public')?.ip_address;

export interface DigitalOceanCreateDeps {
  waitForAgent?: (serverId: number, host: string, port: number, token: string) => void;
  /** How long to wait for the droplet's public IPv4, and how often to look. */
  addressTimeoutMs?: number;
  addressStepMs?: number;
}

export async function createDigitalOceanServer(db: DB, raw: DigitalOceanServerCreate, deps: DigitalOceanCreateDeps = {}): Promise<CreatedCloudServer> {
  const input = digitalOceanServerCreate.parse(raw);
  const token = await requireToken(db);
  const agentToken = generateAgentToken();
  const tokenSha256 = createHash('sha256').update(agentToken).digest('hex');

  const created = await digitalocean<{ droplet: ApiDroplet }>(token, 'POST', '/droplets', {
    name: input.name,
    region: input.region,
    size: input.size,
    image: input.image,
    ssh_keys: input.sshKeyIds,
    user_data: hetznerUserData(input.agentPort, tokenSha256),
    tags: [DIGITALOCEAN_TAG],
    ipv6: true,
    monitoring: false,
  });
  const providerServerId = created.droplet.id;
  const undo = () => digitalocean(token, 'DELETE', `/droplets/${providerServerId}`).catch(() => undefined);

  // The address is assigned a few seconds after the create call answers.
  let ipv4 = publicIpv4(created.droplet);
  const until = Date.now() + (deps.addressTimeoutMs ?? 120_000);
  const step = deps.addressStepMs ?? 3_000;
  while (!ipv4 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, step));
    try {
      ipv4 = publicIpv4((await digitalocean<{ droplet: ApiDroplet }>(token, 'GET', `/droplets/${providerServerId}`)).droplet);
    } catch {
      /* a transient read error: look again */
    }
  }
  if (!ipv4) {
    await undo();
    throw new HttpError(502, 'digitalocean_no_ipv4', 'DigitalOcean did not give the droplet a public IPv4 address in time; it was deleted again.');
  }
  return recordCloudNode(db, {
    link: { provider: 'digitalocean', providerServerId, name: input.name, location: input.region, serverType: input.size, image: input.image, ipv4 },
    agentPort: input.agentPort,
    agentToken,
    undo,
    ...(deps.waitForAgent ? { waitForAgent: deps.waitForAgent } : {}),
  });
}

// ── list and delete ────────────────────────────────────────────────────────

export async function listDigitalOceanServers(db: DB): Promise<CloudServer[]> {
  if ((await readCloudLinks(db, 'digitalocean')).length === 0) return [];
  const token = await readToken(db);
  let remote: Map<number, string> | null = null;
  if (token) {
    try {
      const res = await digitalocean<{ droplets: ApiDroplet[] }>(token, 'GET', `/droplets?per_page=200&tag_name=${DIGITALOCEAN_TAG}`);
      remote = new Map(res.droplets.map((d) => [d.id, d.status]));
    } catch {
      remote = null;
    }
  }
  return cloudServerRows(db, 'digitalocean', remote);
}

/** Delete the droplet and its node row. Refused while the node hosts services, databases or Swarm work. */
export async function deleteDigitalOceanServer(db: DB, serverId: number): Promise<{ providerServerId: number | string; name: string }> {
  const link = await cloudLink(db, serverId, 'digitalocean', 'DigitalOcean');
  const token = await requireToken(db);
  const nodeExists = await assertCloudNodeRemovable(db, serverId);
  try {
    await digitalocean(token, 'DELETE', `/droplets/${link.providerServerId}`);
  } catch (err) {
    // Already gone on DigitalOcean: finish the cleanup here.
    if (!(err instanceof DigitalOceanApiError && err.upstreamStatus === 404)) throw err;
  }
  await forgetCloudNode(db, serverId, nodeExists);
  return { providerServerId: link.providerServerId, name: link.name };
}
