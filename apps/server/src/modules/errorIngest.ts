import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { errorEvents, errorIssues, services, type ErrorIssue } from '@ninedeploy/db';
import { errorIssuePatch, type ErrorEventView, type ErrorIngestView, type ErrorIssueView } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { notFound, parseId } from '../lib/errors.js';
import {
  MAX_INGEST_BYTES,
  alertDecision,
  decodeBody,
  ingestAllowed,
  ingestKeyInfo,
  ingestKeyMatches,
  parseEnvelope,
  recordEvent,
  removeIngestKey,
  rotateIngestKey,
  sentryKeyFrom,
} from '../lib/errorIngest.js';
import { panelOrigin } from '../lib/panelOrigin.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';

/**
 * G5.4 the Sentry ingest endpoints, outside /v1 where SDKs expect them:
 * `POST /api/:serviceId/envelope/` and `POST /api/:serviceId/store/`.
 * Public, authenticated by the service's DSN key; browser SDKs post
 * cross-origin, so the answers allow any origin (they carry no data).
 */
export const errorIngestPublicRoutes: FastifyPluginAsync = async (app) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_INGEST_BYTES }, (_req, body, done) => done(null, body));

  // Browser SDKs send `text/plain` with `?sentry_key=`, a request that needs no preflight.
  const cors = (reply: FastifyReply) =>
    reply.header('access-control-allow-origin', '*').header('access-control-expose-headers', 'x-sentry-rate-limits, retry-after');

  const refuse = (reply: FastifyReply, status: number, detail: string) => cors(reply).code(status).send({ detail });

  const ingest = (kind: 'envelope' | 'store') => async (req: FastifyRequest, reply: FastifyReply) => {
    const serviceId = Number((req.params as { serviceId: string }).serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) return refuse(reply, 404, 'unknown project');
    let events: Array<Record<string, unknown>>;
    let dsn: string | undefined;
    try {
      const raw = decodeBody(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.headers['content-encoding'] as string | undefined);
      if (kind === 'envelope') ({ events, dsn } = parseEnvelope(raw));
      else {
        const one = JSON.parse(raw.toString('utf8')) as unknown;
        events = one && typeof one === 'object' && !Array.isArray(one) ? [one as Record<string, unknown>] : [];
      }
    } catch {
      return refuse(reply, 400, 'invalid payload');
    }
    const key = sentryKeyFrom(req.headers['x-sentry-auth'] as string | undefined, (req.query as { sentry_key?: string }).sentry_key, dsn);
    if (!(await ingestKeyMatches(app.db, serviceId, key))) return refuse(reply, 401, 'invalid key');
    const svc = await app.db.query.services.findFirst({ where: eq(services.id, serviceId) });
    if (!svc) return refuse(reply, 404, 'unknown project');
    let firstId: string | null = null;
    for (const event of events.slice(0, 10)) {
      if (!ingestAllowed(serviceId)) {
        return cors(reply).code(429).header('retry-after', '60').header('x-sentry-rate-limits', '60:error:project').send({ detail: 'rate limited' });
      }
      const { issue, isNew, regressed } = await recordEvent(app.db, serviceId, event);
      firstId ??= typeof event['event_id'] === 'string' ? event['event_id'] : null;
      // New and reopened issues reach the channels that receive alerts, within
      // a per-service hourly budget. The title is the sender's text (a browser
      // DSN is public), so the alert names only the service and issue number.
      if (isNew || regressed) {
        const decision = alertDecision(serviceId);
        if (decision === 'alert') {
          void audit(app.db, null, isNew ? 'alert.error_new' : 'alert.error_regressed', `${svc.name}: ${isNew ? 'new' : 'reopened'} error issue #${issue.id}`, { serviceId, issueId: issue.id });
        } else if (decision === 'burst') {
          void audit(app.db, null, 'alert.error_burst', `${svc.name}: more new error issues this hour; alerts paused until it ends`, { serviceId });
        }
      }
    }
    return cors(reply).send({ id: firstId });
  };

  // SDKs build `<dsn host>/api/<project>/envelope/`, always with the slash.
  for (const kind of ['envelope', 'store'] as const) {
    for (const url of [`/api/:serviceId/${kind}/`]) {
      // Per client IP, before the body is decompressed; the per-service window is in ingestAllowed().
      app.post(url, { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, ingest(kind));
    }
  }
};

