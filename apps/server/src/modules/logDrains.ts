import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { logDrains, logDrainBatches, logDrainCursors, services } from '@ninedeploy/db';
import { logQueueStatus } from '../engine/logShipper.js';
import { logDrainCreate, logDrainUpdate } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { notFound, unprocessable, parseId as num } from '../lib/errors.js';
import { testLogDrainConnection } from '../engine/logDrainManager.js';
import { extraDrainUrlProblem, isExtraDrainType } from '../engine/logDrainTargets.js';

/**
 * F601: the only transport (`guardedFetch`) speaks http(s) and refuses every
 * other scheme, so a `syslog://` or scheme-less URL would be stored, shown as
 * enabled and then fail on every shipper tick. Refuse it at save time.
 */
function assertDeliverableUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw unprocessable('Drain URL must be an absolute http:// or https:// URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw unprocessable(`Drain URL must use http:// or https:// (logs are delivered over HTTP), not ${parsed.protocol}//`);
  }
}

/** G3.4: a target that reads its index, dataset or log stream from the URL must find it there. */
function assertUrlFitsType(type: string, url: string): void {
  if (!isExtraDrainType(type)) return;
  const problem = extraDrainUrlProblem(type, url);
  if (problem) throw unprocessable(problem);
}

export const logDrainRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  // F600: a dangling serviceId used to reach the INSERT/UPDATE and surface the
  // raw foreign-key failure as a 500.
  const assertServiceExists = async (serviceId: number): Promise<void> => {
    const [svc] = await app.db.select({ id: services.id }).from(services).where(eq(services.id, serviceId));
    if (!svc) throw notFound('Service not found');
  };


  const loadDrain = async (raw: string) => {
    const id = num(raw);
    const row = await app.db.query.logDrains.findFirst({ where: eq(logDrains.id, id) });
    if (!row) throw notFound('Log drain not found');
    return row;
  };
  app.get<{ Params: { id: string } }>('/:id/queue', { preHandler: [app.requireOperator] }, async (req) => {
    return logQueueStatus(app.db, await loadDrain(req.params.id));
  });
  app.post<{ Params: { id: string } }>('/:id/queue/retry', { preHandler: [app.requireOperator] }, async (req) => {
    const drain = await loadDrain(req.params.id);
    await app.db.update(logDrainBatches).set({ nextAttemptAt: new Date() }).where(eq(logDrainBatches.drainId, drain.id));
    void audit(app.db, req.user!.id, 'log_drain.queue_retry', 'Requested queued log retry for drain #' + drain.id);
    return logQueueStatus(app.db, drain);
  });
  app.delete<{ Params: { id: string } }>('/:id/queue', { preHandler: [app.requireOperator] }, async (req) => {
    const drain = await loadDrain(req.params.id);
    const discarded = await app.db.transaction(async (tx) => {
      const rows = await tx.delete(logDrainBatches).where(eq(logDrainBatches.drainId, drain.id)).returning({ id: logDrainBatches.id });
      await tx.update(logDrainCursors).set({ pausedReason: null }).where(eq(logDrainCursors.drainId, drain.id));
      return rows.length;
    });
    void audit(app.db, req.user!.id, 'log_drain.queue_discarded', 'Discarded ' + discarded + ' queued batches for drain #' + drain.id);
    return { discardedBatches: discarded };
  });

  // List log drains (optionally filtered by serviceId)
  app.get('/', async (req) => {
    const { serviceId } = req.query as { serviceId?: string };
    const query = app.db
      .select({
        id: logDrains.id,
        name: logDrains.name,
        type: logDrains.type,
        url: logDrains.url,
        serviceId: logDrains.serviceId,
        serviceName: services.name,
        enabled: logDrains.enabled,
        format: logDrains.format,
        headersJson: logDrains.headersJson,
        apiKeyEncrypted: logDrains.apiKeyEncrypted,
        createdAt: logDrains.createdAt,
        updatedAt: logDrains.updatedAt,
      })
      .from(logDrains)
      .leftJoin(services, eq(logDrains.serviceId, services.id));

    const rows = serviceId !== undefined
      ? await query.where(eq(logDrains.serviceId, parseInt(serviceId, 10)))
      : await query;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      url: r.url,
      serviceId: r.serviceId,
      serviceName: r.serviceName,
      enabled: Boolean(r.enabled),
      format: r.format,
      headers: r.headersJson ? JSON.parse(r.headersJson) : undefined,
      hasApiKey: Boolean(r.apiKeyEncrypted),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });

  // Get a single log drain by id
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    const [row] = await app.db
      .select({
        id: logDrains.id,
        name: logDrains.name,
        type: logDrains.type,
        url: logDrains.url,
        serviceId: logDrains.serviceId,
        serviceName: services.name,
        enabled: logDrains.enabled,
        format: logDrains.format,
        headersJson: logDrains.headersJson,
        apiKeyEncrypted: logDrains.apiKeyEncrypted,
        createdAt: logDrains.createdAt,
        updatedAt: logDrains.updatedAt,
      })
      .from(logDrains)
      .leftJoin(services, eq(logDrains.serviceId, services.id))
      .where(eq(logDrains.id, numId));

    if (!row) throw notFound('Log drain not found');

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      url: row.url,
      serviceId: row.serviceId,
      serviceName: row.serviceName,
      enabled: Boolean(row.enabled),
      format: row.format,
      headers: row.headersJson ? JSON.parse(row.headersJson) : undefined,
      hasApiKey: Boolean(row.apiKeyEncrypted),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  // Create a log drain
  app.post('/', async (req, reply) => {
    const parsed = logDrainCreate.safeParse(req.body);
    if (!parsed.success) {
      throw unprocessable(parsed.error.issues[0]!.message);
    }

    const { name, type, url, apiKey, serviceId, enabled = true, format = 'json', headers } = parsed.data;
    assertDeliverableUrl(url);
    assertUrlFitsType(type, url);
    if (serviceId != null) await assertServiceExists(serviceId);

    let apiKeyEncrypted: string | null = null;
    if (apiKey) {
      apiKeyEncrypted = encrypt(apiKey);
    }

    const [created] = await app.db
      .insert(logDrains)
      .values({
        name,
        type,
        url,
        apiKeyEncrypted,
        serviceId: serviceId ?? null,
        enabled,
        format,
        headersJson: headers ? JSON.stringify(headers) : null,
      })
      .returning();

    void audit(app.db, req.user!.id, 'log_drain.created', `Created ${type} log drain "${name}"`);

    reply.status(201);
    return {
      id: created!.id,
      name: created!.name,
      type: created!.type,
      url: created!.url,
      serviceId: created!.serviceId,
      enabled: Boolean(created!.enabled),
      format: created!.format,
      headers: headers ?? undefined,
      hasApiKey: Boolean(apiKeyEncrypted),
      createdAt: created!.createdAt.toISOString(),
      updatedAt: created!.updatedAt.toISOString(),
    };
  });

  // Update a log drain
  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    const parsed = logDrainUpdate.safeParse(req.body);
    if (!parsed.success) {
      throw unprocessable(parsed.error.issues[0]!.message);
    }

    const [existing] = await app.db.select().from(logDrains).where(eq(logDrains.id, numId));
    if (!existing) throw notFound('Log drain not found');
    if (parsed.data.url !== undefined) assertDeliverableUrl(parsed.data.url);
    if (parsed.data.url !== undefined || parsed.data.type !== undefined) assertUrlFitsType(parsed.data.type ?? existing.type, parsed.data.url ?? existing.url);
    if (parsed.data.serviceId != null) await assertServiceExists(parsed.data.serviceId);

    const patch: Partial<typeof logDrains.$inferInsert> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.type !== undefined) patch.type = parsed.data.type;
    if (parsed.data.url !== undefined) patch.url = parsed.data.url;
    if (parsed.data.serviceId !== undefined) patch.serviceId = parsed.data.serviceId;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.format !== undefined) patch.format = parsed.data.format;
    if (parsed.data.headers !== undefined) patch.headersJson = JSON.stringify(parsed.data.headers);
    if (parsed.data.apiKey !== undefined) patch.apiKeyEncrypted = parsed.data.apiKey ? encrypt(parsed.data.apiKey) : null;

    const [updated] = await app.db
      .update(logDrains)
      .set(patch)
      .where(eq(logDrains.id, numId))
      .returning();

    void audit(app.db, req.user!.id, 'log_drain.updated', `Updated log drain "${updated!.name}"`);

    return {
      id: updated!.id,
      name: updated!.name,
      type: updated!.type,
      url: updated!.url,
      serviceId: updated!.serviceId,
      enabled: Boolean(updated!.enabled),
      format: updated!.format,
      headers: updated!.headersJson ? JSON.parse(updated!.headersJson) : undefined,
      hasApiKey: Boolean(updated!.apiKeyEncrypted),
      createdAt: updated!.createdAt.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    };
  });

  // Delete a log drain
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    const [existing] = await app.db.select().from(logDrains).where(eq(logDrains.id, numId));
    if (!existing) throw notFound('Log drain not found');

    await app.db.delete(logDrains).where(eq(logDrains.id, numId));
    void audit(app.db, req.user!.id, 'log_drain.deleted', `Deleted log drain "${existing.name}"`);
    return { ok: true };
  });

  // Test connection to destination
  app.post('/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const numId = parseInt(id, 10);
    const [existing] = await app.db.select().from(logDrains).where(eq(logDrains.id, numId));
    if (!existing) throw notFound('Log drain not found');

    let apiKey: string | null = null;
    if (existing.apiKeyEncrypted) {
      apiKey = decrypt(existing.apiKeyEncrypted);
    }

    const result = await testLogDrainConnection({
      url: existing.url,
      type: existing.type,
      format: existing.format,
      apiKey,
      headers: existing.headersJson ? JSON.parse(existing.headersJson) : null,
    });

    void audit(app.db, req.user!.id, 'log_drain.tested', `Tested log drain "${existing.name}": ${result.ok ? 'OK' : 'FAILED'}`);
    return result;
  });
};
