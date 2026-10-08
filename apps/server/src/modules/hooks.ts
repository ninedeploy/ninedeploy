import { and, eq } from 'drizzle-orm';
import { services, webhooks, type DB } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { webhookCreate } from '@ninedeploy/schemas';
import { decrypt, encrypt, randomToken } from '../lib/crypto.js';
import { parseId, notFound, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { isPing, isPullRequest, isReplayedDelivery, parsePullRequest, parsePush, verifyWebhook } from '../lib/webhooks.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertServiceRole } from '../lib/resourceAccess.js';
import { panelOrigin } from '../lib/panelOrigin.js';
import { handlePullRequest, handlePush, isGithubAppDriven } from '../lib/webhookDispatch.js';

/** Public webhook receiver — auto-deploys on verified provider push & PR events. */
export const hookReceiveRoutes: FastifyPluginAsync = async (app) => {
  // Public endpoint (auth bypassed, verified by HMAC) — cap flood attempts.
  app.post('/:id', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    // Public receiver: leave non-numeric ids as NaN so they 404 ("Unknown
    // webhook") rather than 400 — don't reveal param validation to probers.
    const id = Number((req.params as { id: string }).id);
    // T4-F1 (0.13): a NaN bound into the lookup makes SQLite fail the query —
    // a 500, not the intended 404 — so refuse it before the database.
    if (!Number.isSafeInteger(id) || id <= 0) throw notFound('Unknown webhook');
    const hook = await app.db.query.webhooks.findFirst({ where: eq(webhooks.id, id) });
    if (!hook?.active) throw notFound('Unknown webhook');

    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const secret = decrypt(hook.secretEncrypted);
    const provider = verifyWebhook(req.headers, rawBody, secret);
    if (!provider) throw unauthorized('Invalid webhook signature');

    if (isPing(req.headers, provider)) return { ok: 'pong' };

    // A replayed (captured-then-replayed) delivery must not redeploy an old
    // commit once the SHA dedup has expired. Checked AFTER the HMAC so only
    // authenticated deliveries consume dedup slots. Absent delivery ids fail
    // open (isReplayedDelivery) — the signature remains authoritative.
    // r313: the body is the signed part — dedupe on it too (per service).
    if (isReplayedDelivery(req.headers, provider, { rawBody, scope: hook.serviceId })) {
      return { ok: 'ignored', reason: 'replayed_delivery' };
    }

    // 0.13 coexistence: a service the GitHub App drives (enabled link, live
    // installation) receives the same events through the App receiver
    // (`modules/githubAppHooks.ts`); answering both would deploy twice. A
    // suspended or removed installation lets this hook take over again.
    if (await isGithubAppDriven(app.db, hook.serviceId)) {
      return { ok: 'skipped', reason: 'github_app_linked' };
    }

    // ── Ephemeral PR / MR Preview Deployments ──────────────────────────────────
    if (isPullRequest(req.headers, provider)) {
      const pr = parsePullRequest(req.body, provider, req.headers);
      if (!pr) return { ok: 'ignored', reason: 'not_a_valid_pr' };

      const parent = await app.db.query.services.findFirst({ where: eq(services.id, hook.serviceId) });
      if (!parent) throw notFound('Parent service not found');
      return handlePullRequest(app.db, parent, pr, provider, req.log);
    }

    // ── Standard Push Webhook ──────────────────────────────────────────────────
    const push = parsePush(req.body, provider);
    if (!push) return { ok: 'ignored', reason: 'not_a_push' };
    return handlePush(app.db, hook.serviceId, push, { branch: hook.branch, watchPaths: hook.watchPaths, provider });
  });
};

/** Authed webhook management for a service. Mounted under /services. */
export const webhookMgmtRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/:id/webhooks', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const rows = await app.db.query.webhooks.findMany({ where: eq(webhooks.serviceId, id) });
    const origin = await panelOrigin(app.db);
    return rows.map((w) => ({
      id: w.id,
      branch: w.branch,
      active: w.active,
      watchPaths: w.watchPaths ?? '',
      sourceId: w.sourceId ?? null,
      url: `${origin}/v1/hooks/${w.id}`,
      createdAt: w.createdAt.toISOString(),
    }));
  });

  app.post('/:id/webhooks', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = webhookCreate.parse(req.body ?? {});
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // The returned secret is a STANDING deploy credential: anyone holding it
    // can trigger HMAC-valid deployments forever, without authenticating.
    // Handing that out is not an ordinary config write (member) — it sits at
    // the `admin` tier, like transfer and re-homing. The service's owner and
    // operators still pass; an ordinary member seat no longer does.
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    const branch = input.branch?.trim() || svc.branch;
    const secret = randomToken(24);
    // Inherit the parent service's sourceId so the webhook record matches the
    // credential the deploy pipeline will use (a multi-source instance can now
    // disambiguate which credential backs which webhook — useful in admin
    // diagnostics and any future "re-issue secret under a different token" flow).
    const [w] = await app.db
      .insert(webhooks)
      .values({
        serviceId: id,
        sourceId: svc.sourceId,
        branch,
        watchPaths: input.watchPaths?.trim() || null,
        secretEncrypted: encrypt(secret),
        active: true,
      })
      .returning();
    void audit(app.db, req.user!.id, 'webhook.create', `${svc.name}@${branch}`);
    // The raw secret is returned exactly once.
    return { id: w!.id, branch: w!.branch, active: w!.active, sourceId: w!.sourceId, url: await webhookUrl(app.db, w!.id), secret };
  });

  app.delete('/:id/webhooks/:hookId', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const hookId = parseId((req.params as { hookId: string }).hookId);
    const hookSvc = await loadServiceForUser(app.db, id, req.user!);
    // Same tier as create: revoking (or keeping) a standing deploy credential
    // is an admin decision on the service.
    await assertServiceRole(app.db, hookSvc, req.user!, 'admin');
    const gone = await app.db
      .delete(webhooks)
      .where(and(eq(webhooks.id, hookId), eq(webhooks.serviceId, id)))
      .returning({ id: webhooks.id });
    // r691: another service's webhook id answered 200 although nothing was
    // revoked — an operator could believe a leaked hook secret was dead.
    if (gone.length === 0) throw notFound('Webhook not found');
    void audit(app.db, req.user!.id, 'webhook.delete', `${hookSvc.name}#${hookId}`);
    return { ok: true };
  });
};

async function webhookUrl(db: DB, id: number): Promise<string> {
  return `${await panelOrigin(db)}/v1/hooks/${id}`;
}
