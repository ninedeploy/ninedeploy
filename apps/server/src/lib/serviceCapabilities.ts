import { eq } from 'drizzle-orm';
import { serviceTargets, type DB, type Service } from '@ninedeploy/db';
import { SERVICE_CAPABILITY_IDS, type ServiceCapability, type ServiceCapabilityId } from '@ninedeploy/schemas';
import { nodeRpsAutoscalingAccepted } from './autoscaler.js';
import { AGENT_CAPABILITY_VERSION } from './agentCapabilities.js';
import { badRequest } from './errors.js';
import { restartLimitSupported } from './restartLimit.js';
import { FILE_MOUNTS_UNSUPPORTED, fileMountsSupported } from './serviceFiles.js';

/**
 * C1 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): one answer per feature to
 * "can this service use it?". Each feature's own route refuses through
 * `assertServiceCapability`, and `GET /v1/services/:id/capabilities` and the
 * generated docs/SUPPORT_MATRIX.md read `serviceCapabilities`, so the panel,
 * the API and the docs cannot disagree.
 *
 * Only structural facts are judged here: type, image, compose file, server,
 * orchestrator and fan-out targets. Checks of the live environment (can
 * Traefik reach the panel, does a node's agent advertise an operation) stay
 * where they run today, at save or deploy time.
 */

export type CapabilityService = Pick<Service, 'id' | 'type' | 'serverId' | 'orchestrator' | 'image' | 'composeContent'>;

interface Facts {
  onNode: boolean;
  onSwarm: boolean;
  /** The service also runs on node fan-out targets. */
  fanout: boolean;
}

/** The error code and message each route answered before C1; kept verbatim. */
const REFUSAL: Record<ServiceCapabilityId, { code: string; node: string; fanout?: string; type?: string }> = {
  maintenance: {
    code: 'maintenance_unsupported',
    node: 'Maintenance mode is for services on the panel host for now',
    fanout: 'Maintenance mode is not available for a service that also runs on nodes',
  },
  errorPages: {
    code: 'error_pages_unsupported',
    node: 'Custom error pages are for services on the panel host for now',
    fanout: 'Custom error pages are not available for a service that also runs on nodes',
  },
  forwardAuth: {
    code: 'forward_auth_unsupported',
    node: 'Panel sign-in is for domains of services on the panel host for now',
    fanout: 'Panel sign-in is not available for a service that also runs on nodes',
  },
  restartLimit: { code: 'restart_limit_unsupported', node: 'The restart-loop limit is for docker services on the panel host and PM2 services, not Swarm' },
  inlineDockerfile: { code: 'inline_dockerfile_unsupported', node: 'An inline Dockerfile is for docker services that build from source, not from an image or a compose file' },
  fileMounts: { code: 'file_mounts_unsupported', node: FILE_MOUNTS_UNSUPPORTED },
  autoscale: { code: 'bad_request', node: 'Autoscaling applies to docker services only' },
  scaleToZero: { code: 'bad_request', node: 'Scale to zero applies to docker services only' },
  canary: { code: 'bad_request', node: 'Canary releases apply to docker services only' },
};

/** P2: what a node needs to serve maintenance and error pages (lib/nodePages.ts). */
const NODE_PAGES_REASON =
  `On a node, the node's agent serves the pages itself: it must be v${AGENT_CAPABILITY_VERSION['proxy.pages']} or newer and run as the ninedeploy-agent container, ` +
  'and its owner must not have turned it off (NINEDEPLOY_AGENT_NODE_PAGES=off)';

const ok: ServiceCapability = { status: 'available', reason: null };
const no = (reason: string): ServiceCapability => ({ status: 'unavailable', reason });

