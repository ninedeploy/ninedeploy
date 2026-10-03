import { eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { tunnels, type Tunnel } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { createTunnel } from '@ninedeploy/schemas';
import { startTunnel, stopTunnel } from '../engine/tunnel.js';
import { encrypt } from '../lib/crypto.js';
import { badRequest, notFound, parseId } from '../lib/errors.js';
import { slugify } from '../lib/slug.js';

function serialize(t: Tunnel) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    containerName: t.containerName,
    createdAt: t.createdAt.toISOString(),
  };
}

/** Cloudflare Tunnel management. Mounted under /tunnels. Admin-only. */
export const tunnelRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // System-wide tunnel tokens — admin-only under the agreed RBAC model.
  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => {
    const rows = await app.db.query.tunnels.findMany({ orderBy: (t, { desc }) => [desc(t.id)] });
    return rows.map(serialize);
  });

  app.post('/', async (req) => {
    const input = createTunnel.parse(req.body);
    const slug = `${slugify(input.name)}-${Date.now().toString(36).slice(-4)}`;
    const containerName = `nd-tunnel-${slug}`;
    const [created] = await app.db
      .insert(tunnels)
      .values({ name: input.name, slug, tokenEncrypted: encrypt(input.token), status: 'running', containerName })
      .returning();
    if (!created) throw badRequest('Could not create tunnel');
    try {
      await startTunnel(created, (line) => app.log.info({ component: 'tunnel' }, line));
    } catch (err) {
      await app.db.update(tunnels).set({ status: 'error' }).where(eq(tunnels.id, created.id));
      throw badRequest(`Tunnel failed to start: ${err instanceof Error ? err.message : err}`);
    }
    void audit(app.db, req.user!.id, 'tunnel.create', input.name);
    return serialize(created);
  });

  app.delete('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const t = await app.db.query.tunnels.findFirst({ where: eq(tunnels.id, id) });
    if (!t) throw notFound('Tunnel not found');
    await stopTunnel(t);
    await app.db.delete(tunnels).where(eq(tunnels.id, id));
    void audit(app.db, req.user!.id, 'tunnel.delete', t.name);
    return { ok: true };
  });
};
