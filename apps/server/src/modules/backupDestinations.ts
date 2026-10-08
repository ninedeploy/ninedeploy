import { eq } from 'drizzle-orm';
import { backupDestinations } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { backupDestinationCreate, backupDestinationObjectsQuery, backupDestinationPatch } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest, HttpError, notFound, parseId } from '../lib/errors.js';
import { s3List, s3Test } from '../lib/s3.js';

/**
 * S3-compatible backup destinations (admin only). The secret key is encrypted
 * at rest; updates may omit it to keep the stored one.
 */
export const backupDestinationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => {
    const rows = await app.db.query.backupDestinations.findMany();
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      endpoint: d.endpoint,
      region: d.region,
      bucket: d.bucket,
      prefix: d.prefix,
      active: d.active,
      createdAt: d.createdAt.toISOString(),
    }));
  });

  app.post('/', async (req) => {
    const input = backupDestinationCreate.parse(req.body ?? {});
    const [row] = await app.db
      .insert(backupDestinations)
      .values({
        name: input.name,
        endpoint: input.endpoint,
        region: input.region,
        bucket: input.bucket,
        prefix: input.prefix,
        accessKeyId: input.accessKeyId,
        secretKeyEncrypted: encrypt(input.secretAccessKey),
        active: true,
      })
      .returning();
    if (!row) throw badRequest('Could not create destination');
    void audit(app.db, req.user!.id, 'backup.destination.create', input.name);
    return { id: row.id };
  });

  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = backupDestinationPatch.parse(req.body ?? {});
    const values: Partial<typeof backupDestinations.$inferInsert> = {};
    for (const key of ['name', 'endpoint', 'region', 'bucket', 'prefix'] as const) {
      const v = input[key];
      if (typeof v === 'string' && v.trim()) values[key] = v.trim();
    }
    if (input.active !== undefined) values.active = input.active;
    if (input.accessKeyId?.trim()) values.accessKeyId = input.accessKeyId.trim();
    if (input.secretAccessKey) {
      values.secretKeyEncrypted = encrypt(input.secretAccessKey);
    }
    const [row] = await app.db
      .update(backupDestinations)
      .set(values)
      .where(eq(backupDestinations.id, id))
      .returning();
    if (!row) throw notFound('Destination not found');
    void audit(app.db, req.user!.id, 'backup.destination.update', row.name);
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const row = await app.db.query.backupDestinations.findFirst({
      where: eq(backupDestinations.id, id),
    });
    if (!row) throw notFound('Destination not found');
    await app.db.delete(backupDestinations).where(eq(backupDestinations.id, id));
    void audit(app.db, req.user!.id, 'backup.destination.delete', `#${id}`);
    return { ok: true };
  });

  // Object listing for the dump-import picker (0.14, DESIGN §3.3). The prefix
  // defaults to the destination's own and must stay inside it — an import
  // only accepts keys under that prefix anyway.
  app.get('/:id/objects', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const query = backupDestinationObjectsQuery.parse(req.query ?? {});
    const row = await app.db.query.backupDestinations.findFirst({ where: eq(backupDestinations.id, id) });
    if (!row) throw notFound('Destination not found');
    const base = row.prefix.replace(/^\/+|\/+$/g, '');
    const prefix = query.prefix ?? (base ? `${base}/` : '');
    if (base && !prefix.startsWith(base)) throw badRequest(`The prefix must start with the destination prefix "${base}"`);
    let objects: Awaited<ReturnType<typeof s3List>>;
    try {
      objects = await s3List(
        {
          endpoint: row.endpoint,
          region: row.region,
          bucket: row.bucket,
          accessKeyId: row.accessKeyId,
          secretAccessKey: decrypt(row.secretKeyEncrypted),
        },
        prefix,
      );
    } catch (err) {
      // The S3 error body is logged, not returned: it can name the access key.
      req.log.warn({ err }, 'backup destination listing failed');
      throw new HttpError(502, 'destination_unreachable', 'The backup destination could not be listed');
    }
    return objects.map((o) => ({ key: o.key, sizeBytes: o.sizeBytes, lastModified: o.lastModified || null }));
  });

  // Connectivity + credentials probe: PUT + DELETE a tiny marker object.
  app.post('/:id/test', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const row = await app.db.query.backupDestinations.findFirst({ where: eq(backupDestinations.id, id) });
    if (!row) throw notFound('Destination not found');
    try {
      await s3Test({
        endpoint: row.endpoint,
        region: row.region,
        bucket: row.bucket,
        accessKeyId: row.accessKeyId,
        secretAccessKey: decrypt(row.secretKeyEncrypted),
      });
    } catch (err) {
      throw badRequest(`Destination unreachable: ${err instanceof Error ? err.message : err}`);
    }
    return { ok: true };
  });
};
