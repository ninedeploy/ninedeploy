import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { services, sources, type DB } from '@ninedeploy/db';
import { audit } from './audit.js';
import { decrypt } from './crypto.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * r512: a registry credential is only ever sent to the registry host it was
 * created for.
 *
 * A `registry` source stores a username + token and nothing else — no host.
 * Every consumer derived the target host from the SERVICE's image at use
 * time (`docker login <host>` in the pipeline and the fan-out, Basic auth in
 * the auto-update probe), so whoever could change the image chose where the
 * operator's credential went: `image: attacker.example/x` and the next deploy
 * logged in to the attacker's registry with it.
 *
 * The binding lives in the settings table (no schema change): a map of
 * source id → the registry hosts the operator bound it to. Hosts are bound
 * by operator actions only — creating/editing the source with explicit
 * `registryHosts`, or attaching the source to / changing the image of a
 * service as an operator — and, once, by the upgrade seed below. Every use
 * site goes through `registryCredentialFor`, which withholds the credential
 * from any other host.
 */

export const REGISTRY_BINDINGS_KEY = 'registry_source_hosts';

/** Source id (as a string key) → bound registry hosts. */
export type RegistryBindings = Record<string, string[]>;

const DOCKER_HUB = 'docker.io';
const HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/** A registry host as written in an image ref (`ghcr.io`, `registry.local:5000`). */
export const REGISTRY_HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

/** Canonical spelling for comparisons: lowercase, Docker Hub's aliases folded. */
export function canonicalRegistryHost(host: string): string {
  const h = host.trim().toLowerCase();
  return HUB_ALIASES.has(h) ? DOCKER_HUB : h;
}

/**
 * The registry an image ref pulls from, by Docker's rule (lib/imageRef.ts):
 * the first path segment is a host when it contains '.' or ':' or is exactly
 * `localhost`; anything else (`nginx`, `acme/web`) is Docker Hub.
 */
export function registryHostOf(image: string): string {
  const trimmed = image.trim();
  const slash = trimmed.indexOf('/');
  const first = slash === -1 ? '' : trimmed.slice(0, slash);
  const isHost = first.includes('.') || first.includes(':') || first === 'localhost';
  return canonicalRegistryHost(isHost ? first : DOCKER_HUB);
}

function normalise(raw: unknown): RegistryBindings {
  const out: RegistryBindings = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, hosts] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !Array.isArray(hosts)) continue;
    const clean = [
      ...new Set(hosts.filter((h): h is string => typeof h === 'string').map(canonicalRegistryHost)),
    ].filter((h) => REGISTRY_HOST_RE.test(h));
    out[key] = clean.sort();
  }
  return out;
}

/** The stored bindings, or null when they were never initialised. */
export async function getRegistryBindings(db: DB): Promise<RegistryBindings | null> {
  const raw = await getSettingJson<unknown>(db, REGISTRY_BINDINGS_KEY, null);
  return raw == null ? null : normalise(raw);
}

async function writeBindings(db: DB, bindings: RegistryBindings): Promise<void> {
  await setSettingJson(db, REGISTRY_BINDINGS_KEY, normalise(bindings));
}

let seeding: Promise<RegistryBindings> | null = null;

/**
 * r512 upgrade path: 0.10.35 sent every registry credential to whatever host
 * the service image named. On the first boot of this release, bind each
 * registry source to the hosts its services pull from TODAY (so working
 * deploys keep their credential), mark the bindings initialised, and audit +
 * log what was bound so the operator can review it — a member who already
 * retargeted an image before the upgrade shows up in that list. Idempotent;
 * also run lazily from the use sites.
 */
export async function ensureRegistryBindingsInitialised(
  db: DB,
  log?: (msg: string, detail: Record<string, unknown>) => void,
): Promise<RegistryBindings> {
  const existing = await getRegistryBindings(db);
  if (existing) return existing;
  seeding ??= seedBindings(db, log).finally(() => {
    seeding = null;
  });
  return seeding;
}

async function seedBindings(
  db: DB,
  log?: (msg: string, detail: Record<string, unknown>) => void,
): Promise<RegistryBindings> {
  const registrySources = await db.query.sources.findMany({ where: eq(sources.type, 'registry') });
  const bindings: RegistryBindings = {};
  for (const src of registrySources) bindings[String(src.id)] = [];
  if (registrySources.length > 0) {
    const users = await db.query.services.findMany({
      where: and(inArray(services.sourceId, registrySources.map((s) => s.id)), isNotNull(services.image)),
    });
    for (const svc of users) {
      if (svc.sourceId == null || !svc.image) continue;
      const key = String(svc.sourceId);
      const list = bindings[key] ?? [];
      bindings[key] = list;
      const host = registryHostOf(svc.image);
      if (!list.includes(host)) list.push(host);
    }
  }
  await writeBindings(db, bindings);
  const seeded = normalise(bindings);
  const bound = Object.entries(seeded).filter(([, hosts]) => hosts.length > 0);
  if (bound.length > 0) {
    const summary = bound.map(([id, hosts]) => `source ${id} → ${hosts.join(', ')}`).join('; ');
    await audit(db, null, 'source.registry_hosts_seeded', summary, { bindings: seeded });
    log?.('registry credentials bound to the hosts their services use today (r512) — review them under Settings → Sources', {
      bindings: seeded,
    });
  }
  return seeded;
}

