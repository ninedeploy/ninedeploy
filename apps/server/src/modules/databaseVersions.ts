/**
 * N12: the release of a database that has no version, or whose version was
 * named by hand and has not run yet (lib/databaseVersion.ts). Mounted under
 * /databases.
 *
 *   GET /:id/version    what is known about the release such a row runs, and the releases it may be given (viewer)
 *   PUT /:id/version    { version } — name the release BEFORE the server has run on it (admin)
 *
 * Reading follows the database; naming takes `admin`, as changing it does.
 * Nothing touches the data: the row's version is written, only to a row that
 * has none or whose name has not run yet, and never while an upgrade runs.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '@ninedeploy/db';
import { databaseVersionSet } from '@ninedeploy/schemas';
import { assertNoRunningUpgrade } from '../lib/databaseUpgrade.js';
import { legacyVersionStatus, setLegacyVersion } from '../lib/databaseVersion.js';
import { parseId, unprocessable } from '../lib/errors.js';
import { assertDatabaseRole, loadDatabaseForUser } from '../lib/resourceAccess.js';

export const databaseVersionRoutes: FastifyPluginAsync = async (app) => {
  // Resolved per request: the wiring guard mounts this module on a bare Fastify.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    await (app as FastifyInstance & { authenticate: (r: FastifyRequest, p: FastifyReply) => Promise<void> }).authenticate(req, reply);
  });

  const load = async (req: FastifyRequest, role: 'viewer' | 'admin'): Promise<Database> => {
    const d = await loadDatabaseForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertDatabaseRole(app.db, d, req.user!, role);
    return d;
  };

  app.get<{ Params: { id: string } }>('/:id/version', async (req) => {
    const d = await load(req, 'viewer');
    return { databaseId: d.id, ...(await legacyVersionStatus(d)) };
  });

  app.put<{ Params: { id: string } }>('/:id/version', async (req) => {
    const d = await load(req, 'admin');
    const body = databaseVersionSet.safeParse(req.body ?? {});
    if (!body.success) throw unprocessable(body.error.issues[0]!.message);
    // An upgrade carries the versions it restores explicitly; never write under it.
    // A name being tried is not touched either (the library refuses while the row is starting).
    await assertNoRunningUpgrade(app.db, d.id);
    return { databaseId: d.id, ...(await setLegacyVersion(app.db, d, body.data.version, req.user!.id)) };
  });
};
