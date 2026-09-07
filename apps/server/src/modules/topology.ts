import { databaseAttachments, databases, domains, services } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { TRAEFIK_CONTAINER, NETWORK } from '../engine/proxy.js';
import {
  containerRunning,
  listManagedVolumeNames,
  listUserNetworks,
  networkMembers,
  resolveVolumeOwner,
} from '../lib/inventory.js';
import { visibleDatabaseIds, visibleServiceIdSet } from '../lib/resourceAccess.js';

/** Whole-workspace graph for the topology view. Mounted under /topology.
 *
 * Layers: domains → traefik gateway → services → databases, plus the
 * infrastructure underneath — docker volumes (with owner links) and networks
 * (with member lists on the shared mesh). Docker probes are fault-tolerant:
 * with the daemon down the graph still renders, just without runtime layers. */
export const topologyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async (req) => {
    const [allServices, allDatabases, allAttachments, allDomains, visibleDatabases, visibleServiceIds] = await Promise.all([
      app.db.select().from(services),
      app.db.select().from(databases),
      app.db.select().from(databaseAttachments),
      app.db.select().from(domains),
      visibleDatabaseIds(app.db, req.user!),
      visibleServiceIdSet(app.db, req.user!),
    ]);
    // Authorization is workspace-derived now; `users.role` is gone.
    const isAdmin = req.user!.isOperator === true;
    const svcs = isAdmin
      ? allServices
      : allServices.filter((service) => visibleServiceIds.has(service.id));
    const dbs = visibleDatabases === null
      ? allDatabases
      : allDatabases.filter((database) => visibleDatabases.includes(database.id));
    const serviceIds = new Set(svcs.map((service) => service.id));
    const databaseIds = new Set(dbs.map((database) => database.id));
    const atts = allAttachments.filter(
      (attachment) => serviceIds.has(attachment.serviceId) && databaseIds.has(attachment.databaseId),
    );
    const doms = allDomains.filter((domain) => serviceIds.has(domain.serviceId));

    // Runtime layers (volumes/networks/gateway) come from docker — any probe
    // failure degrades to an empty list rather than failing the whole graph.
    const volumeNames = await listManagedVolumeNames().catch(() => [] as string[]);
    const nets = await listUserNetworks().catch(() => [] as Array<{ name: string; driver: string }>);
    // Member lists are only resolved for the shared NineDeploy network —
    // inspecting every user network gets slow and the topology only needs to
    // visualise OUR mesh.
    const allowedContainers = new Set([
      ...svcs.flatMap((service) =>
        [service.runtimeId, `nd-app-${service.slug}`].filter((name): name is string => name != null),
      ),
      ...dbs.map((database) => database.containerName ?? `nd-db-${database.name}`),
    ]);
    const visibleSlugs = new Set(svcs.map((service) => service.slug));
    const visibleNets = isAdmin
      ? nets
      : nets.filter((network) =>
          network.name === NETWORK ||
          (network.name.startsWith('nd-svc-') && visibleSlugs.has(network.name.slice('nd-svc-'.length))),
        );
    const networks = await Promise.all(
      visibleNets.map(async (n) => {
        // Show member lists on every managed bridge we can see — `network
        // inspect` is fast and the operator has already proven admin via the
        // `ninedeploy`/per-slug allow-list.
        const containers = (await networkMembers(n.name).catch(() => [] as string[])).filter(
          (container) => isAdmin || allowedContainers.has(container) || container === TRAEFIK_CONTAINER,
        );
        return { ...n, containers };
      }),
    );
    const gatewayRunning = await containerRunning(TRAEFIK_CONTAINER);

    return {
      services: svcs.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        type: s.type,
        status: s.status,
        image: s.image,
        port: s.port,
        runtimeId: s.runtimeId,
        volumeMount: s.volumeMount,
      })),
      databases: dbs.map((d) => ({
        id: d.id,
        name: d.name,
        engine: d.engine,
        status: d.status,
        host: d.internalHost,
      })),
      attachments: atts.map((a) => ({ id: a.id, serviceId: a.serviceId, databaseId: a.databaseId, envAlias: a.envAlias })),
      domains: doms.map((d) => ({ id: d.id, serviceId: d.serviceId, hostname: d.hostname, ssl: d.ssl })),
      volumes: volumeNames.flatMap((name) => {
        const owner = resolveVolumeOwner(svcs, dbs, name);
        if (!isAdmin && !owner) return [];
        return [{ name, owner: owner ? { kind: owner.kind, refId: owner.refId, name: owner.name, ...(owner.engine ? { engine: owner.engine } : {}) } : null }];
      }),
      networks,
      gateway: { name: TRAEFIK_CONTAINER, network: NETWORK, running: gatewayRunning },
    };
  });
};
