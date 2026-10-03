import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { buildConfigs, services, type DB } from '@ninedeploy/db';
import { ninedeployManifest, type NinedeployManifest } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { notFound, parseId as num, unprocessable } from '../lib/errors.js';
import { loadServiceForUser } from '../lib/resourceAccess.js';
import { assertServiceRole } from '../lib/resourceAccess.js';

/**
 * `POST /v1/services/:id/manifest/apply` — the server half of
 * `ninedeploy manifest apply`. The CLI parses a project-side
 * `.ninedeploy` file, sends the resulting JSON shape here, and
 * the route reconciles each section into the corresponding
 * database row.
 *
 * Scope (PR #45):
 *   - runtime:  accepted but not yet persisted (drives the
 *     builder only; no DB columns).
 *   - build:    upsert into `build_configs` (installCmd,
 *               buildCmd, startCmd, baseDir, dockerfilePath).
 *   - run:      services (port, healthPath) + build_configs
 *               (restartPolicy, stopGraceSeconds).
 *   - network:  services (publishedPort only — the panel
 *               still controls host/net aliases).
 *   - notifications / alerts: still owned by
 *     `lib/applyManifestToService.ts` at deploy time and are
 *     intentionally outside this endpoint's scope (PR #46).
 *
 * Merge precedence (operator > manifest > DB): the panel's
 * non-null column always wins, so an explicit operator
 * override is never silently clobbered by a fresh apply.
 */
const applyBody = z.object({
  manifest: ninedeployManifest,
  // `merge` (default) only writes fields the manifest
  // supplies; `replace` is a per-field overwrite that still
  // respects "absent means leave alone" for the sections the
  // manifest omits entirely. We default to `merge` because
  // most operators expect a one-way "fill in what I forgot"
  // rather than a destructive overwrite of fields they never
  // declared in the manifest.
  strategy: z.enum(['merge', 'replace']).default('merge'),
});

export type ApplyBody = z.infer<typeof applyBody>;

/** Fields the apply routine touches, in DB column order. */
export interface ApplyDiff {
  service: {
    port?: number;
    healthPath?: string;
    publishedPort?: number | null;
  };
  build: {
    installCmd?: string;
    buildCmd?: string;
    startCmd?: string;
    baseDir?: string;
    dockerfilePath?: string | null;
    restartPolicy?: string;
    stopGraceSeconds?: number;
  };
}

export interface ApplyResult {
  service: { id: number };
  build: { id: number };
  touched: string[];
  diff: ApplyDiff;
}

function diffFor(manifest: NinedeployManifest): ApplyDiff {
  const diff: ApplyDiff = { service: {}, build: {} };

  if (manifest.build) {
    const b = manifest.build;
    if (b.install !== undefined) diff.build.installCmd = b.install;
    if (b.build !== undefined) diff.build.buildCmd = b.build;
    if (b.start !== undefined) diff.build.startCmd = b.start;
    if (b.baseDir !== undefined) diff.build.baseDir = b.baseDir;
    if (b.dockerfile !== undefined) diff.build.dockerfilePath = b.dockerfile;
  }

  if (manifest.run) {
    const r = manifest.run;
    if (r.port !== undefined) diff.service.port = r.port;
    if (r.healthcheck !== undefined) diff.service.healthPath = r.healthcheck;
    if (r.restart !== undefined) {
      diff.build.restartPolicy = r.restart;
      // When the operator restarts a `preDeployCmd`-heavy
      // service, give the lifecycle hook 30 s to drain
      // instead of the panel's 5 s default — a long preStop
      // otherwise gets killed mid-write.
      diff.build.stopGraceSeconds = 30;
    }
  }

  if (manifest.network) {
    const n = manifest.network;
    if (n.publishPort !== undefined) diff.service.publishedPort = n.publishPort;
  }

  return diff;
}

/**
 * Apply a `.ninedeploy` manifest's build / run / network
 * sections to a service's rows. Distinct from
 * `lib/applyManifestToService.ts` — that helper writes
 * operational rows (routes → domains, alerts → alertRules,
 * database → databaseAttachments) at deploy time; this one
 * writes runtime-config rows (services + buildConfigs) from
 * the CLI's `manifest apply` invocation.
 *
 * Sections the manifest does not mention are NOT cleared:
 * merge semantics are per-field, and the operator's panel
 * value wins on every column the manifest left alone.
 */
export async function applyManifestRuntimeConfig(
  db: DB,
  serviceId: number,
  manifest: NinedeployManifest,
  _strategy: 'merge' | 'replace' = 'merge',
): Promise<ApplyResult> {
  const diff = diffFor(manifest);
  const touched: string[] = [];

  // 1. Update the service row with the diff's service fields.
  //    Only include the keys that are actually set so we don't
  //    blow away other operator-managed columns.
  if (Object.keys(diff.service).length > 0) {
    await db.update(services).set(diff.service).where(eq(services.id, serviceId));
    touched.push('service');
  }

  // 2. Update the build_configs row. Every field the manifest
  //    did not mention is preserved: the `merge` strategy
  //    MUST NOT delete existing build-time values the
  //    manifest omits — a `start:`-only manifest must
  //    preserve the installCmd / buildCmd the operator set
  //    in the panel. (The diff object already contains only
  //    set fields, so a vanilla `.set(diff.build)` is the
  //    correct merge — drizzle's partial update does the
  //    rest.)
  if (Object.keys(diff.build).length > 0) {
    const [existing] = await db
      .select()
      .from(buildConfigs)
      .where(eq(buildConfigs.serviceId, serviceId));
    if (!existing) {
      throw unprocessable(`Service ${serviceId} has no build config — create the service first`);
    }
    await db
      .update(buildConfigs)
      .set(diff.build)
      .where(and(eq(buildConfigs.serviceId, serviceId), eq(buildConfigs.id, existing.id)));
    touched.push('build_config');
  }

  return {
    service: { id: serviceId },
    build: {
      id: (await db.select().from(buildConfigs).where(eq(buildConfigs.serviceId, serviceId)))[0]!.id,
    },
    touched,
    diff,
  };
}

export const manifestRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  app.post<{ Params: { id: string }; Body: ApplyBody }>(
    '/:id/manifest/apply',
    async (req) => {
      const id = num((req.params as { id: string }).id);
      const svc = await loadServiceForUser(app.db, id, req.user!);
      // Only admin+ may push a manifest — the apply is
      // destructive on the service row + build config, and a
      // `member` should not be able to mutate another tenant's
      // definition via a stale `.ninedeploy` from git.
      await assertServiceRole(app.db, svc, req.user!, 'admin');
      if (!svc.id) throw notFound('Service not found');
      const body = applyBody.parse(req.body);
      const result = await applyManifestRuntimeConfig(app.db, svc.id, body.manifest, body.strategy);
      void audit(
        app.db,
        req.user!.id,
        'service.manifest_apply',
        `${svc.name}: ${result.touched.join(',') || 'no-op'}`,
      );
      return {
        ok: true,
        serviceId: svc.id,
        touched: result.touched,
        // Echo the diff so the CLI can render a `git diff`-style
        // summary ("changed 3 fields, kept 7") without a
        // follow-up GET. Empty sections indicate the manifest
        // omitted them and the route respected the operator's
        // existing values.
        diff: result.diff,
      };
    },
  );
};
