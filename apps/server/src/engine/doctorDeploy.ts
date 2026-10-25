import type { DoctorFinding, PortMapping, ServiceRoutingView } from '@ninedeploy/schemas';
import { formatPortMapping, mappedPortCount, portMappingsOverlap } from '@ninedeploy/schemas';
import { DEPLOYMENT_LABEL, MAX_REPLICAS, SERVICE_LABEL, replicaNames } from './dockerNames.js';

/**
 * Doctor checks for deploy leftovers and host-port / NAT setups (SIP, game
 * servers, anything publishing raw TCP/UDP). Pure functions over facts the
 * scan already gathered, so each rule is testable without a docker daemon.
 */

export interface LabeledContainer {
  name: string;
  state: string;
  labels: Record<string, string>;
}

interface ServiceFacts {
  id: number;
  name: string;
  type: string;
  status: string;
  serverId?: number | null;
  runtimeId?: string | null;
  port?: number | null;
  publishedPort?: number | null;
  portMappings?: PortMapping[] | null;
  healthCheck?: string | null;
  orchestrator?: string | null;
}

const IN_FLIGHT = new Set(['queued', 'building', 'deploying']);

/** `ninedeploy.deployment=12,ninedeploy.service=3` (docker ps `{{.Labels}}`). Values may hold `=`, never `,` for ours. */
export function parseDockerLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/**
 * Containers a deploy started that nothing owns any more. Kept (never
 * reported): the service's live generation and its replicas, every container
 * of a deploy still in flight, and every container of a service whose
 * routing transition is pending (the recovery decides those generations).
 */
export function deployLeftoverFindings(
  containers: readonly LabeledContainer[],
  svcs: readonly ServiceFacts[],
  deploys: ReadonlyArray<{ id: number; status: string }>,
  transitionServiceIds: ReadonlySet<number>,
): DoctorFinding[] {
  const byId = new Map(svcs.map((s) => [s.id, s]));
  const statusOf = new Map(deploys.map((d) => [d.id, d.status]));
  const out: DoctorFinding[] = [];
  for (const c of containers) {
    const depId = Number(c.labels[DEPLOYMENT_LABEL]);
    const svcId = Number(c.labels[SERVICE_LABEL]);
    if (!Number.isInteger(depId) || !Number.isInteger(svcId) || depId <= 0 || svcId <= 0) continue;
    if (transitionServiceIds.has(svcId)) continue;
    const status = statusOf.get(depId);
    if (status && IN_FLIGHT.has(status)) continue;
    const svc = byId.get(svcId);
    if (svc?.runtimeId && replicaNames(svc.runtimeId, MAX_REPLICAS).includes(c.name)) continue;
    const running = c.state === 'running' || c.state === 'restarting';
    const why = !svc
      ? 'its service was deleted'
      : status
        ? `deployment #${depId} ended "${status}" and the service runs ${svc.runtimeId ?? 'nothing'}`
        : `deployment #${depId} was removed from history and the service runs ${svc.runtimeId ?? 'nothing'}`;
    out.push({
      id: `deploy_leftover_container:${c.name}`,
      kind: 'deploy_leftover_container',
      // A running leftover keeps its CPU/memory — and a host-port service's
      // ports, so its next deploy fails "port is already allocated".
      severity: running ? 'warn' : 'info',
      title: `Leftover container ${c.name} from deployment #${depId}${running ? ' is still running' : ''}`,
      detail: `Started by a deploy of ${svc ? `"${svc.name}"` : `service #${svcId}`}, but ${why}. Nothing will ever remove it on its own.`,
      target: { type: 'container', name: c.name, id: null },
      action: 'remove_deploy_leftover',
      sizeBytes: null,
    });
  }
  return out;
}

const isLocalDocker = (s: ServiceFacts) => s.type === 'docker' && (s.serverId ?? null) === null && s.orchestrator !== 'swarm';

/** The mappings a service publishes from its own container (an allow list is held by the port proxy, still the host's port). */
function hostMappings(s: ServiceFacts): PortMapping[] {
  const list = [...(s.portMappings ?? [])];
  if (s.publishedPort) list.push({ hostPort: s.publishedPort, containerPort: s.port ?? s.publishedPort, protocol: 'tcp' });
  return list;
}

