import { desc, eq } from 'drizzle-orm';
import { notificationChannels, notificationLog } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { notificationChannelCreate, notificationChannelPatch } from '@ninedeploy/schemas';
import { decrypt, encrypt } from '../lib/crypto.js';
import { dispatchChannel } from '../lib/notifier.js';
import { badRequest, notFound, parseId } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

function serialize(ch: typeof notificationChannels.$inferSelect) {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    hasTarget: !!ch.targetEncrypted,
    eventFilter: ch.eventFilter,
    active: ch.active,
    // config_json is opaque to the API; we surface it as-is so the
    // operator's UI can edit it. It's null on channels created
    // before G-18 PR #24.
    configJson: ch.configJson,
    createdAt: ch.createdAt.toISOString(),
  };
}

/** Notification channel management. Mounted under /notifications. Admin-only. */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // System-wide notification config — admin-only under the agreed RBAC model.
  app.addHook('preHandler', app.requireAdmin);

  // ── Channels ──────────────────────────────────────────────────────────
  app.get('/channels', async () => {
    const rows = await app.db.query.notificationChannels.findMany({ orderBy: desc(notificationChannels.id) });
    return rows.map(serialize);
  });

  app.post('/channels', async (req) => {
    const input = notificationChannelCreate.parse(req.body);

    const [ch] = await app.db
      .insert(notificationChannels)
      .values({
        name: input.name,
        type: input.type,
        targetEncrypted: encrypt(input.target),
        eventFilter: input.eventFilter ?? '',
        active: true,
        configJson: input.configJson ?? null,
      })
      .returning();
    void audit(app.db, req.user!.id, 'notification.channel_create', `${ch!.type}:${ch!.name}`);
    return serialize(ch!);
  });

  app.patch('/channels/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = notificationChannelPatch.parse(req.body ?? {});
    // Apply every field the schema accepts — name and target were previously
    // accepted but silently dropped. The target is stored encrypted, exactly
    // like at creation.
    const patch: Partial<typeof notificationChannels.$inferSelect> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.target !== undefined) patch.targetEncrypted = encrypt(input.target);
    if (input.eventFilter !== undefined) patch.eventFilter = input.eventFilter;
    if (input.active !== undefined) patch.active = input.active;
    // Empty string clears the channel's provider-specific config;
    // undefined leaves it untouched.
    if (input.configJson !== undefined) patch.configJson = input.configJson === '' ? null : input.configJson;
    const [ch] = await app.db.update(notificationChannels).set(patch).where(eq(notificationChannels.id, id)).returning();
    if (!ch) throw notFound('Channel not found');
    void audit(app.db, req.user!.id, 'notification.channel_update', `${ch.type}:${ch.name}`);
    return serialize(ch);
  });

  app.delete('/channels/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const [gone] = await app.db.delete(notificationChannels).where(eq(notificationChannels.id, id)).returning();
    if (gone) void audit(app.db, req.user!.id, 'notification.channel_delete', `${gone.type}:${gone.name}`);
    return { ok: true };
  });

  // ── Test a channel ────────────────────────────────────────────────────
  app.post('/channels/:id/test', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const ch = await app.db.query.notificationChannels.findFirst({ where: eq(notificationChannels.id, id) });
    if (!ch) throw notFound('Channel not found');
    const target = decrypt(ch.targetEncrypted);
    const message = '🧪 NineDeploy test notification — your channel is working!';

    try {
      await dispatchChannel(
        ch.type,
        target,
        { id: 0, action: 'notification.test', entity: ch.name, ts: new Date().toISOString(), actorUserId: req.user!.id },
        message,
        { configJson: ch.configJson },
      );
      return { ok: true };
    } catch (err) {
      throw badRequest(`Test failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  // ── Notification log ──────────────────────────────────────────────────
  app.get('/log', async () => {
    const rows = await app.db.query.notificationLog.findMany({ orderBy: desc(notificationLog.ts), limit: 50 });
    return rows.map((l) => ({
      id: l.id,
      channelId: l.channelId,
      event: l.event,
      entity: l.entity,
      status: l.status,
      attempts: l.attempts,
      error: l.error,
      ts: l.ts.toISOString(),
    }));
  });
};
