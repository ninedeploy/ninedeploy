import {
  imageTransfer,
  imageTransfersQuery,
  serverRoles,
  serviceSwarmStatus,
  servicePlacement,
  servicePlacementView,
  swarmInit,
  swarmSettings,
  swarmStatus,
  volumeCreate,
} from '@ninedeploy/schemas';
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
    // 0.16 T8: generated read-only MCP tool.
    mcp: {
      name: 'get_service_placement',
      description: 'Build placement of one service: where its image is built (null = where it runs), the build server, the push registry and the orchestrator (null = plain containers).',
      readOnly: true,
    },
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
    // 0.16 T8: generated read-only MCP tool.
    mcp: {
      name: 'list_image_transfers',
      description: 'Image transfers of one service, newest first: method, source and target host (null = the panel host), bytes, sha256, duration and outcome.',
      readOnly: true,
    },
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
  'GET /v1/swarm': {
    summary: 'Swarm status of the panel host',
    tag: 'swarm',
    description:
      "Operator only. Whether Swarm is enabled, the panel host daemon's swarm state (`docker info` LocalNodeState; `unreachable` when the daemon did not answer), whether it is a manager, the address nodes join, and the nodes (linked to their NineDeploy server when they joined through their agent). Join tokens are never returned.",
    floor: 'operator',
    response: swarmStatus,
    // 0.16 T8: generated read-only MCP tool (operator, coarse token only). Join tokens are never returned.
    mcp: {
      name: 'get_swarm_status',
      description: "Swarm status of the panel host: whether Swarm deploys are enabled, the daemon's swarm state, the manager address, the nodes and any warnings. Never a join token. Operator only.",
      readOnly: true,
    },
  },
  'POST /v1/swarm/init': {
    summary: 'Initialise Swarm on the panel host',
    tag: 'swarm',
    description:
      'Operator only, from an interactive session, with step-up (`password`, or a sign-in within 10 minutes). Runs `docker swarm init --advertise-addr <ip>` on the panel host; 409 swarm_already_active when the daemon is already in a swarm. The panel never initialises Swarm on its own. Audited swarm.init.',
    floor: 'operator',
    body: swarmInit,
    response: swarmStatus,
    validation: 'zod',
  },
  'PUT /v1/swarm/settings': {
    summary: 'Enable or disable Swarm deploys',
    tag: 'swarm',
    description:
      'Operator only. Enabling needs step-up and an active manager (409 swarm_not_manager). Disabling refuses new Swarm deploys; running stacks keep running. Audited swarm.settings.',
    floor: 'operator',
    body: swarmSettings,
    response: swarmStatus,
    validation: 'zod',
  },
  'POST /v1/servers/:id/swarm/join': {
    summary: 'Join a node to the swarm as a worker',
    tag: 'servers',
    description:
      "Operator only. Reads the worker join token on the panel and sends it to the node's agent over the sealed transport only (capability `swarm`; 422 node_agent_outdated for an older agent, 422 node_swarm_not_enabled when the node's owner has not set NINEDEPLOY_AGENT_SWARM_MANAGER). The token is never stored, logged or returned, and is rotated after the join. The manager confirms the reported node (a worker, from the server's host, not linked elsewhere) before it is linked and labelled nd.member=1. Audited server.swarm.join.",
    floor: 'operator',
    responseType: "{ serverId: number; nodeId: string; role: 'worker'; warnings?: string[] }",
  },
  'POST /v1/servers/:id/swarm/leave': {
    summary: 'Drain a node and take it out of the swarm',
    tag: 'servers',
    description:
      'Operator only. Removes the nd.member label, drains the node, waits up to 5 minutes for its tasks to move, runs `docker swarm leave` on the node through its agent, removes the node from the swarm and rotates the join token. Audited server.swarm.leave.',
    floor: 'operator',
    responseType: '{ serverId: number; nodeId: string; drained: boolean; warnings?: string[] }',
  },
  'GET /v1/services/:id/swarm': {
    summary: 'Swarm tasks of a service',
    tag: 'services',
    description: 'The stack, the desired and running replica counts and the tasks (node, state, error, image). `stack: null` for a service that is not on Swarm.',
    floor: 'viewer',
    response: serviceSwarmStatus,
    // 0.16 T8: generated read-only MCP tool.
    mcp: {
      name: 'get_service_swarm',
      description: 'Swarm tasks of one service: the stack, desired and running replicas, and each task (node, state, error, image). stack is null when the service is not on Swarm.',
      readOnly: true,
    },
  },
  // ── end 0.16 T7 ──
};