const covers = (m: PortMapping, port: number) => port >= m.containerPort && port <= m.containerPort + ((m.hostPortEnd ?? m.hostPort) - m.hostPort);

/** The service port is only ever published as UDP: nothing speaks TCP (let alone HTTP) on it. */
function udpOnlyPort(s: ServiceFacts): boolean {
  if (s.port == null) return false;
  const mappings = hostMappings(s);
  return mappings.some((m) => m.protocol === 'udp' && covers(m, s.port!)) && !mappings.some((m) => (m.protocol ?? 'tcp') === 'tcp' && covers(m, s.port!));
}

export function hostPortFindings(
  svcs: readonly ServiceFacts[],
  routedServiceIds: ReadonlySet<number>,
  hostIps: readonly string[] | null,
): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  const live = svcs.filter((s) => s.status !== 'stopped');
  for (const s of live) {
    if (udpOnlyPort(s) && routedServiceIds.has(s.id)) {
      out.push({
        id: `domain_on_udp_port:${s.id}`,
        kind: 'domain_on_udp_port',
        severity: 'warn',
        title: `"${s.name}" has an HTTP domain on port ${s.port}, which it only publishes as UDP`,
        detail: `Traefik sends HTTP to ${s.port}/tcp and gets no answer, so every request to the domain is a 502 Bad Gateway. Raw TCP/UDP traffic (SIP, RTP, game servers) goes through the port mappings and never needs a domain — remove the domain (and any automatic URL), or set the service port to the one that serves HTTP.`,
        target: { type: 'service', name: s.name, id: s.id },
        action: null,
        sizeBytes: null,
      });
    }
    const httpProbe = s.healthCheck == null || s.healthCheck === 'http' || s.healthCheck === 'http-strict';
    if (isLocalDocker(s) && httpProbe && udpOnlyPort(s)) {
      out.push({
        id: `healthcheck_unpassable:${s.id}`,
        kind: 'healthcheck_unpassable',
        severity: 'warn',
        title: `"${s.name}" probes HTTP on port ${s.port}, which only listens on UDP`,
        detail: 'The readiness check can never pass, so every deploy waits for the healthcheck timeout and fails. A UDP service (SIP, RTP, DNS, game servers) needs the "running" check — or "tcp" when it also listens on a TCP port.',
        target: { type: 'service', name: s.name, id: s.id },
        action: 'set_healthcheck_running',
        sizeBytes: null,
      });
    }
    if (isLocalDocker(s) && hostIps) {
      const known = new Set(hostIps.map((ip) => ip.toLowerCase()));
      for (const m of s.portMappings ?? []) {
        if (!m.hostIp || known.has(m.hostIp.toLowerCase())) continue;
        out.push({
          id: `port_host_ip_missing:${s.id}:${formatPortMapping(m)}`,
          kind: 'port_host_ip_missing',
          severity: 'critical',
          title: `"${s.name}" binds ${formatPortMapping(m)} to ${m.hostIp}, which this host does not have`,
          detail: `Docker can only bind addresses on this host's interfaces (${hostIps.join(', ') || 'none found'}); the container cannot start ("cannot assign requested address"). Behind NAT, bind to the PRIVATE address the router forwards to, and let the application advertise the public one (Asterisk external_media_address, FreeSWITCH ext-rtp-ip).`,
          target: { type: 'service', name: s.name, id: s.id },
          action: null,
          sizeBytes: null,
        });
      }
    }
  }
  // Same host socket published by two services (local docker only: a node's ports are its own).
  const local = live.filter(isLocalDocker);
  for (let i = 0; i < local.length; i++) {
    for (let j = i + 1; j < local.length; j++) {
      const a = local[i]!;
      const b = local[j]!;
      const hit = hostMappings(a).flatMap((ma) => hostMappings(b).filter((mb) => portMappingsOverlap(ma, mb)).map((mb) => [ma, mb] as const))[0];
      if (!hit) continue;
      out.push({
        id: `host_port_conflict:${a.id}:${b.id}`,
        kind: 'host_port_conflict',
        severity: 'critical',
        title: `"${a.name}" and "${b.name}" publish the same host port (${formatPortMapping(hit[0])} / ${formatPortMapping(hit[1])})`,
        detail: 'Only one of them can hold it; the other fails to start with "port is already allocated" on its next deploy. Give one a different host port or a different host IP.',
        target: { type: 'service', name: b.name, id: b.id },
        action: null,
        sizeBytes: null,
      });
    }
  }
  return out;
}

