import { eq } from 'drizzle-orm';
import { audit } from '../lib/audit.js';
import { domains, services } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { readCertificates, writeDynamicConfig } from '../engine/proxy.js';
import { notFound, parseId } from '../lib/errors.js';

import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertServiceRole, visibleServiceIdSet } from '../lib/resourceAccess.js';

/** Centralized domain index: which domain → which service/container, plus SSL. Mounted under /domains. */
export const domainIndexRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const user = req.user!;
    const [rows, allServices] = await Promise.all([
      app.db.query.domains.findMany(),
      app.db.select().from(services),
    ]);
    // Shared visibility rule — see lib/resourceAccess.ts. This route used to
    // carry its own inline copy of the owner ∪ workspace-tag union.
    const visible = await visibleServiceIdSet(app.db, user);
    const svcs = visible === null ? allServices : allServices.filter((s) => visible.has(s.id));
    const byId = new Map(svcs.map((s) => [s.id, s]));
    const visibleRows = rows.filter((domain) => byId.has(domain.serviceId));
    // Certificate expiry comes from Traefik's ACME storage (empty without ACME).
    const certs = new Map(readCertificates().map((c) => [c.domain, c.expiresAt]));
    return visibleRows.map((d) => {
      const s = byId.get(d.serviceId);
      return {
        id: d.id,
        hostname: d.hostname,
        path: d.path,
        ssl: d.ssl,
        status: d.status,
        serviceId: d.serviceId,
        serviceName: s?.name ?? null,
        container: s?.runtimeId ?? null,
        port: s?.port ?? null,
        certExpiresAt: certs.get(d.hostname)?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      };
    });
  });

  app.patch('/:id', async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const input = (req.body ?? {}) as { ssl?: boolean };
    const domain = await app.db.query.domains.findFirst({ where: eq(domains.id, id) });
    if (!domain) throw notFound('Domain not found');
    const svc = await loadServiceForUser(app.db, domain.serviceId, req.user!);
    // A write on the service: same `member` floor as every route in domains.ts.
    await assertServiceRole(app.db, svc, req.user!, 'member');
    // SSL toggle only. This used to also set `status: 'active'`, which let any
    // seat holder skip DNS ownership proof — the verify route in domains.ts is
    // the only place a domain may become active (r092).
    const [d] = await app.db
      .update(domains)
      .set({ ssl: input.ssl ?? false, updatedAt: new Date() })
      .where(eq(domains.id, id))
      .returning();
    if (!d) throw notFound('Domain not found');
    await writeDynamicConfig(app.db);
    void audit(app.db, req.user!.id, 'domain.ssl', `${d.hostname} → ${d.ssl ? 'on' : 'off'}`);
    return { id: d.id, ssl: d.ssl };
  });
};
