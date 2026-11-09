/**
 * R3: PostgreSQL point-in-time recovery, mounted under /databases.
 *
 *   GET  /:id/pitr                         status, recoverable window, base backups   viewer
 *   PUT  /:id/pitr                         { enabled, retentionDays? }                  admin
 *   POST /:id/pitr/base-backup             take one now (202)                           admin
 *   POST /:id/pitr/recover                 { name, targetTime? } → a NEW database (202)  admin
 *   GET  /:id/pitr/recoveries[/:rid]       recovery history                              viewer
 *
 * `admin` on the database, as for a backup download: the archive holds every
 * row, and a recovery copies them into a database the caller then owns. The
 * new database goes into the source's project, under the same seat rule as
 * `POST /databases`.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pitrRecoveries, projects, type Database } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, HttpError, notFound, parseId as num, unprocessable } from '../lib/errors.js';
import { pitrBusy, pitrStatus, pitrUnavailable, runPitrBaseBackup, setPitr, startPitrRecovery } from '../lib/pitr.js';
import { assertDatabaseRole, assertProjectRole, isWorkspaceMember, loadDatabaseForUser } from '../lib/resourceAccess.js';

const settingsBody = z.object({
  enabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(35).optional(),
}).strict();

const recoverBody = z.object({
  name: z.string().trim().min(1).max(64),
  /** ISO 8601 with a zone; omitted or null: the latest archived point. */
  targetTime: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

function serializeRecovery(r: typeof pitrRecoveries.$inferSelect) {
  return {
    id: r.id,
    sourceDatabaseId: r.sourceDatabaseId,
    databaseId: r.databaseId,
    targetTime: r.targetTime ? r.targetTime.toISOString() : null,
    status: r.status,
    error: r.error,
    baseBackup: r.baseBackup,
    recoveredTo: r.recoveredTo,
    restoreMs: r.restoreMs,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

export const pitrRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  const log = (line: string) => app.log.info({ component: 'pitr' }, line);

  // Reads follow the backups list (anyone who can see the database); writes are database admin.
  const load = async (id: string, user: NonNullable<FastifyRequest['user']>, role: 'viewer' | 'admin'): Promise<Database> => {
    const d = await loadDatabaseForUser(app.db, num(id), user);
    if (role === 'admin') await assertDatabaseRole(app.db, d, user, 'admin');
    return d;
  };

  app.get<{ Params: { id: string } }>('/:id/pitr', async (req) => {
    const d = await load(req.params.id, req.user!, 'viewer');
    return { databaseId: d.id, ...(await pitrStatus(d)) };
  });

  app.put<{ Params: { id: string } }>('/:id/pitr', async (req) => {
    const d = await load(req.params.id, req.user!, 'admin');
    const body = settingsBody.safeParse(req.body ?? {});
    if (!body.success) throw unprocessable(body.error.issues[0]!.message);
    const updated = await setPitr(app.db, d, body.data, req.user!.id, log);
    return { databaseId: d.id, ...(await pitrStatus(updated)) };
  });

  app.post<{ Params: { id: string } }>('/:id/pitr/base-backup', async (req, reply) => {
    const d = await load(req.params.id, req.user!, 'admin');
    const unavailable = pitrUnavailable(d);
    if (unavailable) throw unprocessable(unavailable, 'pitr_unavailable');
    if (!d.pitrEnabled) throw unprocessable('Point-in-time recovery is not enabled for this database.', 'pitr_disabled');
    if (d.status !== 'running') throw conflict('The database must be running to take a base backup');
    if (pitrBusy.prune(d.id)) throw new HttpError(409, 'pitr_busy', 'WAL archive retention is running; try again when it finishes.');
    if (pitrBusy.baseBackup(d.id)) throw new HttpError(409, 'pitr_base_backup_running', 'A base backup of this database is already running.');
    // The outcome lands on the row (pitr_base_backup_at / pitr_last_error) and in the audit log.
    void runPitrBaseBackup(app.db, d, req.user!.id, log).catch(() => undefined);
    void audit(app.db, req.user!.id, 'database.pitr_base_backup', `${d.name}: base backup started`);
    reply.code(202);
    return { started: true };
  });

  app.post<{ Params: { id: string } }>('/:id/pitr/recover', async (req, reply) => {
    const source = await load(req.params.id, req.user!, 'admin');
    const body = recoverBody.safeParse(req.body ?? {});
    if (!body.success) throw unprocessable(body.error.issues[0]!.message);
    // The new database lands in the source's project: the same seat rule as POST /databases.
    if (source.projectId != null) {
      const project = await app.db.query.projects.findFirst({ where: eq(projects.id, source.projectId) });
      if (!project) throw notFound('Project not found');
      if (project.workspaceId != null) {
        if (!req.user!.isOperator && !(await isWorkspaceMember(app.db, project.workspaceId, req.user!))) throw forbidden('Insufficient role for this workspace');
        await assertProjectRole(app.db, project, req.user!, 'member');
      } else if (!req.user!.isOperator) throw forbidden('Only an operator can create a database in this project');
    }
    const targetTime = body.data.targetTime ? new Date(body.data.targetTime) : null;
    const admitted = await startPitrRecovery(app.db, source, { name: body.data.name, targetTime }, req.user!.id, log);
    void audit(app.db, req.user!.id, 'database.create', `${body.data.name} (point-in-time recovery of ${source.name})`);
    reply.code(202);
    return admitted;
  });

  app.get<{ Params: { id: string } }>('/:id/pitr/recoveries', async (req) => {
    const d = await load(req.params.id, req.user!, 'viewer');
    const rows = await app.db.select().from(pitrRecoveries).where(eq(pitrRecoveries.sourceDatabaseId, d.id)).orderBy(desc(pitrRecoveries.id)).limit(50);
    return rows.map(serializeRecovery);
  });

  app.get<{ Params: { id: string; recoveryId: string } }>('/:id/pitr/recoveries/:recoveryId', async (req) => {
    const d = await load(req.params.id, req.user!, 'viewer');
    const row = await app.db.query.pitrRecoveries.findFirst({ where: and(eq(pitrRecoveries.id, num(req.params.recoveryId)), eq(pitrRecoveries.sourceDatabaseId, d.id)) });
    if (!row) throw notFound('Recovery not found');
    return serializeRecovery(row);
  });
};
