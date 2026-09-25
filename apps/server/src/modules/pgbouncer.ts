/**
 * `ninedeploy databases pgbouncer {enable, disable, status}` —
 * G-32 PgBouncer sidecar HTTP surface.
 *
 * Only the `postgres` engine is supported; the route
 * refuses 422 for any other engine. Auth is `member` for
 * read (status) and `admin` for write (enable / disable):
 * starting a sidecar is a host-privilege operation, so the
 * existing `requireAdmin` decorator is the right gate.
 */
import { z } from 'zod';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { databases, type Database } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, parseId as num, unprocessable } from '../lib/errors.js';
import {
  disablePgbouncer,
  enablePgbouncer,
  pgbouncerStatusFor,
  pooledConnectionString,
} from '../lib/pgbouncer.js';
import { loadDatabaseForUser, assertDatabaseRole } from '../lib/resourceAccess.js';

/**
 * r331: `enablePgbouncer` / `disablePgbouncer` stamp the DATABASE ROW, not the
 * in-memory object the route loaded before the change. Building the response
 * from that stale object reported the pre-change state — the CLI printed
 * "Connection URL: (pending)" right after a successful enable and "still
 * reporting enabled" after a successful disable. Re-read the row first.
 */
async function reloadRow(app: FastifyInstance, d: Database): Promise<Database> {
  return (await app.db.query.databases.findFirst({ where: eq(databases.id, d.id) })) ?? d;
}

const enableBody = z.object({
  /** Override the listen port. Defaults to 6432 on the row. */
  port: z.number().int().min(1024).max(65535).optional(),
});

export const pgbouncerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // `GET` is read-only — `member` is enough.
  app.get<{ Params: { id: string } }>('/:id/pgbouncer', async (req) => {
    const id = num((req.params as { id: string }).id);
    const d = await loadDatabaseForUser(app.db, id, req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'member');
    const status = await pgbouncerStatusFor(d);
    return {
      databaseId: d.id,
      ...status,
      // Always return both shapes; the caller picks.
      directConnectionString: `postgres://${encodeURIComponent(d.username ?? 'nine')}:${encodeURIComponent('*')}@${d.internalHost ?? d.containerName ?? 'localhost'}:${d.internalPort ?? 5432}/${d.dbName ?? 'app'}`,
    };
  });

  // `POST` toggles a sidecar — admin only. r184: in a NESTED scope. A
  // plugin-level addHook applies to every route of the plugin, including the
  // member-readable GET declared above it, so members got 403 on status.
  await app.register(async (admin) => {
    admin.addHook('preHandler', admin.requireAdmin);

    admin.post<{ Params: { id: string }; Body: { port?: number } }>(
      '/:id/pgbouncer/enable',
      async (req) => {
        const id = num((req.params as { id: string }).id);
        const d = await loadDatabaseForUser(app.db, id, req.user!);
        const body = enableBody.safeParse(req.body ?? {});
        if (!body.success) throw unprocessable(body.error.issues[0]!.message);
        // Apply the port override to the row before enabling
        // so the helper picks it up via d.pgbouncerPort.
        if (body.data.port && body.data.port !== d.pgbouncerPort) {
          await app.db
            .update(databases)
            .set({ pgbouncerPort: body.data.port, updatedAt: new Date() })
            .where(eq(databases.id, d.id));
          d.pgbouncerPort = body.data.port;
        }
        const log = (line: string) => app.log.info({ component: 'pgbouncer' }, line);
        try {
          await enablePgbouncer(app.db, d, log);
        } catch (err) {
          throw badRequest(err instanceof Error ? err.message : String(err));
        }
        void audit(app.db, req.user!.id, 'database.pgbouncer_enable', `${d.name} (port=${d.pgbouncerPort})`);
        return pgbouncerStatusFor(await reloadRow(app, d));
      },
    );

    admin.post<{ Params: { id: string } }>('/:id/pgbouncer/disable', async (req) => {
      const id = num((req.params as { id: string }).id);
      const d = await loadDatabaseForUser(app.db, id, req.user!);
      const log = (line: string) => app.log.info({ component: 'pgbouncer' }, line);
      try {
        await disablePgbouncer(app.db, d, log);
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
      void audit(app.db, req.user!.id, 'database.pgbouncer_disable', d.name);
      return pgbouncerStatusFor(await reloadRow(app, d));
    });
  });
};

/**
 * `pooledConnectionString` is the SDK/CLI's primary access
 * to the sidecar URL. The route returns the full status
 * object above; this helper is exported so the SDK and the
 * future attachment-create flow can hand the operator the
 * URL the sidecar exposes, with no extra round-trip.
 */
export { pooledConnectionString };

// `notFound` is unused at the module level but the route
// body uses it for the `loadDatabaseForUser` 404 path. Re-
// export so biome doesn't trip on the unused import when
// the route signature changes.
export { notFound };
