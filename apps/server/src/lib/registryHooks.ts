import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';
import { isDockerHub, parseImageRef } from './imageRef.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G1.7 registry push webhooks. A secret URL per image service that a
 * registry calls when a tag is pushed; when the pushed repository and tag are
 * the service's image, the service redeploys (pulling the new image).
 *
 * No migration: the hook is a settings row `registry_hook:<serviceId>`
 * holding the SHA-256 of the token (never the token itself), the member it
 * deploys as and whether they had operator authority when they made it.
 */

const PREFIX = 'registry_hook:';
const key = (serviceId: number) => `${PREFIX}${serviceId}`;

export interface StoredRegistryHook {
  tokenSha256: string;
  userId: number;
  operator: boolean;
  createdAt: string;
  lastPushAt?: string | null;
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function getRegistryHook(db: DB, serviceId: number): Promise<StoredRegistryHook | null> {
  const raw = await getSettingJson<StoredRegistryHook>(db, key(serviceId), null);
  return raw && typeof raw.tokenSha256 === 'string' && Number.isInteger(raw.userId) ? raw : null;
}

/** Mint a new token (the previous one stops working); returns it once. */
export async function createRegistryHook(db: DB, serviceId: number, user: { id: number; isOperator: boolean }): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await setSettingJson<StoredRegistryHook>(db, key(serviceId), {
    tokenSha256: sha256(token),
    userId: user.id,
    operator: user.isOperator,
    createdAt: new Date().toISOString(),
    lastPushAt: null,
  });
  return token;
}

export async function deleteRegistryHook(db: DB, serviceId: number): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key(serviceId)));
}

export async function markRegistryPush(db: DB, serviceId: number, hook: StoredRegistryHook): Promise<void> {
  await setSettingJson<StoredRegistryHook>(db, key(serviceId), { ...hook, lastPushAt: new Date().toISOString() });
}

/** Constant-time comparison of a presented token against the stored hash. */
export function tokenMatches(hook: StoredRegistryHook, token: string): boolean {
  if (!TOKEN_RE.test(token)) return false;
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(hook.tokenSha256, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One pushed image as a registry reports it. `registry` is null when the payload does not say. */
export interface PushedImage {
  registry: string | null;
  repository: string;
  tag: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function fromRef(image: string): PushedImage | null {
  const ref = parseImageRef(image);
  return ref ? { registry: ref.registry, repository: ref.repository, tag: ref.tag } : null;
}

/**
 * The images a registry webhook payload says were pushed. Understands
 * Docker Hub, GitHub Packages (`registry_package`), Harbor (`PUSH_ARTIFACT`),
 * the Docker Distribution / `registry:2` notification envelope, and a plain
 * `{ "image": "host/repo:tag" }` or `{ "repository": "...", "tag": "..." }`
 * for a CI step. Anything else yields no images.
 */
export function pushedImages(body: unknown): PushedImage[] {
  const b = obj(body);
  if (!b) return [];
  const out: PushedImage[] = [];

  // Docker Hub: { push_data: { tag }, repository: { repo_name } }
  const pushData = obj(b['push_data']);
  const hubRepo = obj(b['repository']);
  if (pushData && hubRepo) {
    const name = str(hubRepo['repo_name']);
    const tag = str(pushData['tag']);
    if (name && tag) {
      const r = fromRef(`${name}:${tag}`);
      if (r) out.push(r);
    }
  }

  // GitHub Packages: { action: 'published', registry_package: { name, namespace, package_type, package_version: { container_metadata: { tag: { name } } } } }
  const pkg = obj(b['registry_package']);
  if (pkg) {
    const type = str(pkg['package_type'])?.toLowerCase();
    const name = str(pkg['name']);
    const namespace = str(pkg['namespace']) ?? str(obj(pkg['owner'])?.['login']);
    const tag = str(obj(obj(obj(pkg['package_version'])?.['container_metadata'])?.['tag'])?.['name']);
    if ((!type || type === 'container' || type === 'docker') && name && namespace && tag) {
      const r = fromRef(`ghcr.io/${namespace.toLowerCase()}/${name.toLowerCase()}:${tag}`);
      if (r) out.push(r);
    }
  }

  // Harbor: { type: 'PUSH_ARTIFACT', event_data: { resources: [{ tag, resource_url }], repository: { repo_full_name } } }
  const eventData = obj(b['event_data']);
  if (eventData && Array.isArray(eventData['resources'])) {
    for (const res of eventData['resources']) {
      const url = str(obj(res)?.['resource_url']);
      const r = url ? fromRef(url) : null;
      if (r) out.push(r);
    }
  }

  // Docker Distribution: { events: [{ action: 'push', target: { repository, tag }, request: { host } }] }
  if (Array.isArray(b['events'])) {
    for (const ev of b['events']) {
      const e = obj(ev);
      if (!e || str(e['action']) !== 'push') continue;
      const target = obj(e['target']);
      const repo = str(target?.['repository']);
      const tag = str(target?.['tag']);
      const host = str(obj(e['request'])?.['host']);
      if (!repo || !tag) continue;
      const r = fromRef(host ? `${host}/${repo}:${tag}` : `${repo}:${tag}`);
      if (r) out.push(host ? r : { ...r, registry: null });
    }
  }

  // A CI step: { image } or { repository, tag }
  const image = str(b['image']);
  if (image) {
    const r = fromRef(image);
    if (r) out.push(r);
  } else if (!pushData && typeof b['repository'] === 'string') {
    const tag = str(b['tag']) ?? 'latest';
    const r = fromRef(`${b['repository']}:${tag}`);
    if (r) out.push(r);
  }
  return out.slice(0, 50);
}

const sameRegistry = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || (isDockerHub(a) && isDockerHub(b));

/** Whether a pushed image is the service's image ref (same repository and tag; same registry when the payload names one). */
export function pushMatchesImage(pushed: PushedImage, serviceImage: string): boolean {
  const ref = parseImageRef(serviceImage);
  if (!ref) return false;
  if (pushed.repository.toLowerCase() !== ref.repository.toLowerCase() || pushed.tag !== ref.tag) return false;
  return pushed.registry === null || sameRegistry(pushed.registry, ref.registry);
}
