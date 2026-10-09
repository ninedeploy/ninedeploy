import { existsSync, unlinkSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { backups, databaseAttachments, databases, type DB, projects, servers, serviceTargets, users, type Database } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createAttachment, createDatabase, setLimits } from '@ninedeploy/schemas';
import {
  adoptRetainedVolume,
  volumeExists,
  connectionString,
  defaultPort,
  ENGINES,
  needsVolumeAdoption,
  startDatabase,
  startDatabaseStudio,
  stopDatabase,
  stopDatabaseStudio,
} from '../engine/database.js';
import { decrypt, encrypt, randomToken } from '../lib/crypto.js';
import { disablePgbouncer } from '../lib/pgbouncer.js';
import {
  getPublicAccessRow,
  publicAccessSummaries,
  removePublicAccessSidecar,
  resolvePublicHost,
} from '../lib/publicDatabaseAccess.js';
import { capture } from '../lib/exec.js';
import { serviceBridgeName } from '../lib/serviceBridge.js';
import { deleteRemoteBackupForRetention } from '../lib/backupRemote.js';
import {
  assertServiceRole,
  assertProjectRole,
  assertDatabaseRole,
  isWorkspaceMember,
  loadDatabaseForUser,
  loadServiceForUser,
  visibleDatabaseIds,
} from '../lib/resourceAccess.js';
import { studioCookieEpoch, studioCookieName, studioCookieSetHeader, studioProxyPathFor } from './studioProxy.js';
import { badRequest, conflict, forbidden, HttpError, notFound, parseId as num, unauthorized, unprocessable } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';
// ── 0.16 T6 node databases ──
import { databaseRuntime, isNodeDatabase } from '../lib/databaseRuntime.js';
import { assertNodeDatabaseCapable, nodeDatabaseRuntime, nodeReachability } from '../lib/nodeDatabase.js';
import { nodeVolumeExists } from '../lib/nodeVolumes.js';
import { attachmentHostMismatch, fanoutDatabaseHostRefusal } from '../lib/remoteDatabaseRefusal.js';
// ── end 0.16 T6 ──

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
  opts: {
    isAdmin: boolean;
    publicAccess?: { enabled: boolean; port: number } | null;
    /** 0.16 T6: the node a database runs on (name, last reachability), keyed by server id. */
    nodes?: ReadonlyMap<number, { name: string; reachable: boolean | null }>;
  } = { isAdmin: true },
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
    // 0.16 T6: a node row keeps NULL local names (the rollback marker); the
    // field keeps its meaning — the container (volume) the database runs under.
    containerName: d.containerName ?? d.nodeContainerName ?? null,
    volumeName: d.volumeName ?? d.nodeVolumeName ?? null,
    cpuShares: d.cpuShares,
    cpuLimitMilli: d.cpuLimitMilli,
    memLimitMb: d.memLimitMb,
    webGuiEnabled: Boolean(d.webGuiEnabled),
    webGuiPort: d.webGuiPort,
    extensions: d.extensions,
    attachedServices,
    // 0.14 (M7): `{ enabled, port }` when public access was ever configured.
    publicAccess: opts.publicAccess ?? null,
    // ── 0.16 T6 node databases (additive) ── null for a panel-host database.
    serverId: d.serverId ?? null,
    serverName: d.serverId == null ? null : (opts.nodes?.get(d.serverId)?.name ?? null),
    reachable: d.serverId == null ? null : (opts.nodes?.get(d.serverId)?.reachable ?? null),
    // ── end 0.16 T6 ──
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// ── 0.16 T6 node databases ──
/** The nodes of `rows` (name, last reachability from plugins/nodeDatabases.ts); empty for panel rows. */
async function nodesOf(db: DB, rows: ReadonlyArray<{ serverId?: number | null }>): Promise<Map<number, { name: string; reachable: boolean | null }>> {
  const ids = [...new Set(rows.map((r) => r.serverId).filter((id): id is number => id != null))];
  const out = new Map<number, { name: string; reachable: boolean | null }>();
  for (const id of ids) {
    const row = await db.query.servers.findFirst({ where: eq(servers.id, id) });
    out.set(id, { name: row?.name ?? `#${id}`, reachable: nodeReachability(id)?.reachable ?? null });
  }
  return out;
}

