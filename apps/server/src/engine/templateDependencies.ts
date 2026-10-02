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
import { isOperator } from '../lib/resourceAccess.js';
import { encrypt, randomToken } from '../lib/crypto.js';
import { findCatalogTemplate } from '../templates/catalog.js';
import {
  adoptRetainedVolume,
  attachDatabaseToServiceBridges,
  defaultPort,
  ENGINES,
  needsVolumeAdoption,
  startDatabase,
  volumeExists,
  volumeLabels,
} from './database.js';

export type TemplateDependencyResult = { database: Database; alreadyAttached: boolean } | null;

/** How many `<slug>-db`, `<slug>-db-2`, … names a dependency may try. */
const MAX_DEPENDENCY_SLUG_CANDIDATES = 10;

/**
 * Pick the database row a template's managed dependency lives in, for a
 * service that has no attached one yet.
 *
 * The name used to be fixed at `<service slug>-db`, and two things went wrong
 * with a fixed name:
 *
 *  • r642: database slugs are global, so anyone who created a database called
 *    `<victim slug>-db` first made every deploy of the victim's template
 *    service fail ("belongs to another resource") — slug squatting.
 *  • r641: a fresh row named `nd-db-<slug>-db-data` as its volume, and when a
 *    DELETED tenant's volume was retained under that name, the adoption step
 *    re-keyed (postgres) or mounted as-is (redis/valkey) the old data under
 *    the new owner. `POST /databases` refuses that for non-operators (r096);
 *    this worker-side path did not.
 *
 * Names are now tried in a fixed order — deterministic, so a retry after a
 * failed first start finds its own row again — and a candidate is skipped
 * when its row belongs to someone else or, for a non-operator owner, when a
 * volume already exists under its name that the volume's `ninedeploy.owner`
 * label does not tie to this owner. A reinstall by the same owner still
 * adopts its own retained data; operator-owned (and legacy owner-less)
 * services keep the previous adopt-anything behaviour. Rows that already
 * exist are untouched: the attachment path above finds them first.
 */
async function resolveDependencySlug(
  db: DB,
  service: Service,
  serviceProjectId: number | null,
  engine: string,
  log: (line: string) => void,
): Promise<{ kind: 'existing'; database: Database } | { kind: 'fresh'; slug: string }> {
  const base = `${service.slug}-db`;
  let ownerMayAdopt: boolean | undefined;
  for (let i = 0; i < MAX_DEPENDENCY_SLUG_CANDIDATES; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const row = await db.query.databases.findFirst({ where: eq(databases.slug, slug) });
    if (row) {
      if (row.ownerUserId === service.ownerUserId && row.projectId === serviceProjectId && row.engine === engine) {
        return { kind: 'existing', database: row };
      }
      // r642: someone else's database holds this name — never fail the deploy
      // over it, and never touch it; move on to the next name.
      log(`note: database name '${slug}' is taken by another resource — trying the next name`);
      continue;
    }
    // r641: a volume under this name outlived a deleted database. Only adopt
    // it when it is provably this owner's.
    ownerMayAdopt ??= service.ownerUserId == null || await isOperator(db, { id: service.ownerUserId });
    const volumeName = `nd-db-${slug}-data`;
    if (!ownerMayAdopt && await volumeExists(volumeName)) {
      const owner = (await volumeLabels(volumeName))['ninedeploy.owner'];
      if (owner !== String(service.ownerUserId)) {
        log(
          `note: a retained volume '${volumeName}' from a deleted database is not this service owner's — `
          + 'leaving it untouched and provisioning the dependency under the next name (an operator can adopt or delete it from the Volumes page)',
        );
        continue;
      }
    }
    return { kind: 'fresh', slug };
  }
  throw new Error(
    `No free name for the managed database: '${base}' through '${base}-${MAX_DEPENDENCY_SLUG_CANDIDATES}' are all taken by other databases or retained volumes — ask an operator to clean them up, or install the template under a different service name`,
  );
}

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

  if (!database) {
    const resolved = await resolveDependencySlug(db, service, serviceProjectId, template.dbEngine, log);
    if (resolved.kind === 'existing') {
      database = resolved.database;
    } else {
      const dbSlug = resolved.slug;
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
