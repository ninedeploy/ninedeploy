import { existsSync, unlinkSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { backups, databaseAttachments, databases, projects, type Database } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createAttachment, createDatabase, setLimits } from '@ninedeploy/schemas';
import {
  adoptRetainedVolume,
  connectionString,
  databaseLogs,
  defaultPort,
  ENGINES,
  needsVolumeAdoption,
  restartDatabase,
  startDatabase,
  startDatabaseStudio,
  stopDatabase,
  stopDatabaseStudio,
} from '../engine/database.js';
import { decrypt, encrypt, randomToken } from '../lib/crypto.js';
import {
  assertServiceRole,
  assertWorkspaceRole,
  assertDatabaseRole,
  loadDatabaseForUser,
  loadServiceForUser,
  visibleDatabaseIds,
} from '../lib/resourceAccess.js';
import { studioCookieName, studioCookieSetHeader, studioProxyPathFor } from './studioProxy.js';
import { badRequest, notFound, parseId as num } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';

/** Docker volume names only: prevents `existingVolume` from becoming a bind
 *  mount operand (`/etc`, `/:/x`) in `docker run -v <name>:<path>`. */
const DOCKER_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Per-volume creation lock. The volume-clash check and the row insert are
 * separated by awaits: two concurrent creates with the same `existingVolume`
 * could both pass the check and both mount one data directory — the loser's
 * re-key would leave the winner's stored credentials unable to reach the
 * volume at all. SQLite serializes the WRITES, not the check-then-act window;
 * this in-process chain closes it. The panel runs as a single Node process,
 * so a module-level chain is a complete guard.
 */
const volumeClaims = new Map<string, Promise<unknown>>();

async function serializeOnVolume<T>(volumeName: string, fn: () => Promise<T>): Promise<T> {
  const prev = volumeClaims.get(volumeName) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  volumeClaims.set(volumeName, next);
  try {
    return await next;
  } finally {
    if (volumeClaims.get(volumeName) === next) volumeClaims.delete(volumeName);
  }
}