/** Refuse a panel-host-only feature for a node database (design §5.7, §12). */
function refuseOnNode(d: Database, feature: string): void {
  if (isNodeDatabase(d)) {
    throw unprocessable(`${feature} is not available for a database on a node yet; it runs on the panel host only.`, 'remote_database');
  }
}
// ── end 0.16 T6 ──

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
    const publicAccess = await publicAccessSummaries(app.db, scopedRows.map((d) => d.id));
    const nodes = await nodesOf(app.db, scopedRows);
    return scopedRows.map((d) =>
      serialize(d, { isAdmin: isAdminUser, publicAccess: publicAccess.get(d.id) ?? null, nodes }),
    );
  });

  app.post('/', async (req) => {
    const input = createDatabase.parse(req.body);
    // Placing a database in someone else's project would hand them a resource
    // they cannot see and the creator cannot be held to.
    if (input.projectId != null) {
      const project = await app.db.query.projects.findFirst({ where: eq(projects.id, input.projectId) });
      if (!project) throw badRequest('Project not found');
      // Creating a database (and provisioning its volume + credentials) is a
      // write on the project: `member` floor, so a viewer stays read-only.
      // 0.15 (DESIGN §4.1): a seat in the project's workspace is required —
      // guests (grants, no seat) create no databases, as they create no
      // services — and a project grant may then raise that seat
      // (`assertProjectRole`). A guest gets the refusal any non-member gets.
      if (project.workspaceId != null) {
        if (!req.user!.isOperator && !(await isWorkspaceMember(app.db, project.workspaceId, req.user!))) {
          throw forbidden('Insufficient role for this workspace');
        }
        await assertProjectRole(app.db, project, req.user!, 'member');
      } else if (!req.user!.isOperator) throw badRequest('Project not found');
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

    // ── 0.16 T6 node databases (design §5.2, §5.7) ──
    // `serverId` places the database on a node, fixed for its life. The row
    // keeps container_name / volume_name NULL — the marker 0.15 refuses to act
    // on after a rollback (§5.8) — and its real names in node_*.
    if (input.serverId != null) {
      const serverId = input.serverId;
      if (!req.user!.isOperator) {
        throw new HttpError(403, 'node_placement_operator_only', 'Placing a database on a node is operator-only: a node is an instance resource.');
      }
      if (existingVolume) {
        throw unprocessable(
          'A database on a node never adopts an existing volume: omit existingVolume and a fresh volume is created on the node.',
          'node_volume_adoption_refused',
        );
      }
      const node = await app.db.query.servers.findFirst({ where: eq(servers.id, serverId) });
      if (!node) throw notFound(`Server #${serverId} not found`);
      if (node.status !== 'online') {
        throw new HttpError(409, 'server_not_online', `Node "${node.name}" is ${node.status}; a database can be placed only on an online node.`);
      }
      // 422 node_agent_outdated (after `agent.ping` only) for an agent that cannot host databases.
      await assertNodeDatabaseCapable(app.db, serverId);
      const log = (line: string) => app.log.info({ component: 'database', serverId }, line);
      const existing = await app.db.query.databases.findFirst({ where: eq(databases.slug, slug) });
      let row: Database;
      if (existing) {
        // The Hub retry resumes the caller's own row on the same node.
        const sameRequest =
          input.reuseExisting === true &&
          existing.ownerUserId === req.user!.id &&
          existing.engine === input.engine &&
          existing.projectId === (input.projectId ?? null) &&
          existing.version === version &&
          existing.serverId === serverId;
        if (!sameRequest) throw badRequest('A different database already uses this name');
        row = existing;
      } else {
        const nodeVolume = `nd-db-${slug}-data`;
        if (await nodeVolumeExists(app.db, serverId, nodeVolume)) {
          throw new HttpError(
            409,
            'node_volume_exists',
            `Volume ${nodeVolume} already exists on node "${node.name}"; a database on a node never adopts a retained volume. Remove it on the node, or pick another name.`,
          );
        }
        const [created] = await app.db
          .insert(databases)
          .values({
            projectId: input.projectId ?? null,
            ownerUserId: req.user!.id,
            name: input.name,
            slug,
            engine: input.engine,
            version,
            status: 'creating',
            containerName: null,
            volumeName: null,
            serverId,
            nodeContainerName: containerName,
            nodeVolumeName: nodeVolume,
            username: cfg.username() ?? null,
            passwordEncrypted: encrypt(password),
            dbName: cfg.dbName() ?? null,
            extensions: input.extensions ?? [],
            webGuiEnabled: false,
          })
          .returning();
        if (!created) throw badRequest('Could not create database');
        row = created;
      }
      const runtime = nodeDatabaseRuntime(app.db, row);
      try {
        if (needsVolumeAdoption(row)) await runtime.adoptRetainedVolume(log);
        await runtime.start(log);
        await app.db
          .update(databases)
          .set({ status: 'running', internalHost: containerName, internalPort: defaultPort(input.engine), initializedAt: row.initializedAt ?? new Date() })
          .where(eq(databases.id, row.id));
      } catch (err) {
        await app.db.update(databases).set({ status: 'error' }).where(eq(databases.id, row.id));
        if (err instanceof HttpError) throw err;
        throw badRequest(`Failed to start database: ${err instanceof Error ? err.message : err}`);
      }
      const placed = await app.db.query.databases.findFirst({
        where: eq(databases.id, row.id),
        with: { attachments: { with: { service: true } } },
      });
      void audit(app.db, req.user!.id, existing ? 'database.reuse' : 'database.create', input.name, { serverId });
      if (!existing) {
        app.kernel?.events.emit('database.created', { databaseId: row.id, projectId: row.projectId ?? 0, name: row.name, engine: row.engine });
      }
      return serialize(placed!, { isAdmin: req.user?.isOperator === true, nodes: await nodesOf(app.db, [placed!]) });
    }
    // ── end 0.16 T6 ──

    // A volume name can only belong to one database row: two rows mounting the
    // same data directory would fight over the engine's lock and (worse) a new
    // row would re-key the other database's credentials out from under it.
    // Check + insert run under the per-volume lock: awaits between them would
    // otherwise let two concurrent creates both pass the check.
    const claimed = await serializeOnVolume(volumeName, async () => {
      // A deleted database's volume is deliberately retained, and adoption
      // re-keys its credentials onto the NEW row, whose owner can then read
      // everything (r096). Below operator nobody can prove whose data an
      // unclaimed volume is (same rule as serviceVolumes.ts), so:
      //  • `existingVolume` (naming any volume) is operator-only;
      //  • a default name that already exists on the host is operator-only
      //    (checked below, for a NEW claim only).
      if (!req.user!.isOperator && existingVolume) {
        throw forbidden('Adopting an existing volume is operator-only — ask an operator to attach it');
      }

      // F136: the retry resumes the caller's OWN row, which already holds this
      // default volume — so it must run before the new-claim guards below, or
      // the caller's own claim makes every retry collide with itself.
      if (input.reuseExisting) {
        const existing = await app.db.query.databases.findFirst({ where: eq(databases.slug, slug) });
        if (existing) {
          const sameRequest =
            existing.ownerUserId === req.user!.id &&
            existing.engine === input.engine &&
            existing.projectId === (input.projectId ?? null) &&
            existing.version === version &&
            // 0.16 T6: a node row is never resumed by a panel-host request.
            existing.serverId == null;
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
            const publicAccess = (await publicAccessSummaries(app.db, [existing.id])).get(existing.id) ?? null;
            return {
              kind: 'reused' as const,
              payload: serialize(resumed, { isAdmin: req.user?.isOperator === true, publicAccess }),
            };
          } catch (err) {
            await app.db.update(databases).set({ status: 'error' }).where(eq(databases.id, existing.id));
            throw badRequest(`Failed to start database: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      const [volumeClash] = await app.db.select().from(databases).where(eq(databases.volumeName, volumeName));
      if (volumeClash) throw badRequest(`Volume "${volumeName}" already belongs to database "${volumeClash.name}"`);

      // No row claims this volume — but it may still hold someone's data.
      if (!req.user!.isOperator && (await volumeExists(volumeName))) {
        throw forbidden(
          `A retained volume "${volumeName}" already exists for this name — pick another name, or ask an operator to adopt it`,
        );
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
    const publicAccess = (await publicAccessSummaries(app.db, [d.id])).get(d.id) ?? null;
    return serialize(d, { isAdmin: req.user?.isOperator === true, publicAccess, nodes: await nodesOf(app.db, [d]) });
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
    refuseOnNode(d, 'Web Studio'); // 0.16 T6 (design §5.7)
    const bodyPort = (req.body as { port?: number } | undefined)?.port;
    if (bodyPort !== undefined && (!Number.isInteger(bodyPort) || bodyPort < 1024 || bodyPort > 65535)) {
      throw badRequest('port must be an integer between 1024 and 65535');
    }
    const port = bodyPort ?? (d.webGuiPort || (18000 + (d.id % 1000)));
    // r560: the studio cookie is bound to this operator's tokenVersion — load
    // it before starting anything (logout / deactivation then end the cookie).
    const me = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!me) throw unauthorized();
    await startDatabaseStudio(d, port, (line) => app.log.info({ component: 'database-studio' }, line));
    await app.db.update(databases).set({ webGuiEnabled: true, webGuiPort: port }).where(eq(databases.id, d.id));
    void audit(app.db, req.user!.id, 'database.studio.start', `${d.name} on :${port}`);
    reply.header('set-cookie', studioCookieSetHeader(id, me, req.protocol === 'https', undefined, await studioCookieEpoch(app.db)));
    return { ok: true, port, url: studioProxyPathFor(id) };
  });

  // Stop Web Studio for this database
  app.delete('/:id/studio', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    // 0.16 T6: a node database never had a Studio (refused); nothing runs on the panel host for it.
    if (!isNodeDatabase(d)) await stopDatabaseStudio(d, (line) => app.log.info({ component: 'database-studio' }, line));
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

    // r237: `database:before_delete` was declared as the plugin veto point and
    // never called. A handler returning `allowOrAbort: false` stops the delete
    // before anything is torn down.
    const hooks = app.kernel?.hooks;
    if (hooks?.hasListeners('database:before_delete')) {
      const { attachments: _attachments, ...row } = d;
      const verdict = await hooks.call('database:before_delete', { database: row, allowOrAbort: true });
      if (verdict.allowOrAbort === false) {
        throw conflict(`Deleting database "${d.name}" was refused by a plugin${verdict.reason ? `: ${verdict.reason}` : ''}`);
      }
    }

    const dbLog = (line: string) => app.log.info({ component: 'database' }, line);
    // ── 0.16 T6 node databases (design §5.4 "Delete") ──
    // The container and its bridge go on the node; the volume (the data) only
    // with ?purgeVolume=true. Studio, PgBouncer and public access never ran
    // for a node database, so nothing runs on the panel host. An unreachable
    // node keeps the row (502) unless ?force=true, which deletes the record
    // and says what was left running on the node.
    let orphanedOnNode: string | null = null;
    if (isNodeDatabase(d)) {
      const runtime = nodeDatabaseRuntime(app.db, d);
      try {
        await runtime.remove({ purgeVolume: (req.query as { purgeVolume?: string }).purgeVolume === 'true' }, dbLog);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        if (!force) {
          throw new HttpError(
            502,
            'node_unreachable',
            `Could not remove database "${d.name}" from node #${d.serverId}: ${why}. Retry when the node is back, or pass ?force=true to delete the record and leave ${runtime.container} and ${runtime.volume} on the node.`,
          );
        }
        orphanedOnNode = `${runtime.container} (volume ${runtime.volume}, network ${runtime.network}) may still run on node #${d.serverId}: remove it there with docker rm -f ${runtime.container}.`;
      }
    } else {
      await stopDatabase(d, dbLog);
      // r183: the sidecars go with it. Only `nd-db-<slug>` used to be removed:
      // the studio (which holds the credentials) and PgBouncer kept running
      // with the old password, and a later database reusing the slug found
      // `nd-studio-<slug>` "already running" and inherited the stale one.
      await stopDatabaseStudio(d, dbLog);
      await disablePgbouncer(app.db, d, dbLog).catch((err: unknown) =>
        req.log.warn({ err }, 'failed to remove the PgBouncer sidecar after database delete'),
      );
      // 0.14 (M6): the public-access proxy goes before the row transaction (the
      // FK cascade then drops its row). It never throws; a leftover container
      // is an orphan the watchdog removes.
      await removePublicAccessSidecar(app.db, d, dbLog);
    }
    // ── end 0.16 T6 ──
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
      // r646: the off-site copy goes too. Only the local dump used to be
      // removed, so every remote object of a deleted database stayed in the
      // bucket forever with no row left to find (or prune) it by. Resolved
      // against the destination the row RECORDS — never the active one, which
      // may be another bucket. Best-effort: the rows are already gone.
      if (b.remoteKey) {
        try {
          const outcome = await deleteRemoteBackupForRetention(app.db, b);
          if (outcome === 'unknown-destination') {
            req.log.warn({ remoteKey: b.remoteKey }, 'remote backup of a deleted database left in place: its destination is unknown');
          }
        } catch (err) {
          req.log.warn({ err, remoteKey: b.remoteKey }, 'failed to delete remote backup after database delete');
        }
      }
    }
    void audit(app.db, req.user!.id, 'database.delete', d.name);
    app.kernel?.events.emit('database.deleted', {
      databaseId: d.id,
      name: d.name,
      volumeRetained: !(isNodeDatabase(d) && (req.query as { purgeVolume?: string }).purgeVolume === 'true' && orphanedOnNode === null),
    });
    return orphanedOnNode ? { ok: true, note: orphanedOnNode } : { ok: true };
  });

  // Resource limits — recreates the container if running so they take effect.
  app.patch('/:id/limits', async (req) => {
    const d = await loadDatabaseForUser(app.db, num((req.params as { id: string }).id), req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'member');
    const input = setLimits.parse(req.body);
    const updateData: { cpuShares?: number; cpuLimitMilli?: number; memLimitMb?: number } = {};
    if (input.cpuShares !== undefined) {
      updateData.cpuShares = input.cpuShares ? Math.max(0, input.cpuShares) : 0;
    }
    if (input.cpuLimitMilli !== undefined) {
      updateData.cpuLimitMilli = input.cpuLimitMilli ? Math.max(0, input.cpuLimitMilli) : 0;
    }
    if (input.memLimitMb !== undefined) {
      updateData.memLimitMb = input.memLimitMb ? Math.max(0, input.memLimitMb) : 0;
    }
    const [updated] = await app.db.update(databases).set(updateData).where(eq(databases.id, d.id)).returning();
    if (updated) {
      void audit(app.db, req.user!.id, 'database.limits', `${updated.name}: cpu=${updated.cpuShares} cpus=${updated.cpuLimitMilli / 1000} mem=${updated.memLimitMb}MB`);
    }
    if (updated && updated.status === 'running') {
      // 0.16 T6: through the runtime (the engine functions on the panel host, the agent on a node).
      const runtime = databaseRuntime(app.db, updated);
      await runtime.stop(() => undefined);
      try {
        await runtime.start((line) => app.log.info({ component: 'database' }, line));
      } catch (err) {
        // A failed restart must not leave the row claiming `running` with no
        // container — every attached service's healthcheck would then fail
        // against a database the panel insists is up.
        await app.db.update(databases).set({ status: 'error' }).where(eq(databases.id, d.id));
        throw err;
      }
    }
    return { cpuShares: updated!.cpuShares, cpuLimitMilli: updated!.cpuLimitMilli, memLimitMb: updated!.memLimitMb };
  });

  app.post('/:id/restart', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'member');
    await databaseRuntime(app.db, d).restart((line) => app.log.info({ component: 'database' }, line));
    await app.db.update(databases).set({ status: 'running' }).where(eq(databases.id, d.id));
    void audit(app.db, req.user!.id, 'database.restart', d.name);
    return { ok: true };
  });

  app.post('/:id/stop', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'member');
    await databaseRuntime(app.db, d).stop((line) => app.log.info({ component: 'database' }, line));
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
    const runtime = databaseRuntime(app.db, d);
    if (needsVolumeAdoption(d)) {
      await runtime.adoptRetainedVolume((line) => app.log.info({ component: 'database' }, line));
    }
    await runtime.start((line) => app.log.info({ component: 'database' }, line));
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
    // r218: clamped. Any viewer could ask for `?lines=1e9` (or a negative /
    // fractional value docker rejects) and have `docker logs` fill the
    // capture buffer.
    const requested = Math.trunc(Number((req.query as { lines?: string }).lines));
    const lines = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 5000) : 100;
    const logs = await databaseRuntime(app.db, d).logs(lines);
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
      // 0.14 (M7): the URI through the public-access proxy, while it is enabled.
      publicConnectionString: await publicConnectionString(app.db, d, password),
    };
  });
};

