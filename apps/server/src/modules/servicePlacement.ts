import { eq } from 'drizzle-orm';
import { servers, services, sources, type DB } from '@ninedeploy/db';
import { type ServicePlacementView, type ServiceSwarmStatus, servicePlacement } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { assertNodeCapability } from '../lib/agentCapabilities.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, parseId, unprocessable } from '../lib/errors.js';
import { loadServiceForUser } from '../lib/resourceAccess.js';
import { serviceSwarmView, swarmEnabled } from '../lib/swarm.js';
import { swarmServiceRefusal } from '../engine/swarmDeploy.js';

/**
 * Service placement: where a service's image is built, how it travels, and
 * which orchestrator runs it (multi-node, design §6.2, §6.6, §7.5).
 *
 *  - `GET /v1/services/:id/placement` — anyone who can see the service.
 *  - `PUT /v1/services/:id/placement` — operators only: placement is an
 *    instance resource decision, like `serverId`. Partial: only the named
 *    keys change, and `null` restores the 0.15 default for that key. Audited
 *    `service.placement.update` with the previous values.
 *
 * Every stored NULL reproduces 0.15: build where the service runs, ship by
 * stream relay, run plain containers. Nothing here deploys; the next deploy
 * reads the row (engine/buildPlacement.ts).
 */

type ServiceRow = typeof services.$inferSelect;

export function placementView(svc: Pick<ServiceRow, 'buildOn' | 'buildServerId' | 'pushRegistrySourceId' | 'pushRepository' | 'orchestrator'>): ServicePlacementView {
  return {
    buildOn: svc.buildOn ?? null,
    buildServerId: svc.buildServerId ?? null,
    pushRegistrySourceId: svc.pushRegistrySourceId ?? null,
    pushRepository: svc.pushRepository ?? null,
    orchestrator: svc.orchestrator ?? null,
  };
}

/**
 * The placement checks a PUT must pass (design §6.6): the build server is a
 * build server, a build away from where the service runs applies to docker
 * services built from a repository, a registry is a registry credential and
 * comes with a repository, and the nodes involved can do it (their cached
 * capabilities, else one `agent.ping`: 422 `node_agent_outdated` for an
 * older agent, nothing written).
 */
/**
 * The registry credential a caller may set as a push registry, or a 404.
 * Sources are instance-wide, operator-managed credentials (`sourcesRoutes`
 * is operator-only, and attaching a `sourceId` to a service is operator-only
 * in modules/services.ts); setting one as the push registry is exactly that
 * attachment, so the same rule applies: operators only. Anyone else gets the
 * same 404 as for a source that does not exist, so ids cannot be probed. The
 * route itself is operator-only; this keeps the rule at the lookup too.
 */
async function loadPushRegistrySource(db: DB, id: number, user: { isOperator?: boolean }) {
  if (user.isOperator !== true) throw notFound('Registry source not found');
  const src = await db.query.sources.findFirst({ where: eq(sources.id, id) });
  if (!src) throw notFound('Registry source not found');
  return src;
}