const issueView = (i: ErrorIssue): ErrorIssueView => ({
  id: i.id,
  title: i.title,
  culprit: i.culprit,
  level: i.level,
  status: i.status,
  count: i.count,
  firstSeen: i.firstSeen.toISOString(),
  lastSeen: i.lastSeen.toISOString(),
  firstRelease: i.firstRelease,
  firstDeploymentId: i.firstDeploymentId,
  lastDeploymentId: i.lastDeploymentId,
});

/** Issues, events and the DSN of a service, under /v1/services. */
export const serviceErrorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/errors', async (req): Promise<ErrorIssueView[]> => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    // Titles are exception messages, which can carry user data: members and up.
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const status = (req.query as { status?: string }).status;
    const rows = await app.db
      .select()
      .from(errorIssues)
      .where(and(eq(errorIssues.serviceId, svc.id), status === 'unresolved' || status === 'resolved' || status === 'ignored' ? eq(errorIssues.status, status) : undefined))
      .orderBy(desc(errorIssues.lastSeen))
      .limit(200);
    return rows.map(issueView);
  });

  app.get('/:id/errors/:issueId', async (req): Promise<{ issue: ErrorIssueView; events: ErrorEventView[] }> => {
    const p = req.params as { id: string; issueId: string };
    const svc = await loadServiceForUser(app.db, parseId(p.id), req.user!);
    // Payloads may carry request headers and user data, as logs can: members and up.
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const issue = await app.db.query.errorIssues.findFirst({ where: and(eq(errorIssues.id, parseId(p.issueId)), eq(errorIssues.serviceId, svc.id)) });
    if (!issue) throw notFound('Issue not found');
    const events = await app.db.select().from(errorEvents).where(eq(errorEvents.issueId, issue.id)).orderBy(desc(errorEvents.id)).limit(20);
    return {
      issue: issueView(issue),
      events: events.map((e) => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(e.payload);
        } catch {
          payload = null;
        }
        return { id: e.id, eventId: e.eventId, release: e.release, environment: e.environment, deploymentId: e.deploymentId, receivedAt: e.receivedAt.toISOString(), payload };
      }),
    };
  });

  app.patch('/:id/errors/:issueId', async (req): Promise<ErrorIssueView> => {
    const p = req.params as { id: string; issueId: string };
    const svc = await loadServiceForUser(app.db, parseId(p.id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const { status } = errorIssuePatch.parse(req.body ?? {});
    const [row] = await app.db
      .update(errorIssues)
      .set({ status })
      .where(and(eq(errorIssues.id, parseId(p.issueId)), eq(errorIssues.serviceId, svc.id)))
      .returning();
    if (!row) throw notFound('Issue not found');
    void audit(app.db, req.user!.id, 'error_issue.status', `${svc.name}: ${row.title} → ${status}`.slice(0, 300), { serviceId: svc.id, issueId: row.id });
    return issueView(row);
  });

  app.get('/:id/error-ingest', async (req): Promise<ErrorIngestView> => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    const info = await ingestKeyInfo(app.db, svc.id);
    return { enabled: !!info, createdAt: info?.createdAt ?? null };
  });

  // Creates the DSN, or replaces it (the old key stops working).
  app.post('/:id/error-ingest', async (req): Promise<ErrorIngestView> => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    const key = await rotateIngestKey(app.db, svc.id);
    const origin = new URL(await panelOrigin(app.db));
    void audit(app.db, req.user!.id, 'error_ingest.key', svc.name, { serviceId: svc.id });
    const info = await ingestKeyInfo(app.db, svc.id);
    return { enabled: true, createdAt: info?.createdAt ?? null, dsn: `${origin.protocol}//${key}@${origin.host}/${svc.id}` };
  });

  app.delete('/:id/error-ingest', async (req): Promise<ErrorIngestView> => {
    const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await removeIngestKey(app.db, svc.id);
    void audit(app.db, req.user!.id, 'error_ingest.removed', svc.name, { serviceId: svc.id });
    return { enabled: false, createdAt: null };
  });
};