/**
 * 0.14 (M7): the connection URI through the public-access sidecar, or null
 * while public access is off. Postgres in terminate mode gets
 * `?sslmode=require` (Traefik's default certificate cannot pass verify-full
 * unless an uploaded certificate covers the host); redis/valkey get the TLS
 * scheme and mongo `tls=true`. Never throws: the credentials reveal must not
 * fail because the public-access table is unreadable.
 */
async function publicConnectionString(db: Parameters<typeof getPublicAccessRow>[0], d: Database, password: string) {
  try {
    const row = await getPublicAccessRow(db, d.id);
    const cfg = ENGINES[d.engine];
    if (!row?.enabled || !cfg) return null;
    const host = await resolvePublicHost(db, row.tlsHostname);
    if (!host) return null;
    const uri = cfg.connectionString(host, row.publicPort, cfg.username() ?? '', password, cfg.dbName());
    if (row.tlsMode !== 'terminate') return uri;
    if (d.engine === 'postgres') return `${uri}?sslmode=require`;
    if (d.engine === 'redis') return uri.replace(/^redis:\/\//, 'rediss://');
    if (d.engine === 'valkey') return uri.replace(/^valkey:\/\//, 'valkeys://');
    if (d.engine === 'mongo') return `${uri}/?tls=true`;
    return uri;
  } catch {
    return null;
  }
}

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
    // ── 0.16 T6 node databases (design §5.5, O2) ── same host only: a
    // database's hostname resolves only where it runs (both NULL = the panel
    // host, every 0.15 attachment). Fan-out targets would run the service on
    // other nodes, which never reach a node database.
    const hostRefusal =
      (await attachmentHostMismatch(app.db, svc, d)) ??
      (d.serverId != null
        ? await fanoutDatabaseHostRefusal(app.db, { ...svc, id }, (await app.db.query.serviceTargets.findMany({ where: eq(serviceTargets.serviceId, id) })).map((t) => t.serverId), d)
        : null);
    if (hostRefusal) throw hostRefusal;
    // ── end 0.16 T6 ──
    const envAlias = input.envAlias ?? aliasFor(d.engine);
    if (input.reuseExisting) {
      const existing = await app.db.query.databaseAttachments.findFirst({
        where: and(eq(databaseAttachments.serviceId, id), eq(databaseAttachments.databaseId, input.databaseId)),
      });
      if (existing) return { id: existing.id, databaseId: existing.databaseId, envAlias: existing.envAlias };
    }
    // F138: the deploy pipeline injects `env[envAlias] = connectionString(d)`
    // per attachment, last row wins — a second database under an alias the
    // service already uses (the per-engine default, e.g. DATABASE_URL) would
    // silently repoint the app at the newer database on its next deploy.
    const aliasOwner = await app.db.query.databaseAttachments.findFirst({
      where: and(eq(databaseAttachments.serviceId, id), eq(databaseAttachments.envAlias, envAlias)),
    });
    if (aliasOwner && aliasOwner.databaseId !== input.databaseId) {
      throw conflict(`${envAlias} is already injected by another attached database — choose a different env alias`);
    }
    const [a] = await app.db
      .insert(databaseAttachments)
      .values({ serviceId: id, databaseId: input.databaseId, envAlias })
      .returning()
      .catch((err: unknown) => {
        // F137: drizzle wraps the driver error (DrizzleQueryError, "Failed
        // query: …"); the SQLite UNIQUE text lives on `cause`.
        const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
        if ([err, cause].some((e) => e instanceof Error && /UNIQUE constraint/.test(e.message))) {
          return [] as typeof databaseAttachments.$inferSelect[];
        }
        throw err;
      });
    if (!a) throw badRequest('Already attached');
    void audit(app.db, req.user!.id, 'database.attach', `${d.name} → ${svc.name}`);
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
      .returning({ id: databaseAttachments.id, databaseId: databaseAttachments.databaseId });
    if (deleted.length === 0) throw notFound('Attachment not found');
    // F890: the attachment is what put the database on the service's bridge
    // (attachDatabaseToServiceBridges) — take it off, or the network path
    // outlives the attachment, and (with no row left for F843's delete-time
    // disconnect) the service, reaching whoever takes the slug next.
    // Best-effort, like F843: the row is gone either way.
    const detached = await app.db.query.databases
      .findFirst({ where: eq(databases.id, deleted[0]!.databaseId), columns: { containerName: true, serverId: true, slug: true, nodeContainerName: true } })
      .catch(() => undefined);
    // ── 0.16 T6 node databases (O7) ── the service's container leaves the database's bridge on the node.
    if (detached?.serverId != null && svc.runtimeId && svc.serverId === detached.serverId) {
      await nodeDatabaseRuntime(app.db, { ...(detached as Database), id: deleted[0]!.databaseId }).disconnect(svc.runtimeId);
    }
    // ── end 0.16 T6 ──
    if (detached?.containerName) {
      const container = detached.containerName;
      await capture('docker', ['network', 'disconnect', serviceBridgeName(svc.slug), container]).catch((err: unknown) =>
        req.log.warn({ err, container }, 'could not disconnect database from the service bridge'),
      );
    }
    void audit(app.db, req.user!.id, 'database.detach', `${svc.name}#${attId}`);
    return { ok: true };
  });
};