async function assertPlacementAllowed(db: DB, svc: ServiceRow, next: ServicePlacementView, user: { isOperator?: boolean }): Promise<void> {
  const buildOn = next.buildOn ?? 'target';
  if (buildOn !== 'target' && (svc.type !== 'docker' || svc.composeContent)) {
    throw badRequest(`Build placement applies to docker services; a ${svc.composeContent ? 'compose stack' : `${svc.type} service`} builds where it runs.`, 'placement_unsupported');
  }
  if (buildOn === 'server') {
    if (next.buildServerId == null) throw badRequest('Choose the build server (buildServerId) for Build on: server.', 'placement_unsupported');
    const row = await db.query.servers.findFirst({ where: eq(servers.id, next.buildServerId) });
    if (!row) throw notFound('Build server not found');
    if (!row.isBuildServer) {
      throw badRequest(`Node "${row.name}" is not a build server; turn its build-server role on first (PATCH /v1/servers/${row.id}).`, 'placement_unsupported');
    }
  }
  if ((next.pushRegistrySourceId == null) !== (next.pushRepository == null)) {
    throw badRequest('A push registry needs both the registry credential (pushRegistrySourceId) and the repository (pushRepository).', 'placement_unsupported');
  }
  if (next.pushRegistrySourceId != null) {
    const src = await loadPushRegistrySource(db, next.pushRegistrySourceId, user);
    if (src.type !== 'registry') throw badRequest('The push registry must be a registry credential (a source of type registry).', 'placement_unsupported');
  }
  // ── 0.16 T7 swarm ──
  // Switching to Swarm (design §7.1, §7.5) needs a service Swarm can run and
  // Swarm enabled on this panel; the deploy re-checks both and the cluster.
  // Nothing is deployed here: the next deploy runs the service on Swarm.
  // Switching back to containers is always allowed: the next deploy starts
  // the container, and the stack is removed once it is live and routed.
  if (next.orchestrator === 'swarm' && svc.orchestrator !== 'swarm') {
    const reason = await swarmServiceRefusal(db, svc);
    if (reason) throw unprocessable(reason, 'swarm_unsupported');
    if (!(await swarmEnabled(db))) {
      throw unprocessable('Swarm is not enabled on this panel: an operator initialises and enables it first (Settings → Swarm).', 'swarm_disabled');
    }
  }
  // ── end 0.16 T7 ──

  // Capabilities (cached; the deploy re-checks with a ping). A build away
  // from the service hands the image over by stream relay (default) or a
  // registry push: the build server must send it, the target must receive it.
  const viaRegistry = next.pushRegistrySourceId != null;
  if (buildOn === 'server' && next.buildServerId != null && next.buildServerId !== svc.serverId) {
    await assertNodeCapability(db, next.buildServerId, {
      cap: viaRegistry ? 'image.manage' : ['stream', 'image.manage'],
      feature: 'hand a built image over as a build server',
      sealedRequired: !viaRegistry,
    });
  }
  const buildsAway = buildOn === 'panel' ? svc.serverId != null : buildOn === 'server' ? next.buildServerId !== svc.serverId : false;
  if (buildsAway && svc.serverId != null && !viaRegistry) {
    await assertNodeCapability(db, svc.serverId, { cap: ['stream', 'image.manage'], feature: 'receive an image', sealedRequired: true });
  }
}

export const servicePlacementRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/placement', { onRequest: [app.authenticate] }, async (req): Promise<ServicePlacementView> => {
    const id = parseId((req.params as { id: string }).id);
    return placementView(await loadServiceForUser(app.db, id, req.user!));
  });

  // ── 0.16 T7 swarm ──
  // The Swarm tasks of one service (design §7.5): anyone who can see the
  // service. A service not on Swarm answers `stack: null`.
  app.get('/:id/swarm', { onRequest: [app.authenticate] }, async (req): Promise<ServiceSwarmStatus> => {
    const id = parseId((req.params as { id: string }).id);
    return serviceSwarmView(await loadServiceForUser(app.db, id, req.user!));
  });
  // ── end 0.16 T7 ──

  app.put('/:id/placement', { onRequest: [app.authenticate], preHandler: app.requireOperator }, async (req): Promise<ServicePlacementView> => {
    const id = parseId((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    const input = servicePlacement.parse(req.body ?? {});
    const previous = placementView(svc);
    const next: ServicePlacementView = { ...previous };
    for (const key of Object.keys(input) as Array<keyof ServicePlacementView>) {
      (next as Record<string, unknown>)[key] = input[key] ?? null;
    }
    await assertPlacementAllowed(app.db, svc, next, req.user!);
    await app.db
      .update(services)
      .set({
        buildOn: next.buildOn,
        buildServerId: next.buildServerId,
        pushRegistrySourceId: next.pushRegistrySourceId,
        pushRepository: next.pushRepository,
        orchestrator: next.orchestrator,
        updatedAt: new Date(),
      })
      .where(eq(services.id, svc.id));
    void audit(app.db, req.user!.id, 'service.placement.update', svc.name, { serviceId: svc.id, previous, next });
    return next;
  });
};