/** Hosts a registry source may be sent to. */
export async function boundRegistryHosts(db: DB, sourceId: number): Promise<string[]> {
  const bindings = await ensureRegistryBindingsInitialised(db);
  return bindings[String(sourceId)] ?? [];
}

/** Replace a source's bound hosts (operator action: the sources API). */
export async function setBoundRegistryHosts(db: DB, sourceId: number, hosts: string[]): Promise<string[]> {
  const bindings = { ...(await ensureRegistryBindingsInitialised(db)) };
  bindings[String(sourceId)] = hosts.map(canonicalRegistryHost);
  await writeBindings(db, bindings);
  return normalise(bindings)[String(sourceId)] ?? [];
}

/**
 * Bind the host of `image` to a registry source. Callers MUST only invoke
 * this for an operator's own action (attaching the source, or an operator
 * editing the image) — that is the whole trust model. A non-registry source
 * is ignored.
 */
export async function bindRegistryHostForImage(db: DB, sourceId: number, image: string): Promise<void> {
  const src = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
  if (src?.type !== 'registry') return;
  const host = registryHostOf(image);
  const current = await boundRegistryHosts(db, sourceId);
  if (current.includes(host)) return;
  await setBoundRegistryHosts(db, sourceId, [...current, host]);
}

export interface RegistryCredential {
  username: string;
  password: string;
  /** `docker login` server — undefined means Docker Hub. */
  server?: string;
}

/**
 * The ONE way to obtain a service's registry credential (pipeline login,
 * fan-out login, auto-update probe). Returns undefined when the service has
 * no complete registry credential — or when its image points at a host the
 * credential is not bound to, in which case the credential is withheld, the
 * reason is logged to `log` and audited, and the pull proceeds anonymously.
 */
export async function registryCredentialFor(
  db: DB,
  service: { id?: number; name?: string; sourceId: number | null; image: string | null },
  log?: (line: string) => void,
): Promise<RegistryCredential | undefined> {
  if (!service.sourceId || !service.image) return undefined;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, service.sourceId) });
  if (src?.type !== 'registry') return undefined;
  const username = src.registryUsername ?? '';
  const password = src.tokenEncrypted ? decrypt(src.tokenEncrypted) : '';
  if (!username || !password) return undefined;
  const host = registryHostOf(service.image);
  const bound = await boundRegistryHosts(db, src.id);
  if (!bound.includes(host)) {
    log?.(
      `registry credential "${src.name}" is bound to ${bound.length ? bound.join(', ') : 'no registry host'} — ` +
        `not sending it to ${host}. Pulling anonymously; an operator can bind ${host} to the credential ` +
        '(Settings → Sources) or set the image themselves.',
    );
    void audit(db, null, 'source.registry_credential_withheld', `${src.name} → ${host}`, {
      sourceId: src.id,
      ...(service.id != null ? { serviceId: service.id } : {}),
      host,
    });
    return undefined;
  }
  // The login server keeps the image's own spelling (unchanged from before):
  // a host-like first segment, else Docker Hub's default (undefined).
  const parts = service.image.split('/');
  const first = parts.length > 1 ? parts[0]! : '';
  const isHost = first.includes('.') || first.includes(':') || first === 'localhost';
  return { username, password, server: first !== '' && isHost ? first : undefined };
}

/**
 * r592: the registry credential for a SOURCE build fanned out to nodes.
 *
 * `registryCredentialFor` derives the login host from the service's image, so
 * a repository-built service (no image) never got one: every target node
 * built its Dockerfile anonymously and a private base image failed there,
 * even with a registry credential attached to the service.
 *
 * A source build names no registry of its own, so the host comes from the
 * credential's r512 binding — the only hosts an operator ever allowed it to
 * reach. Deliberately conservative: exactly ONE bound host is used; with none
 * or several, nothing is sent (several hosts would mean guessing which one
 * the Dockerfile's base images live on) and the reason is logged.
 */
export async function registryCredentialForSourceBuild(
  db: DB,
  service: { sourceId: number | null; image: string | null },
  log?: (line: string) => void,
): Promise<RegistryCredential | undefined> {
  if (!service.sourceId || service.image) return undefined;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, service.sourceId) });
  if (src?.type !== 'registry') return undefined;
  const username = src.registryUsername ?? '';
  const password = src.tokenEncrypted ? decrypt(src.tokenEncrypted) : '';
  if (!username || !password) return undefined;
  const bound = await boundRegistryHosts(db, src.id);
  if (bound.length !== 1) {
    log?.(
      `registry credential "${src.name}" is bound to ${bound.length ? bound.join(', ') : 'no registry host'} — ` +
        'a source build names no registry, so target nodes build without logging in. Bind exactly one host to ' +
        'the credential (Settings → Sources) for private base images.',
    );
    return undefined;
  }
  const host = bound[0]!;
  // Docker Hub logs in with no server operand, as for an image deploy.
  return { username, password, server: host === DOCKER_HUB ? undefined : host };
}