function evaluate(id: ServiceCapabilityId, svc: CapabilityService, f: Facts): ServiceCapability {
  const r = REFUSAL[id];
  switch (id) {
    case 'maintenance':
    case 'errorPages':
      // P2: a node serves the pages itself; the save checks its agent live.
      if (f.fanout) return no(r.fanout!);
      if (f.onNode) return { status: 'limited', reason: NODE_PAGES_REASON };
      return ok;
    case 'forwardAuth':
      if (f.onNode) return no(r.node);
      if (f.fanout) return no(r.fanout!);
      return ok;
    case 'restartLimit':
      return restartLimitSupported(svc) ? ok : no(r.node);
    case 'inlineDockerfile':
      if (svc.type !== 'docker' || svc.image || svc.composeContent) return no(r.node);
      // Saved for a node service too, but only a build on the panel host has the file.
      if (f.onNode) return { status: 'limited', reason: 'On a node, the service must build on the panel host (Service → Settings → Build on: panel); a build on a node or a build server would not have the file' };
      return ok;
    case 'fileMounts':
      return fileMountsSupported(svc) ? ok : no(r.node);
    case 'autoscale':
      if (svc.type !== 'docker') return no(r.node);
      if (f.onSwarm) return { status: 'limited', reason: 'Swarm services are not autoscaled: they run the replica count set on the service' };
      if (f.onNode && !nodeRpsAutoscalingAccepted()) return { status: 'limited', reason: 'On a node, autoscaling uses CPU and memory; requests per second is not available yet' };
      if (f.onNode) return { status: 'limited', reason: 'On a node, requests-per-second scaling needs an agent with proxy traffic observation turned on (NINEDEPLOY_AGENT_PROXY_TRAFFIC=on)' };
      return ok;
    case 'scaleToZero':
      if (svc.type !== 'docker') return no(r.node);
      if (f.onSwarm) return { status: 'limited', reason: 'Scale to zero does not apply to Swarm services; the setting is kept but nothing sleeps' };
      if (f.onNode) return { status: 'in_progress', reason: 'Scale to zero on nodes is being built (R2); until it is accepted, a node service does not sleep' };
      return ok;
    case 'canary':
      if (svc.type !== 'docker') return no(r.node);
      if (f.onSwarm) return { status: 'limited', reason: 'Swarm services skip the canary and use Docker’s native rolling update' };
      if (f.onNode) return { status: 'limited', reason: 'On a node, a canary needs a single replica, the strict HTTP healthcheck and an agent with proxy traffic observation' };
      return ok;
  }
}

async function facts(db: DB, svc: CapabilityService): Promise<Facts> {
  const target = await db.query.serviceTargets.findFirst({ where: eq(serviceTargets.serviceId, svc.id), columns: { serviceId: true } });
  return { onNode: svc.serverId != null, onSwarm: svc.orchestrator === 'swarm', fanout: !!target };
}

/** The support-matrix column a service falls in. */
export function runtimeOf(svc: Pick<Service, 'type' | 'serverId' | 'orchestrator'>): string {
  if (svc.orchestrator === 'swarm') return `swarm-${svc.type}`;
  return `${svc.serverId != null ? 'node' : 'panel'}-${svc.type}`;
}

export async function serviceCapability(db: DB, svc: CapabilityService, id: ServiceCapabilityId): Promise<ServiceCapability> {
  return evaluate(id, svc, await facts(db, svc));
}

export async function serviceCapabilities(db: DB, svc: CapabilityService): Promise<Record<ServiceCapabilityId, ServiceCapability>> {
  const f = await facts(db, svc);
  return Object.fromEntries(SERVICE_CAPABILITY_IDS.map((id) => [id, evaluate(id, svc, f)])) as Record<ServiceCapabilityId, ServiceCapability>;
}

/**
 * The refusal a route answers when the feature is turned on for a service that
 * cannot use it: the same code and message as before C1. `limited` and
 * `in_progress` features are saved, as they always were.
 */
export async function assertServiceCapability(db: DB, svc: CapabilityService, id: ServiceCapabilityId): Promise<void> {
  const cap = await serviceCapability(db, svc, id);
  if (cap.status === 'unavailable') throw badRequest(cap.reason ?? 'Not available for this service', REFUSAL[id].code);
}
