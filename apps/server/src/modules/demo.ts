import { eq, inArray, and } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  buildConfigs,
  databases,
  deployments,
  envVars,
  projects,
  serviceProjects,
  serviceWorkspaces,
  services,
  type DB,
} from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';

/**
 * The single demo payload: one real, deployable service built from a pinned
 * public GitHub repo (Docker source build — no PM2, no fake rows). Seeding
 * queues the first build so "Load demo" ends with a live app instead of
 * database rows pretending to run.
 */
const DEMO = {
  projectSlug: 'nextjs-demo',
  projectName: 'Next.js Demo',
  slug: 'nextjs-demo',
  name: 'Next.js Demo',
  repoUrl: 'https://github.com/ersinkoc/nextjs-test',
  branch: 'main',
  port: 3000,
  healthPath: '/api/health',
  publishedPort: 3000,
} as const;

/** Slugs the pre-0.5.0 seed created: rows that CLAIMED to be running with no
 *  real container or PM2 process behind any of them. */
const LEGACY = {
  projectSlug: 'nextjs-demo-stack',
  serviceSlugs: ['nextjs-docker-app', 'nextjs-pm2-service'],
  dbSlug: 'demo-postgres',
  // r221: what ONLY the fake rows carry. The slugs alone are ordinary names a
  // tenant may well use for real work.
  runtimeIds: ['docker-nextjs-demo-container', 'pm2-nextjs-demo-process'],
  dbPassword: 'demo_secure_pass_2026',
} as const;

function isLegacyFakeDatabase(row: { projectId: number | null; passwordEncrypted: string }, legacyProjectId: number | undefined): boolean {
  if (legacyProjectId == null || row.projectId !== legacyProjectId) return false;
  try {
    return decrypt(row.passwordEncrypted) === LEGACY.dbPassword;
  } catch {
    return false;
  }
}

/**
 * Reap the legacy fake demo stack on the first new-seed call. The old seed
 * inserted rows marked `running` with nothing behind them; the new demo is a
 * real build, so keeping the fakes around would leave two dead services and
 * a dead database on the dashboard forever.
 */
async function reapLegacyFakeStack(db: DB, userId: number): Promise<void> {
  const legacyProject = await db.query.projects.findFirst({
    where: eq(projects.slug, LEGACY.projectSlug),
  });
  // r221: matched by the fake rows' fingerprint, not by slug. The slug-only
  // match deleted ANY service slugged `nextjs-docker-app` / `nextjs-pm2-service`
  // and ANY database slugged `demo-postgres` — a tenant's real, running ones
  // included — on every "Load demo" press.
  const legacyServices = (
    await db
      .select()
      .from(services)
      .where(inArray(services.slug, [...LEGACY.serviceSlugs]))
  ).filter((s) => s.runtimeId != null && (LEGACY.runtimeIds as readonly string[]).includes(s.runtimeId));
  const dbCandidate = await db.query.databases.findFirst({
    where: eq(databases.slug, LEGACY.dbSlug),
  });
  const legacyDb = dbCandidate && isLegacyFakeDatabase(dbCandidate, legacyProject?.id) ? dbCandidate : undefined;
  if (legacyServices.length === 0 && !legacyDb) return;

  const svcIds = legacyServices.map((s) => s.id);
  if (svcIds.length > 0) {
    await db.delete(envVars).where(and(eq(envVars.scope, 'service'), inArray(envVars.scopeKey, svcIds)));
    await db.delete(deployments).where(inArray(deployments.serviceId, svcIds));
    await db.delete(buildConfigs).where(inArray(buildConfigs.serviceId, svcIds));
    await db.delete(serviceProjects).where(inArray(serviceProjects.serviceId, svcIds));
    await db.delete(serviceWorkspaces).where(inArray(serviceWorkspaces.serviceId, svcIds));
    await db.delete(services).where(inArray(services.id, svcIds));
  }
  if (legacyDb) {
    await db.delete(databases).where(eq(databases.id, legacyDb.id));
  }
  // The project goes only when nothing real is left in it.
  if (legacyProject) {
    const svcIdSet = new Set(svcIds);
    const members = await db.query.serviceProjects.findMany({ where: eq(serviceProjects.projectId, legacyProject.id) });
    const dbs = await db.query.databases.findMany({ where: eq(databases.projectId, legacyProject.id) });
    const occupied = members.some((m) => !svcIdSet.has(m.serviceId)) || dbs.some((d) => d.id !== legacyDb?.id);
    if (!occupied) await db.delete(projects).where(eq(projects.id, legacyProject.id));
  }
  void audit(db, userId, 'demo.legacy_reaped', [...LEGACY.serviceSlugs, LEGACY.dbSlug].join(','));
}

