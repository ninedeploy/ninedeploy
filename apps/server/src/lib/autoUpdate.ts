import { and, desc, eq, inArray } from 'drizzle-orm';
import { deployments, services, sources, type DB } from '@ninedeploy/db';
import { audit } from './audit.js';
import { decrypt } from './crypto.js';
import { parseImageRef } from './imageRef.js';
import { fetchImageDigest } from './imageWatch.js';

/**
 * Watchtower-style image auto-update sweep. For every RUNNING, image-based
 * service with `autoUpdate` enabled — panel-host or remote-node alike, the
 * probe reads the registry from the panel and the enqueued deployment
 * routes to the node's agent through the normal choke point: probe the
 * registry for the tag's current manifest digest and enqueue a normal
 * deployment (trigger `schedule`) when it moved. The deploy goes through
 * the same queue, builder, health checks and blue-green swap as any
 * manual deploy — a bad new image fails visibly while the old container
 * keeps serving.
 *
 * Safety properties:
 *  - The FIRST observation after enabling is a baseline only (stored, not
 *    acted on) — flipping the toggle can never trigger a deploy by itself.
 *  - A service with a queued/in-flight deployment is skipped; the next
 *    sweep re-checks after it settles.
 *  - Probe failures (private repo, registry down) are skips, not errors —
 *    the sweep must never take the panel down over a registry hiccup.
 *  - Digest-pinned refs (`image@sha256:…`) parse to null and are ignored.
 */

export interface SweepResult {
  /** Services probed successfully. */
  probed: number;
  /** Services where a change was detected and a deploy was enqueued. */
  enqueued: number;
  /** Services skipped (parse failure, probe failure, deploy already pending). */
  skipped: number;
}

export const IN_FLIGHT_STATUSES = ['queued', 'building', 'deploying'] as const;

/**
 * Resolve the pull credentials attached to a service: a `registry`-type
 * source (username + decrypted token) — the same rows the deploy-time
 * docker login consumes. Returns null for services without one, meaning
 * the probe runs anonymously (public repos only).
 */
async function registryCredential(
  db: DB,
  svc: typeof services.$inferSelect,
): Promise<{ username: string; password: string } | null> {
  if (!svc.sourceId) return null;
  const src = await db.query.sources.findFirst({ where: eq(sources.id, svc.sourceId) });
  if (!src || src.type !== 'registry' || !src.tokenEncrypted) return null;
  try {
    const password = decrypt(src.tokenEncrypted);
    const username = src.registryUsername ?? '';
    if (!username || !password) return null;
    return { username, password };
  } catch {
    // Undecryptable envelope (rotated-away master key) — treat as no
    // credential; the anonymous probe will skip private repos cleanly.
    return null;
  }
}

export async function sweepAutoUpdates(
  db: DB,
  probe: (registry: string, repository: string, tag: string, auth?: { username: string; password: string }) => Promise<string> = fetchImageDigest,
  log: (msg: string) => void = () => undefined,
): Promise<SweepResult> {
  const rows = await db.query.services.findMany();
  const candidates = rows.filter(
    (s) => s.type === 'docker' && !!s.image && s.autoUpdate === true && s.status === 'running',
  );

  const result: SweepResult = { probed: 0, enqueued: 0, skipped: 0 };
  for (const svc of candidates) {
    const ref = parseImageRef(svc.image!);
    if (!ref) {
      result.skipped++;
      continue;
    }
    // Private registries: a `registry`-type source attached to the service
    // supplies pull credentials for the probe (same rows the deploy-time
    // docker login uses).
    const auth = await registryCredential(db, svc);
    let digest: string;
    try {
      digest = await probe(ref.registry, ref.repository, ref.tag, auth ?? undefined);
      result.probed++;
    } catch (err) {
      result.skipped++;
      log(`auto-update: ${svc.name} skipped — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!svc.autoUpdateDigest) {
      // First observation after enabling — record the baseline, act never.
      await db.update(services).set({ autoUpdateDigest: digest }).where(eq(services.id, svc.id));
      continue;
    }
    if (svc.autoUpdateDigest === digest) continue;

    const inflight = await db.query.deployments.findFirst({
      where: and(eq(deployments.serviceId, svc.id), inArray(deployments.status, [...IN_FLIGHT_STATUSES])),
      orderBy: desc(deployments.id),
    });
    if (inflight) {
      // Do NOT store the digest — this sweep's change must survive until the
      // service settles and the next sweep can act on it.
      result.skipped++;
      continue;
    }

    await db.insert(deployments).values({
      serviceId: svc.id,
      status: 'queued',
      trigger: 'schedule',
      message: ['Auto-update:', svc.image, '→', digest.slice(0, 19)].join(' '),
    });
    await db.update(services).set({ autoUpdateDigest: digest }).where(eq(services.id, svc.id));
    void audit(db, null, 'autoupdate.enqueued', `${svc.name}: ${svc.image} moved to ${digest.slice(0, 19)}`, {
      serviceId: svc.id,
    });
    result.enqueued++;
  }
  return result;
}