function serialize(
  d: Database & {
    attachments?: Array<{
      service?: { id: number; name: string; slug: string } | null;
    }>;
  },
  opts: { isAdmin: boolean } = { isAdmin: true },
) {
  const cfg = ENGINES[d.engine];
  const attachedServices =
    d.attachments
      ?.map((a) => (a.service ? { id: a.service.id, name: a.service.name, slug: a.service.slug } : null))
      .filter((s): s is { id: number; name: string; slug: string } => s != null) ?? [];

  return {
    id: d.id,
    projectId: d.projectId,
    name: d.name,
    slug: d.slug,
    engine: d.engine,
    version: d.version,
    status: d.status,
    host: d.internalHost,
    port: d.internalPort,
    username: cfg?.username() ?? null,
    database: cfg?.dbName() ?? null,
    // The password-embedded URI is admin-only; members reveal credentials via
    // the dedicated /credentials endpoint (also admin-gated).
    connectionString: opts.isAdmin && d.status === 'running' ? connectionString(d) : null,
    containerName: d.containerName,
    volumeName: d.volumeName,
    cpuShares: d.cpuShares,
    memLimitMb: d.memLimitMb,
    webGuiEnabled: Boolean(d.webGuiEnabled),
    webGuiPort: d.webGuiPort,
    extensions: d.extensions,
    attachedServices,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** Managed database CRUD. Mounted under /databases. */
export const databasesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    // Optional project scoping for the global project switcher (?projectId=).
    const projectId = Number((req.query as { projectId?: string }).projectId);
    const scoped = Number.isInteger(projectId) && projectId > 0 ? projectId : null;
    const isAdminUser = req.user?.isOperator === true;
    // Members see only databases they own or that live in one of their
    // workspaces' projects; `null` means unrestricted (admin).
    const visible = await visibleDatabaseIds(app.db, req.user!);
    if (visible !== null && visible.length === 0) return [];
    const rows = await app.db.query.databases.findMany({
      orderBy: (d, { desc }) => [desc(d.id)],
      with: {
        attachments: {
          with: {
            service: true,
          },
        },
      },
      ...(scoped != null && { where: (d, { eq }) => eq(d.projectId, scoped) }),
    });
    const scopedRows = visible === null ? rows : rows.filter((d) => visible.includes(d.id));
    return scopedRows.map((d) => serialize(d, { isAdmin: isAdminUser }));
  });

  app.post('/', async (req) => {
    const input = createDatabase.parse(req.body);
    // Placing a database in someone else's project would hand them a resource
    // they cannot see and the creator cannot be held to.
    if (input.projectId != null) {
      const project = await app.db.query.projects.findFirst({ where: eq(projects.id, input.projectId) });
      if (!project) throw badRequest('Project not found');
      // Creating a database (and provisioning its volume + credentials) is a
      // write on the workspace: `member` floor, so a viewer seat stays
      // read-only.
      if (project.workspaceId != null) await assertWorkspaceRole(app.db, project.workspaceId, req.user!, 'member');
      else if (!req.user!.isOperator) throw badRequest('Project not found');
    }
    const slug = slugify(input.name);
    const cfg = ENGINES[input.engine];
    if (!cfg) throw badRequest(`Unknown engine: ${input.engine}`);
    const password = randomToken(18);
    const containerName = `nd-db-${slug}`;
    // An attacker-chosen `existingVolume` reaches `docker run -v <name>:<path>`
    // verbatim; anything with a `:` or leading `/` would become a HOST bind
    // mount. Accept managed docker volume names only.
    const existingVolume = input.existingVolume?.trim();
    if (existingVolume && !DOCKER_VOLUME_NAME.test(existingVolume)) {
      throw badRequest('existingVolume must be a docker volume name (letters, digits, dot, dash, underscore)');
    }
    const volumeName = existingVolume || `nd-db-${slug}-data`;
    const version = input.extensions?.includes('pgvector') && input.engine === 'postgres' ? 'vector' : (input.version ?? null);

    // A volume name can only belong to one database row: two rows mounting the
    // same data directory would fight over the engine's lock and (worse) a new
    // row would re-key the other database's credentials out from under it.
    // Check + insert run under the per-volume lock: awaits between them would
    // otherwise let two concurrent creates both pass the check.
    const claimed = await serializeOnVolume(volumeName, async () => {
      const [volumeClash] = await app.db.select().from(databases).where(eq(databases.volumeName, volumeName));
      if (volumeClash) throw badRequest(`Volume "${volumeName}" already belongs to database "${volumeClash.name}"`);

      if (input.reuseExisting) {
        const existing = await app.db.query.databases.findFirst({ where: eq(databases.slug, slug) });
        if (existing) {
          const sameRequest =
            existing.ownerUserId === req.user!.id &&
            existing.engine === input.engine &&
            existing.projectId === (input.projectId ?? null) &&
            existing.version === version;
          if (!sameRequest) throw badRequest('A different database already uses this name');

          try {
            // A reused row whose adoption never completed (failed first attempt
            // left it 'error' with a NULL marker) must not boot the retained
            // volume's stale credentials — same gate the fresh-create path runs.
            if (needsVolumeAdoption(existing)) {
              await adoptRetainedVolume(existing, (line) => app.log.info({ component: 'database' }, line));
            }
            await startDatabase(existing, (line) => app.log.info({ component: 'database' }, line));
            const resumed = {
              ...existing,
              status: 'running' as const,
              internalHost: existing.containerName,
              internalPort: defaultPort(existing.engine),
            };
            await app.db
              .update(databases)
              .set({
                status: resumed.status,
                internalHost: resumed.internalHost,
                internalPort: resumed.internalPort,
                initializedAt: existing.initializedAt ?? new Date(),
              })
              .where(eq(databases.id, existing.id));
            void audit(app.db, req.user!.id, 'database.reuse', existing.name);
            return { kind: 'reused' as const, payload: serialize(resumed, { isAdmin: req.user?.isOperator === true }) };
          } catch (err) {
            await app.db.update(databases).set({ status: 'error' }).where(eq(databases.id, existing.id));
            throw badRequest(`Failed to start database: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      const [created] = await app.db
        .insert(databases)
        .values({
          projectId: input.projectId ?? null,
          // Stamped so the creator keeps access even for a project-less database.
          ownerUserId: req.user!.id,
          name: input.name,
          slug,
          engine: input.engine,
          version,
          status: 'creating',
          containerName,
          volumeName,
          username: cfg.username() ?? null,
          passwordEncrypted: encrypt(password),
          dbName: cfg.dbName() ?? null,
          extensions: input.extensions ?? [],
          webGuiEnabled: input.webGuiEnabled ?? false,
        })
        .returning();
      if (!created) throw badRequest('Could not create database');
      return { kind: 'created' as const, created };
    });
    if (claimed.kind === 'reused') return claimed.payload;
    const created = claimed.created;

    try {
      // The fresh row's password is what apps will receive; a retained volume
      // under this name holds credentials from the database that created it.
      // Re-key (postgres) or refuse loudly (engines without a re-key) so a
      // remount never boots a server the credentials cannot reach.
      if (needsVolumeAdoption(created)) {
        await adoptRetainedVolume(created, (line) => app.log.info({ component: 'database' }, line));
      }
      await startDatabase(created, (line) => app.log.info({ component: 'database' }, line));
      await app.db
        .update(databases)
        .set({ status: 'running', internalHost: containerName, internalPort: defaultPort(input.engine), initializedAt: new Date() })
        .where(eq(databases.id, created.id));
    } catch (err) {
      await app.db.update(databases).set({ status: 'error' }).where(eq(databases.id, created.id));
      throw badRequest(`Failed to start database: ${err instanceof Error ? err.message : err}`);
    }

    const updated = await app.db.query.databases.findFirst({
      where: eq(databases.id, created.id),
      with: { attachments: { with: { service: true } } },
    });
    void audit(app.db, req.user!.id, 'database.create', input.name);
    app.kernel?.events.emit('database.created', {
      databaseId: created.id,
      // The column is nullable (unlinked legacy rows); the event contract wants a number.
      projectId: created.projectId ?? 0,
      name: created.name,
      engine: created.engine,
    });
    return serialize(updated!, { isAdmin: req.user?.isOperator === true });
  });

  app.get('/:id', async (req) => {
    const id = num((req.params as { id: string }).id);
    await loadDatabaseForUser(app.db, id, req.user!);
    const d = await app.db.query.databases.findFirst({
      where: eq(databases.id, id),
      with: { attachments: { with: { service: true } } },
    });
    if (!d) throw notFound('Database not found');
    return serialize(d, { isAdmin: req.user?.isOperator === true });
  });

  // Start Web Studio (Adminer / Redis Commander GUI) for this database.
  // Studio binds a HOST port serving a database GUI, so it stays operator-only
  // even for a workspace admin: publishing on the host is a host-wide resource
  // (same reasoning as lib/hostPort.ts). The port is LOOPBACK-bound (the
  // container is only ever reached through this panel, never directly), and
  // the response hands back a same-origin proxy path plus an HttpOnly,
  // path-scoped cookie so the embedded GUI rides the panel's own auth.
  app.post('/:id/studio', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    const bodyPort = (req.body as { port?: number } | undefined)?.port;
    if (bodyPort !== undefined && (!Number.isInteger(bodyPort) || bodyPort < 1024 || bodyPort > 65535)) {
      throw badRequest('port must be an integer between 1024 and 65535');
    }
    const port = bodyPort ?? (d.webGuiPort || (18000 + (d.id % 1000)));
    await startDatabaseStudio(d, port, (line) => app.log.info({ component: 'database-studio' }, line));
    await app.db.update(databases).set({ webGuiEnabled: true, webGuiPort: port }).where(eq(databases.id, d.id));
    void audit(app.db, req.user!.id, 'database.studio.start', `${d.name} on :${port}`);
    reply.header('set-cookie', studioCookieSetHeader(id, req.protocol === 'https'));
    return { ok: true, port, url: studioProxyPathFor(id) };
  });

  // Stop Web Studio for this database
  app.delete('/:id/studio', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await stopDatabaseStudio(d, (line) => app.log.info({ component: 'database-studio' }, line));
    await app.db.update(databases).set({ webGuiEnabled: false }).where(eq(databases.id, d.id));
    void audit(app.db, req.user!.id, 'database.studio.stop', d.name);
    reply.header('set-cookie', `${studioCookieName(id)}=; Path=/v1/databases/${id}/studio-proxy/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const id = num((req.params as { id: string }).id);
    // Destroying a database is irreversible — resolve access before reading it.
    const target = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, target, req.user!, 'admin');
    const d = await app.db.query.databases.findFirst({
      where: eq(databases.id, id),
      with: {
        attachments: {
          with: { service: true },
        },
      },
    });
    if (!d) throw notFound('Database not found');

    const attachedServices =
      d.attachments
        ?.map((a) => (a.service ? { id: a.service.id, name: a.service.name, slug: a.service.slug } : null))
        .filter((s): s is { id: number; name: string; slug: string } => s != null) ?? [];
    const force = (req.query as { force?: string }).force === 'true';

    // Guard against breaking connected services
    if (attachedServices.length > 0 && !force) {
      const names = attachedServices.map((s) => s.name).join(', ');
      throw badRequest(
        `Cannot delete database "${d.name}": It is locked and actively in use by ${attachedServices.length} service(s) (${names}). Detach these services first or pass ?force=true to override.`,
      );
    }

    await stopDatabase(d, (line) => app.log.info({ component: 'database' }, line));
    // Capture the dump paths BEFORE the transaction deletes the rows.
    const backupRows = await app.db.query.backups.findMany({ where: eq(backups.databaseId, d.id) });
    // Atomic row removal (attachments + backups + the database itself commit
    // together) — a mid-delete failure must never leave live rows pointing at
    // already-destroyed artifacts. The volume is intentionally kept = retained.
    await app.db.transaction(async (tx) => {
      await tx.delete(databaseAttachments).where(eq(databaseAttachments.databaseId, d.id));
      await tx.delete(backups).where(eq(backups.databaseId, d.id));
      await tx.delete(databases).where(eq(databases.id, d.id));
    });
    // Post-commit best-effort cleanup: unlink the dump files (dumps contain DB
    // credentials, plaintext once decrypted). Files are not transactional — a
    // failure here leaves an orphaned dump, which is logged, not silent.
    for (const b of backupRows) {
      try {
        if (existsSync(b.path)) unlinkSync(b.path);
      } catch (err) {
        req.log.warn({ err, path: b.path }, 'failed to unlink backup file after database delete');
      }
    }
    void audit(app.db, req.user!.id, 'database.delete', d.name);
    app.kernel?.events.emit('database.deleted', {
      databaseId: d.id,
      name: d.name,
      volumeRetained: true,
    });
    return { ok: true };
  });

  // Resource limits — recreates the container if running so they take effect.
  app.patch('/:id/limits', async (req) => {
    const d = await loadDatabaseForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'member');
    const input = setLimits.parse(req.body);
    const updateData: { cpuShares?: number; memLimitMb?: number } = {};
    if (input.cpuShares !== undefined) {
      updateData.cpuShares = input.cpuShares ? Math.max(0, input.cpuShares) : 0;
    }
    if (input.memLimitMb !== undefined) {
      updateData.memLimitMb = input.memLimitMb ? Math.max(0, input.memLimitMb) : 0;
    }
    const [updated] = await app.db.update(databases).set(updateData).where(eq(databases.id, d.id)).returning();
    if (updated && updated.status === 'running') {
      await stopDatabase(updated, () => undefined);
      await startDatabase(updated, (line) => app.log.info({ component: 'database' }, line));
    }
    return { cpuShares: updated!.cpuShares, memLimitMb: updated!.memLimitMb };
  });

  app.post('/:id/restart', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'member');
    await restartDatabase(d, (line) => app.log.info({ component: 'database' }, line));
    await app.db.update(databases).set({ status: 'running' }).where(eq(databases.id, d.id));
    void audit(app.db, req.user!.id, 'database.restart', d.name);
    return { ok: true };
  });

  app.post('/:id/stop', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'member');
    await stopDatabase(d, (line) => app.log.info({ component: 'database' }, line));
    await app.db.update(databases).set({ status: 'stopped' }).where(eq(databases.id, d.id));
    void audit(app.db, req.user!.id, 'database.stop', d.name);
    app.kernel?.events.emit('database.stopped', {
      databaseId: d.id,
    });
    return { ok: true };
  });

  app.post('/:id/start', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'member');
    // A row can sit in 'error' with a NULL marker (failed first attempt) —
    // starting it must clear the same retained-volume gate as a create/retry.
    if (needsVolumeAdoption(d)) {
      await adoptRetainedVolume(d, (line) => app.log.info({ component: 'database' }, line));
    }
    await startDatabase(d, (line) => app.log.info({ component: 'database' }, line));
    await app.db
      .update(databases)
      .set({ status: 'running', initializedAt: d.initializedAt ?? new Date() })
      .where(eq(databases.id, d.id));
    void audit(app.db, req.user!.id, 'database.start', d.name);
    app.kernel?.events.emit('database.started', {
      databaseId: d.id,
    });
    return { ok: true };
  });

  app.get('/:id/logs', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    const lines = Number((req.query as { lines?: string }).lines) || 100;
    const logs = await databaseLogs(d, lines);
    return { logs };
  });

  // Credential reveal (password + full URI) — audited.
  //
  // This was instance-operator-only, which is stricter than the published
  // permission matrix and made the workspace model useless for teams: a
  // workspace admin could not read the password of their OWN database. It is
  // now `admin` on the database (operators still qualify, since they resolve as
  // `owner` everywhere) — a `member` or `viewer` still cannot.
  app.get('/:id/credentials', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'admin');
    const cfg = ENGINES[d.engine];
    const password = d.passwordEncrypted ? decrypt(d.passwordEncrypted) : '';
    const connStr = connectionString(d);
    void audit(app.db, req.user!.id, 'database.credentials.reveal', d.name);
    return {
      engine: d.engine,
      username: cfg?.username() ?? d.username,
      password,
      database: cfg?.dbName() ?? d.dbName,
      internalHost: d.internalHost,
      internalPort: d.internalPort,
      connectionString: connStr,
    };
  });
};

