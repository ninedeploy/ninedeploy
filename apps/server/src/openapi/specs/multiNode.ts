import { imageTransfer, imageTransfersQuery, serverRoles, servicePlacement, servicePlacementView, volumeCreate } from '@ninedeploy/schemas';
import { z } from 'zod';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment for the multi-node routes (design §1.3, §4.3, §6.6,
 * §7.5). Every key here must name a live route (authzMatrix `ROUTE_SPECS`
 * coverage case) and its floor must equal the route's MATRIX floor.
 *
 * T1 creates it empty; each task fills only its own labelled block, in the
 * same change that registers the route. A route a task adds to an existing
 * module (for example `POST /v1/volumes`) is documented here too, so the
 * pre-0.16 fragments stay frozen.
 */
export const multiNodeSpecs: RouteSpecMap = {
  // ── 0.16 T2 agent transport ──
  // ── end 0.16 T2 ──
  // ── 0.16 T3 node builds and private clones ──
  // ── end 0.16 T3 ──
  // ── 0.16 T4 build placement ──
  'GET /v1/services/:id/placement': {
    summary: "A service's build placement",
    tag: 'services',
    description:
      'Where the image is built (`buildOn`: null = target, where the service runs), the build server, the opt-in push registry and the orchestrator. Null values are the 0.15 defaults.',
    floor: 'viewer',
    response: servicePlacementView,
  },
  'PUT /v1/services/:id/placement': {
    summary: "Set a service's build placement",
    tag: 'services',
    description:
      'Operator only. Partial: only the named keys change; null restores the default. Validates the build-server role, the registry source and the capabilities of the nodes (422 node_agent_outdated for an older agent). Audited service.placement.update.',
    floor: 'operator',
    body: servicePlacement,
    response: servicePlacementView,
    validation: 'zod',
  },
  'GET /v1/services/:id/image-transfers': {
    summary: 'Image transfers of a service',
    tag: 'services',
    description: 'Newest first: one row per image shipped to a host (method, bytes, sha256, duration, outcome). A null server is the panel host.',
    floor: 'viewer',
    query: imageTransfersQuery,
    response: z.array(imageTransfer),
    validation: 'zod',
  },
  'GET /v1/deployments/:id/image-transfers': {
    summary: 'Image transfers of a deployment',
    tag: 'deploys',
    floor: 'viewer',
    response: z.array(imageTransfer),
  },
  'PATCH /v1/servers/:id': {
    summary: "Set a server's build-server role",
    tag: 'servers',
    description: 'Operator only. `isBuildServer` and `buildConcurrency` (1–8); both default off / 1. Audited server.roles.update.',
    floor: 'operator',
    body: serverRoles,
    responseType: '{ id: number; name: string; isBuildServer: boolean; buildConcurrency: number; buildServiceIds: number[] }',
    validation: 'zod',
  },
  // ── end 0.16 T4 ──
  // ── 0.16 T5 node volumes ──
  'POST /v1/volumes': {
    summary: 'Create a managed volume on the panel host or a node',
    tag: 'volumes',
    floor: 'operator',
    body: volumeCreate,
    responseType: '{ ok: boolean; name: string; serverId: number | null }',
    validation: 'zod',
  },
  // ── end 0.16 T5 ──
  // ── 0.16 T6 node databases ──
  // ── end 0.16 T6 ──
  // ── 0.16 T7 swarm ──
  // ── end 0.16 T7 ──
};
