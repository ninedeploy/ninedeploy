import { and, desc, eq, inArray } from 'drizzle-orm';
import { deployments, services, type DB } from '@ninedeploy/db';
import { audit } from './audit.js';
import { assertMayDeployStoredService } from './hostPrivilege.js';
import { parseImageRef } from './imageRef.js';
import { fetchImageDigest, type ProbeOptions } from './imageWatch.js';
import { registryCredentialFor } from './registryBinding.js';
import { isOperator } from './resourceAccess.js';

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
 * docker login consumes, through the same r512 host binding (a credential
 * is never sent to a registry it is not bound to). Returns null for
 * services without one, meaning the probe runs anonymously (public repos
 * only).
 */
async function registryCredential(
  db: DB,
  svc: typeof services.$inferSelect,
  log: (msg: string) => void,
): Promise<{ username: string; password: string } | null> {
  try {
    const cred = await registryCredentialFor(db, svc, (line) => log(`auto-update: ${svc.name} — ${line}`));
    return cred ? { username: cred.username, password: cred.password } : null;
  } catch {
    // Undecryptable envelope (rotated-away master key) — treat as no
    // credential; the anonymous probe will skip private repos cleanly.
    return null;
  }
}

/**
 * r513: the sweep enqueues a deploy with no request behind it, so it must
 * apply the same owner-privilege gate as the webhook receiver and the job
 * runner — a member's service that drifted into a host-executing shape
 * (docker socket, static build pack, lifecycle hooks) must not be redeployed
 * by the panel on their behalf. Returns the refusal reason, or null.
 */
async function autoUpdateRefusal(db: DB, svc: typeof services.$inferSelect): Promise<string | null> {
  const ownerId = svc.ownerUserId;
  // Legacy rows without an owner predate members (same convention as
  // assertWebhookMayDeploy / assertJobMayDeploy).
  if (!ownerId) return null;
  try {
    const ownerIsOperator = await isOperator(db, { id: ownerId });
    await assertMayDeployStoredService(db, { id: ownerId, isOperator: ownerIsOperator }, svc);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function sweepAutoUpdates(
  db: DB,
  probe: (
    registry: string,
    repository: string,
    tag: string,
    auth?: { username: string; password: string },
    opts?: ProbeOptions,
  ) => Promise<string> = fetchImageDigest,
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
    const auth = await registryCredential(db, svc, log);
    let digest: string;
    try {
      // r514: only an operator-controlled image ref may probe a private /
      // LAN registry (operators run those today); a member-owned ref keeps
      // the egress block. Ownerless legacy rows predate members (same
      // convention as autoUpdateRefusal) and count as operator-controlled.
      const allowPrivateEgress = !svc.ownerUserId || (await isOperator(db, { id: svc.ownerUserId }));
      digest = await probe(ref.registry, ref.repository, ref.tag, auth ?? undefined, { allowPrivateEgress });
      result.probed++;
    } catch (err) {
      result.skipped++;
      log(`auto-update: ${svc.name} skipped — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // A probe may finish after opt-out or a changed image; discard its snapshot.
    const current = (await db.query.services.findMany({ where: eq(services.id, svc.id) })).find((s) => s.id === svc.id);
    if (!current || !current.autoUpdate || current.status !== 'running' || current.type !== 'docker' ||
      current.image !== svc.image || current.autoUpdateDigest !== svc.autoUpdateDigest) {
      result.skipped++;
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

    const refusal = await autoUpdateRefusal(db, svc);
    if (refusal) {
      // Record the digest so the same move is refused (and audited) once,
      // not on every 30-minute sweep; the next image change is re-checked.
      await db.update(services).set({ autoUpdateDigest: digest }).where(eq(services.id, svc.id));
      log(`auto-update: ${svc.name} skipped — ${refusal}`);
      void audit(db, null, 'autoupdate.refused', `${svc.name}: ${refusal}`, { serviceId: svc.id });
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