/** Published host ports past which one docker-proxy process per port starts to hurt. */
export const USERLAND_PROXY_PORT_THRESHOLD = 100;

/**
 * `daemonJson` is /etc/docker/daemon.json (null: no such file, so Docker's
 * default — the userland proxy ON). Undefined: the panel cannot see the
 * host's Docker config (it runs in a container) — no finding.
 */
export function userlandProxyFinding(svcs: readonly ServiceFacts[], daemonJson: string | null | undefined): DoctorFinding | null {
  if (daemonJson === undefined) return null;
  const ports = svcs.filter((s) => s.status !== 'stopped' && isLocalDocker(s))
    .reduce((n, s) => n + hostMappings(s).filter((m) => !m.allowFrom?.length).reduce((k, m) => k + mappedPortCount(m), 0), 0);
  if (ports < USERLAND_PROXY_PORT_THRESHOLD) return null;
  if (daemonJson !== null) {
    try {
      if ((JSON.parse(daemonJson) as { 'userland-proxy'?: unknown })['userland-proxy'] === false) return null;
    } catch {
      /* an unreadable file is Docker's problem to report; judge it as default */
    }
  }
  return {
    id: 'userland_proxy_ports:host',
    kind: 'userland_proxy_ports',
    severity: 'warn',
    title: `${ports} host ports are published while Docker's userland proxy is on`,
    detail: 'Docker starts one docker-proxy process per published port (an RTP range of 1000 ports = 1000 processes), which slows every container start and eats memory. Add "userland-proxy": false to /etc/docker/daemon.json and restart Docker; external traffic keeps arriving with its real source address through Docker\'s NAT rules either way.',
    target: { type: 'host', name: null, id: null },
    action: null,
    sizeBytes: null,
  };
}

/**
 * What the live routing view (routingView.ts) found wrong with a running
 * local service: a domain Traefik has no router for, or one still pointing at
 * a container that is not the live runtime (404 / 502 while the app is up),
 * and host ports Docker did not bind. A stopped container is left to the
 * runtime findings, which already report it.
 */
export function routingFindings(
  entries: ReadonlyArray<{ service: { id: number; name: string }; view: ServiceRoutingView }>,
): DoctorFinding[] {
  const out: DoctorFinding[] = [];
  for (const { service: s, view } of entries) {
    for (const r of view.http) {
      if (r.problem !== 'no_router' && r.problem !== 'no_upstream' && r.problem !== 'stale_upstream') continue;
      out.push({
        id: `http_route_broken:${s.id}:${r.domainId}`,
        kind: 'http_route_broken',
        severity: 'critical',
        title: `${r.hostname} of "${s.name}" is not routed to its live container`,
        detail: `${r.note}. The Traefik file is out of step with the service; rewriting it from the stored services and domains restores the route without a redeploy.`,
        target: { type: 'service', name: s.name, id: s.id },
        action: 'rewrite_proxy_config',
        sizeBytes: null,
      });
    }
    for (const p of view.ports) {
      if (p.problem !== 'unbound' && p.problem !== 'proxy_missing') continue;
      const host = `${p.hostIp ?? '*'}:${p.hostPortEnd ? `${p.hostPort}-${p.hostPortEnd}` : p.hostPort}/${p.protocol}`;
      out.push({
        id: `host_port_unbound:${s.id}:${host}`,
        kind: 'host_port_unbound',
        severity: 'critical',
        title: `Host port ${host} of "${s.name}" is not open`,
        detail: `${p.note}. Port mappings are applied when the container is created, so a mapping saved after the last deploy (or one Docker could not bind) stays closed until the service is redeployed.`,
        target: { type: 'service', name: s.name, id: s.id },
        action: null,
        sizeBytes: null,
      });
    }
  }
  return out;
}
