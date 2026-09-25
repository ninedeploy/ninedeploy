import {
  databaseAttachments,
  databases,
  type Database,
  type DB,
  serviceProjects,
  services,
  type Service,
} from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { encrypt, randomToken } from '../lib/crypto.js';
import { findCatalogTemplate } from '../templates/catalog.js';
import { adoptRetainedVolume, attachDatabaseToServiceBridges, defaultPort, ENGINES, needsVolumeAdoption, startDatabase } from './database.js';

export type TemplateDependencyResult = { database: Database; alreadyAttached: boolean } | null;

/**
 * Idempotently reconcile the durable Hub contract attached to a service.
 * This deliberately lives in the worker-owned pipeline, not an HTTP request:
 * retries reuse the same DB/volume/attachment and process restarts resume it.
 */
export async function reconcileTemplateDependencies(
  db: DB,
  service: Service,
  log: (line: string) => void,
): Promise<TemplateDependencyResult> {
  if (!service.templateId) return null;
  // r330: community-imported templates are installable too, so their
  // managed-database contract must resolve here as well.
  const template = await findCatalogTemplate(db, service.templateId);
  if (!template) {
    // A vanished template must never brick redeploys of already-installed
    // services. Managed-database stacks genuinely depend on the registry
    // contract (databaseEnv mapping) — those still fail loudly. Everything
    // else (compose stacks carry their DBs inside the stack) redeploys fine.
    if (service.templateDatabaseEnv) {
      throw new Error(`Hub template '${service.templateId}' is no longer available`);
    }
    log(`note: template '${service.templateId}' is no longer in the registry — no managed dependencies to reconcile`);
    return null;
  }
  if (!template.dbEngine) return null;

  const cfg = ENGINES[template.dbEngine];
  if (!cfg || !template.databaseEnv) throw new Error(`Template '${template.id}' has an invalid database contract`);

  // Services no longer carry a single `projectId`; they link to any number of
  // projects through `service_projects`. The managed database this template
  // provisions belongs in the service's first linked project, or stays
  // unscoped when the service is not filed under one.
  const links = await db.query.serviceProjects.findMany({
    where: eq(serviceProjects.serviceId, service.id),
  });
  const serviceProjectId = links[0]?.projectId ?? null;

  const attachments = await db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, service.id) });
  let database: Database | undefined;
  let alreadyAttached = false;
  for (const attachment of attachments) {
    const candidate = await db.query.databases.findFirst({ where: eq(databases.id, attachment.databaseId) });
    if (candidate?.engine === template.dbEngine) {
      if (candidate.ownerUserId !== service.ownerUserId || candidate.projectId !== serviceProjectId) {
        throw new Error('Attached template database belongs to another resource');
      }
      database = candidate;
      alreadyAttached = true;
      break;
    }
  }

  const dbSlug = `${service.slug}-db`;
  if (!database) {
    const retained = await db.query.databases.findFirst({ where: eq(databases.slug, dbSlug) });
    if (retained) {
      if (
        retained.ownerUserId !== service.ownerUserId
        || retained.projectId !== serviceProjectId
        || retained.engine !== template.dbEngine
      ) {
        throw new Error(`Database slug '${dbSlug}' belongs to another resource`);
      }
      database = retained;
    }
  }

  if (!database) {
    const [created] = await db.insert(databases).values({
      projectId: serviceProjectId,
      ownerUserId: service.ownerUserId,
      name: `${service.name} DB`,
      slug: dbSlug,
      engine: template.dbEngine,
      status: 'creating',
      containerName: `nd-db-${dbSlug}`,
      volumeName: `nd-db-${dbSlug}-data`,
      username: cfg.username() ?? null,
      passwordEncrypted: encrypt(randomToken(18)),
      dbName: cfg.dbName() ?? null,
      extensions: [],
      webGuiEnabled: false,
    }).returning();
    if (!created) throw new Error('Could not create template database');
    database = created;
  }

  log(`Ensuring ${template.dbEngine} dependency ${database.slug} is running …`);
  try {
    // A fresh row mounting a retained volume must never inherit the deleted
    // installation's credentials — re-key what can be re-keyed, refuse the
    // rest with provenance (this is the "reinstall then healthcheck never
    // passes" trap). The gate keys off the initializedAt marker, not the row
    // status alone: a failed first attempt flips the row to 'error' and the
    // RETRY must run the adoption again instead of booting stale credentials.
    // Rows whose start already succeeded under their own credentials keep
    // their marker and skip this entirely.
    if (needsVolumeAdoption(database)) await adoptRetainedVolume(database, log);
    await startDatabase(database, log, { labels: { 'ninedeploy.template': template.id } });
    // Model B: the DB must also live on the service's per-slug bridge so the
    // app can reach it by name without being able to reach other services.
    await attachDatabaseToServiceBridges(database, [service.slug], log);
    await db.update(databases).set({
      status: 'running',
      internalHost: database.containerName,
      internalPort: defaultPort(database.engine),
      initializedAt: database.initializedAt ?? new Date(),
    }).where(eq(databases.id, database.id));
  } catch (error) {
    await db.update(databases).set({ status: 'error' }).where(eq(databases.id, database.id));
    await db.update(services).set({ status: 'error' }).where(eq(services.id, service.id));
    throw new Error(`Failed to start template database: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!alreadyAttached) {
    await db.insert(databaseAttachments).values({
      serviceId: service.id,
      databaseId: database.id,
      envAlias: template.dbEngine === 'redis' || template.dbEngine === 'valkey' ? 'REDIS_URL' : 'DATABASE_URL',
    });
  }

  return {
    database: {
      ...database,
      status: 'running',
      internalHost: database.containerName,
      internalPort: defaultPort(database.engine),
    },
    alreadyAttached,
  };
}
