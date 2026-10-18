import { and, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { hostIps, services } from '@ninedeploy/db';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { listHostAddresses } from '../lib/hostAddresses.js';
import { hostIpInventory, normalizeHostIp, primaryHostIp } from '../lib/hostIps.js';

const patchBody = z
  .object({
    label: z.string().trim().max(64).nullable().optional(),
    /** true makes this the primary address (the previous one stops being it); false clears it. */
    primary: z.boolean().optional(),
    /** Dedicate the address to a docker service on the panel host; null shares it again. */
    serviceId: z.number().int().positive().nullable().optional(),
  })
  .strict();

const ipParam = (raw: string): string => {
  const ip = normalizeHostIp(decodeURIComponent(raw));
  if (!ip) throw badRequest(`"${raw}" is not an IPv4 or IPv6 address of a host`, 'invalid_ip');
  return ip;
};

/**
 * 0.16.1 `/v1/host-ips`: the panel host's IP inventory (lib/hostIps.ts).
 * Operators label addresses, pick the primary one and dedicate one to a
 * service; any signed-in user may read the primary address (the panel's DNS
 * hints name it).
 */
export const hostIpRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/primary', async () => ({ ip: await primaryHostIp(app.db) }));

  app.get('/', { preHandler: [app.requireAdmin] }, async () => hostIpInventory(app.db));

  app.put('/:ip', { preHandler: [app.requireAdmin] }, async (req) => {
    const ip = ipParam((req.params as { ip: string }).ip);
    const body = patchBody.parse(req.body ?? {});
    const existing = await app.db.query.hostIps.findFirst({ where: eq(hostIps.ip, ip) });
    // A new annotation is for an address the host has: a typo would otherwise
    // become a "primary" nothing answers on. Unknown host: taken as given.
    if (!existing) {
      const live = await listHostAddresses();
      if (live && !live.some((a) => a.ip === ip)) {
        throw badRequest(`${ip} is not an address of this server (it has ${live.map((a) => a.ip).join(', ') || 'no public or LAN address'}).`, 'host_ip_unknown');
      }
    }
    if (body.serviceId != null && body.serviceId !== existing?.serviceId) {
      const svc = await app.db.query.services.findFirst({ where: eq(services.id, body.serviceId) });
      if (!svc) throw notFound('Service not found');
      if (svc.type !== 'docker' || svc.serverId != null) {
        throw badRequest('An address of this server can be dedicated to a docker service on this server only', 'invalid_service');
      }
      // Another service already bound to it explicitly would keep it.
      const others = await app.db.select({ name: services.name, portMappings: services.portMappings }).from(services).where(ne(services.id, svc.id));
      const holder = others.find((s) => (s.portMappings ?? []).some((m) => m.hostIp === ip));
      if (holder) throw conflict(`Service "${holder.name}" publishes ports on ${ip}; move its port mappings off the address first.`);
    }
    const values = {
      ...(body.label !== undefined ? { label: body.label || null } : {}),
      ...(body.primary !== undefined ? { isPrimary: body.primary } : {}),
      ...(body.serviceId !== undefined ? { serviceId: body.serviceId } : {}),
      updatedAt: new Date(),
    };
    // Not a transaction: the panel's SQLite client has one connection, and a
    // second primary for an instant is harmless (the read takes the first).
    if (body.primary) await app.db.update(hostIps).set({ isPrimary: false, updatedAt: new Date() }).where(and(eq(hostIps.isPrimary, true), ne(hostIps.ip, ip)));
    if (existing) await app.db.update(hostIps).set(values).where(eq(hostIps.ip, ip));
    else await app.db.insert(hostIps).values({ ip, ...values });
    void audit(app.db, req.user!.id, 'host_ip.update', ip, { previous: existing ?? null, ...body });
    return (await hostIpInventory(app.db)).addresses.find((a) => a.ip === ip) ?? null;
  });

  app.delete('/:ip', { preHandler: [app.requireAdmin] }, async (req) => {
    const ip = ipParam((req.params as { ip: string }).ip);
    const deleted = await app.db.delete(hostIps).where(eq(hostIps.ip, ip)).returning({ ip: hostIps.ip });
    if (deleted.length === 0) throw notFound('No saved settings for that address');
    void audit(app.db, req.user!.id, 'host_ip.delete', ip);
    return { ok: true };
  });
};
