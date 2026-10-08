import { publicAccessPut } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { badRequest, HttpError, parseId } from '../lib/errors.js';
import {
  applyPublicAccess,
  disablePublicAccess,
  isApplyFailure,
  publicAccessStatus,
} from '../lib/publicDatabaseAccess.js';
import { assertDatabaseRole, loadDatabaseForUser } from '../lib/resourceAccess.js';

/**
 * Public database access (0.14): `GET|PUT|DELETE /v1/databases/:id/public-access`.
 * A per-database Traefik TCP sidecar (`nd-dbpub-<slug>`) publishing one host
 * port behind a required IP allow-list (`lib/publicDatabaseAccess.ts`).
 *
 * Reading follows the database at `admin` (the response names the port and
 * the allow-list, which is as sensitive as the credentials route). Changing it
 * is operator-only: it spends a host-wide port and puts the database's root
 * credentials within reach of the internet — the same precedent as Studio,
 * the other route that binds a host port for a database.
 *
 * Audit meta records the port, the entry count and the TLS mode, never the
 * allow-list contents. Design: DESIGN.md §1.2.
 */
export const databasePublicAccessRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/public-access', async (req) => {
    const d = await loadDatabaseForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertDatabaseRole(app.db, d, req.user!, 'admin');
    return publicAccessStatus(app.db, d);
  });

  app.put('/:id/public-access', { preHandler: app.requireOperator }, async (req) => {
    const d = await loadDatabaseForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    const parsed = publicAccessPut.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid public access settings');
    }
    const input = parsed.data;
    const log = (line: string) => req.log.info({ component: 'public-db-access' }, line);
    const meta = { databaseId: d.id, port: input.port, entries: input.ipAllowlist.length, tlsMode: input.tlsMode };
    let result: Awaited<ReturnType<typeof applyPublicAccess>>;
    try {
      result = await applyPublicAccess(
        app.db,
        d,
        { port: input.port, ipAllowlist: input.ipAllowlist, tlsMode: input.tlsMode, tlsHostname: input.tlsHostname ?? null },
        { userId: req.user!.id, log },
      );
    } catch (err) {
      // Validation refusals (400/409/422 before anything changed) are the
      // caller's mistake; only a failed apply is worth a trail.
      if (isApplyFailure(err)) {
        void audit(app.db, req.user!.id, 'database.public_access.apply_failed', d.name, {
          ...meta,
          error: err instanceof Error ? err.message.slice(0, 500) : String(err),
        });
      }
      if (err instanceof HttpError) throw err;
      throw badRequest(err instanceof Error ? err.message : String(err), 'public_access_failed');
    }
    const action = result.previous?.enabled ? 'database.public_access.update' : 'database.public_access.enable';
    void audit(app.db, req.user!.id, action, d.name, { ...meta, entries: result.row.ipAllowlist.length, mode: result.mode });
    return publicAccessStatus(app.db, d);
  });

  app.delete('/:id/public-access', { preHandler: app.requireOperator }, async (req) => {
    const d = await loadDatabaseForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    const log = (line: string) => req.log.info({ component: 'public-db-access' }, line);
    const previous = await disablePublicAccess(app.db, d, log);
    if (previous) {
      void audit(app.db, req.user!.id, 'database.public_access.disable', d.name, {
        databaseId: d.id,
        port: previous.publicPort,
        wasEnabled: previous.enabled,
      });
    }
    return { ok: true };
  });
};