// ── Service ↔ database attachments ────────────────────────────────────────
function aliasFor(engine: string): string {
  switch (engine.toLowerCase()) {
    case 'redis':
    case 'valkey':
      return 'REDIS_URL';
    case 'mongo':
    case 'mongodb':
      return 'MONGODB_URI';
    case 'mysql':
    case 'mariadb':
      return 'MYSQL_URL';
    case 'clickhouse':
      return 'CLICKHOUSE_URL';
    case 'meilisearch':
      return 'MEILISEARCH_URL';
    case 'rabbitmq':
      return 'RABBITMQ_URL';
    default:
      return 'DATABASE_URL';
  }
}

/** Attachment management. Mounted under /services. */
export const attachmentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/attachments', async (req) => {
    const id = num((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const rows = await app.db.query.databaseAttachments.findMany({ where: eq(databaseAttachments.serviceId, id) });
    const out = [];
    for (const a of rows) {
      const d = await app.db.query.databases.findFirst({ where: eq(databases.id, a.databaseId) });
      out.push({ id: a.id, databaseId: a.databaseId, envAlias: a.envAlias, database: d ? { name: d.name, engine: d.engine, status: d.status } : null });
    }
    return out;
  });

  app.post('/:id/attachments', async (req) => {
    const id = num((req.params as { id: string }).id);
    // Validates databaseId (positive int) and the env alias charset — an alias
    // like `MY ALIAS` would otherwise be injected verbatim into the service's
    // runtime env and break `docker run --env-file` at deploy time.
    const input = createAttachment.parse(req.body ?? {});
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // Write route → `member` floor (docs/WORKSPACES_RBAC.md): a viewer is
    // read-only. Attaching injects the database's decrypted connection string
    // into the service's runtime env at deploy time.
    await assertServiceRole(app.db, svc, req.user!, 'member');
    // BOTH sides need an access decision. Checking only the service let a
    // member attach ANY database id to a service they own — the deploy
    // pipeline then injects that database's decrypted password and connection
    // string into their container env (engine/pipeline.ts), handing them full
    // read/write access to another tenant's data.
    const d = await loadDatabaseForUser(app.db, input.databaseId, req.user!);
    // Visibility alone is not enough: the attachment ships the database's
    // ADMIN-only password into the service env (the /credentials route sits at
    // `admin` for exactly this reason), so attaching demands the same tier —
    // a viewer-or-member seat on the database's workspace is not consent to
    // hand its password to a container.
    await assertDatabaseRole(app.db, d, req.user!, 'admin');
    const envAlias = input.envAlias ?? aliasFor(d.engine);
    if (input.reuseExisting) {
      const existing = await app.db.query.databaseAttachments.findFirst({
        where: and(eq(databaseAttachments.serviceId, id), eq(databaseAttachments.databaseId, input.databaseId)),
      });
      if (existing) return { id: existing.id, databaseId: existing.databaseId, envAlias: existing.envAlias };
    }
    const [a] = await app.db
      .insert(databaseAttachments)
      .values({ serviceId: id, databaseId: input.databaseId, envAlias })
      .returning()
      .catch((err: unknown) => {
        if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return [] as typeof databaseAttachments.$inferSelect[];
        throw err;
      });
    if (!a) throw badRequest('Already attached');
    return { id: a.id, databaseId: input.databaseId, envAlias };
  });

  app.delete('/:id/attachments/:attId', async (req) => {
    const id = num((req.params as { id: string }).id);
    const attId = num((req.params as { attId: string }).attId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // Detaching breaks the runtime env of a (possibly shared) service — a
    // write, not a read.
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const deleted = await app.db
      .delete(databaseAttachments)
      .where(and(eq(databaseAttachments.id, attId), eq(databaseAttachments.serviceId, id)))
      .returning({ id: databaseAttachments.id });
    if (deleted.length === 0) throw notFound('Attachment not found');
    return { ok: true };
  });
};