export const demoRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.post('/seed', { preHandler: [app.requireAdmin] }, async (req) => {
    const userId = req.user!.id;
    // One-time sweep: remove the pre-0.5.0 fake demo rows before seeding the
    // real one (no-op on installs that never pressed the old button).
    await reapLegacyFakeStack(app.db, userId);

    let project = await app.db.query.projects.findFirst({
      where: eq(projects.slug, DEMO.projectSlug),
    });
    if (!project) {
      const [insertedProject] = await app.db
        .insert(projects)
        .values({
          name: DEMO.projectName,
          slug: DEMO.projectSlug,
          description: 'Demo app built from its public GitHub repo with Docker',
        })
        .returning();
      project = insertedProject!;
      void audit(app.db, userId, 'project.create', project.name);
    }

    let service = await app.db.query.services.findFirst({
      where: eq(services.slug, DEMO.slug),
    });

    if (!service) {
      const [inserted] = await app.db
        .insert(services)
        .values({
          name: DEMO.name,
          slug: DEMO.slug,
          type: 'docker',
          repoUrl: DEMO.repoUrl,
          branch: DEMO.branch,
          port: DEMO.port,
          healthPath: DEMO.healthPath,
          publishedPort: DEMO.publishedPort,
          status: 'idle',
          cpuShares: 512,
          memLimitMb: 512,
        })
        .returning();
      service = inserted!;

      // The repo ships a root Dockerfile (multi-stage, EXPOSE 3000, its own
      // /api/health healthcheck) — build exactly that.
      await app.db.insert(buildConfigs).values({
        serviceId: service.id,
        buildPack: 'dockerfile',
        baseDir: '/',
        dockerfilePath: 'Dockerfile',
      });

      // Queue the first build right away: the deploy worker turns this row
      // into a real clone → docker build → run.
      await app.db.insert(deployments).values({
        serviceId: service.id,
        status: 'queued',
        trigger: 'user',
        message: 'Initial demo deployment from ersinkoc/nextjs-test',
      });

      void audit(app.db, userId, 'service.create', service.name);

      // Tag the new service into the demo project and the caller's personal
      // workspace (or every workspace for operators). Only on create — a
      // re-seed must not duplicate the tag rows.
      const personalWs = await app.db.query.workspaces.findFirst({
        where: (w, { eq: eqOp, and: andOp }) => andOp(eqOp(w.ownerId, userId), eqOp(w.slug, `personal-${String(userId)}`)),
      });
      const wsIds = personalWs ? [personalWs.id] : (await app.db.query.workspaces.findMany()).map((w) => w.id);
      await app.db.insert(serviceProjects).values({ serviceId: service.id, projectId: project.id });
      for (const wsId of wsIds) {
        await app.db.insert(serviceWorkspaces).values({ serviceId: service.id, workspaceId: wsId });
      }
    }

    return {
      ok: true,
      projectId: project.id,
      projectName: project.name,
      services: [
        {
          id: service.id,
          name: service.name,
          type: service.type,
          status: service.status,
          port: service.port,
        },
      ],
      database: null,
    };
  });
};
