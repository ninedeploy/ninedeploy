/**
 * `ninedeploy logs search` — G-16 cluster log search (HTTP
 * surface). The search itself lives in
 * `lib/logSearch.ts`; this module is a thin route that
 * parses the query string, hands off to the helper, and
 * translates `unsupported: true` into a 501.
 *
 * Auth: `member` (read access). The search round-trips to
 * a remote log host (Loki); the egress guard is
 * intentionally NOT applied because the operator's log
 * host is the canonical destination of the log drain
 * itself.
 */
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { searchLogs } from '../lib/logSearch.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';
import { badRequest, notFound } from '../lib/errors.js';

const searchBody = z.object({
  query: z.string().min(1).max(500),
  serviceId: z.number().int().positive().optional(),
  /** Minutes back from now. Default 15. */
  sinceMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  drainId: z.number().int().positive().optional(),
});

export const logSearchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // `POST` rather than `GET`: the query is the search text
  // (a free-form string the operator types), and
  // `Authorization: Bearer <token>` URLs are visible in
  // proxy logs. The body is a small object; the response
  // is the lines array.
  app.post('/search', async (req) => {
    const body = searchBody.safeParse(req.body);
    if (!body.success) {
      throw badRequest(body.error.issues[0]!.message);
    }
    // A cluster-wide Loki query has no tenant boundary to apply, so it is an
    // instance-operator operation. A member may search only after narrowing
    // to one service they can access.
    if (body.data.serviceId === undefined && !req.user!.isOperator) {
      throw badRequest('Cluster-wide log search requires operator access');
    }
    // When the caller narrows to one service, it must be visible with at
    // least `member`. The shared helper covers workspace/operator rules.
    if (body.data.serviceId !== undefined) {
      const svc = await loadServiceForUser(app.db, body.data.serviceId, req.user!);
      await assertServiceRole(app.db, svc, req.user!, 'member');
    }
    const since = body.data.sinceMinutes !== undefined
      ? new Date(Date.now() - body.data.sinceMinutes * 60_000)
      : undefined;
    let result: Awaited<ReturnType<typeof searchLogs>>;
    try {
      result = await searchLogs(app.db, {
        query: body.data.query,
        serviceId: body.data.serviceId,
        since,
        limit: body.data.limit,
        drainId: body.data.drainId,
        // r287: a non-operator may only use enabled drains that are global or
        // bound to the service they searched (serviceId is mandatory for them).
        restrictToServiceId: req.user!.isOperator ? undefined : body.data.serviceId,
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('No enabled Loki drain')) {
        throw notFound(err.message);
      }
      throw err;
    }
    if (result.unsupported) {
      // The drain is wired but doesn't speak Loki; the
      // operator should add a Loki drain to the pipeline
      // (the easiest path is to add a Vector tap that
      // forwards to Loki).
      throw badRequest(
        `Drain "${result.drain.name}" (type=${result.drain.type}) does not support search; configure a Loki drain alongside it.`,
      );
    }
    return result;
  });
};
