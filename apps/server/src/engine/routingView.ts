import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import yaml from 'js-yaml';
import { domains, type DB, type Domain, type Service, type ServicePortMapping } from '@ninedeploy/db';
import type { ServiceHttpRoute, ServicePortRoute, ServiceRoutingView } from '@ninedeploy/schemas';
import { capture } from '../lib/exec.js';
import { FIRST_INNER_PORT, portProxyName, restrictedMappings } from '../lib/portProxy.js';
import { swarmRuntimeOf } from '../lib/swarm.js';
import { generatedConfigPath } from './proxy.js';
import { replicaNames, MAX_REPLICAS } from './dockerNames.js';

/**
 * "Where does this service's traffic go right now": every domain through the
 * router Traefik was actually given (the written dynamic file, not what the
 * panel would render), and every host port through what Docker actually
 * bound — so a 502, a dead SIP port or a router still pointing at an old
 * container shows up as the hop that is wrong.
 */

type HttpRoute = ServiceHttpRoute;
type PortRoute = ServicePortRoute;
type RoutingView = ServiceRoutingView;

/** One container's facts from `docker inspect` (null when it does not exist). */
export interface ContainerFacts {
  state: string;
  health: string | null;
  ip: string | null;
  /** `5060/udp` → host bindings. */
  ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
}

export interface RoutingFacts {
  /** Parsed dynamic file, or null when it could not be read (node services, a missing file). */
  dynamic: unknown;
  container: ContainerFacts | null;
  portProxy: ContainerFacts | null;
  /** False for node and Swarm services: only the configuration is shown. */
  live: boolean;
  liveNote?: string;
}

type DomainRow = Pick<Domain, 'id' | 'hostname' | 'path' | 'ssl' | 'status'>;
type ServiceRow = Pick<Service, 'slug' | 'type' | 'runtimeId' | 'port' | 'status' | 'asleepAt' | 'publishedPort' | 'portMappings' | 'runtimeReplicas' | 'replicas'>;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Every server URL behind a Traefik service, following weighted splits (canary). */
function upstreamsOf(services: Record<string, unknown>, name: string, depth = 0): string[] {
  if (depth > 3) return [];
  const svc = obj(services[name]);
  const servers = obj(svc['loadBalancer'])['servers'];
  if (Array.isArray(servers)) return servers.map((s) => String(obj(s)['url'] ?? '')).filter(Boolean);
  const children = obj(svc['weighted'])['services'];
  if (Array.isArray(children)) return children.flatMap((c) => upstreamsOf(services, String(obj(c)['name'] ?? ''), depth + 1));
  return [];
}

function httpRoutes(service: ServiceRow, rows: DomainRow[], facts: RoutingFacts): HttpRoute[] {
  const http = obj(obj(facts.dynamic)['http']);
  const routers = obj(http['routers']);
  const services = obj(http['services']);
  const expected = service.runtimeId && service.port
    ? replicaNames(service.type === 'pm2' ? 'host.docker.internal' : service.runtimeId,
      service.type === 'docker' ? Math.max(1, Math.min(service.runtimeReplicas ?? service.replicas ?? 1, MAX_REPLICAS)) : 1)
      .map((n) => `http://${n}:${service.port}`)
    : [];
  return rows.map((d) => {
    const base = { domainId: d.id, hostname: d.hostname, path: d.path ?? null, ssl: d.ssl };
    if (d.status !== 'active') return { ...base, router: null, upstreams: [], verdict: 'warn' as const, note: `Domain is ${d.status}: Traefik is not given a route until it is verified` };
    if (!service.runtimeId || !service.port) return { ...base, router: null, upstreams: [], verdict: 'error' as const, note: 'No running container to route to (deploy the service first)' };
    const key = `${service.slug}_${d.id}`;
    if (facts.dynamic == null) {
      return { ...base, router: key, upstreams: expected, verdict: 'unknown' as const,
        note: facts.live ? 'The Traefik dynamic file could not be read' : 'Routed by the node\'s own Traefik; the expected upstream is shown' };
    }
    const router = obj(routers[key]);
    if (!router['rule']) return { ...base, router: null, upstreams: [], verdict: 'error' as const, note: 'Traefik has no router for this domain — requests answer 404', problem: 'no_router' as const };
    const upstreams = upstreamsOf(services, String(router['service'] ?? ''));
    if (service.asleepAt != null) return { ...base, router: key, upstreams, verdict: 'ok' as const, note: 'Service is asleep: requests go to the wake endpoint first' };
    const stale = upstreams.filter((u) => !expected.includes(u) && !u.startsWith('http://host.docker.internal'));
    if (upstreams.length === 0) return { ...base, router: key, upstreams, verdict: 'error' as const, note: 'The router has no upstream — requests answer 502', problem: 'no_upstream' as const };
    if (stale.length === upstreams.length) {
      return { ...base, router: key, upstreams, verdict: 'error' as const, note: `Traefik still routes to ${stale.join(', ')}, not the live runtime ${service.runtimeId}`, problem: 'stale_upstream' as const };
    }
    if (facts.live && facts.container && facts.container.state !== 'running') {
      return { ...base, router: key, upstreams, verdict: 'error' as const, note: `The container is ${facts.container.state} — requests answer 502 Bad Gateway`, problem: 'container_down' as const };
    }
    if (facts.live && facts.container?.health === 'unhealthy') {
      return { ...base, router: key, upstreams, verdict: 'warn' as const, note: 'The container reports unhealthy' };
    }
    return { ...base, router: key, upstreams, verdict: 'ok' as const, note: stale.length ? 'A canary or old generation also receives a share' : '' };
  });
}

const sameIp = (bound: string, wanted: string | null) => !wanted ? bound === '0.0.0.0' || bound === '::' || bound === '' : bound === wanted;

function bindingsFor(c: ContainerFacts | null, containerPort: number, protocol: string, hostPort: number, hostIp: string | null) {
  const list = c?.ports[`${containerPort}/${protocol}`] ?? [];
  return (list ?? []).filter((b) => Number(b.HostPort) === hostPort && sameIp(b.HostIp, hostIp));
}

function portRoute(m: ServicePortMapping, via: PortRoute['via'], facts: RoutingFacts, proxyInner?: number): PortRoute {
  const protocol = m.protocol ?? 'tcp';
  const base = { protocol, hostIp: m.hostIp ?? null, hostPort: m.hostPort, hostPortEnd: m.hostPortEnd ?? null, containerPort: m.containerPort,
    via, allowFrom: m.allowFrom ?? null };
  if (!facts.live) return { ...base, bound: null, verdict: 'unknown', note: 'Bound on the node; open the node to inspect it' };
  const owner = via === 'portproxy' ? facts.portProxy : facts.container;
  if (!owner) {
    return via === 'portproxy'
      ? { ...base, bound: [], verdict: 'error', note: 'The port proxy container is missing — the port is closed', problem: 'proxy_missing' }
      : { ...base, bound: [], verdict: 'error', note: 'No container: nothing listens on this port', problem: 'container_down' };
  }
  if (owner.state !== 'running') {
    return { ...base, bound: [], verdict: 'error', note: `The ${via === 'portproxy' ? 'port proxy' : 'container'} is ${owner.state}`,
      problem: via === 'portproxy' ? 'proxy_missing' : 'container_down' };
  }
  const count = Math.max(1, (m.hostPortEnd ?? m.hostPort) - m.hostPort + 1);
  const bound: string[] = [];
  let missing = 0;
  for (let i = 0; i < count; i++) {
    const inner = via === 'portproxy' ? proxyInner! : m.containerPort + i;
    const hits = bindingsFor(owner, inner, protocol, m.hostPort + i, m.hostIp ?? null);
    if (hits.length === 0) missing++;
    if (bound.length < 20) for (const b of hits) bound.push(`${b.HostIp || '*'}:${b.HostPort}/${protocol}`);
  }
  if (missing > 0) return { ...base, bound, verdict: 'error', note: `${missing} of ${count} host port(s) are not bound — redeploy to publish them`, problem: 'unbound' };
  const note = via === 'portproxy'
    ? 'Through the allow-list proxy: the app sees the proxy\'s address, not the client\'s'
    : protocol === 'udp' ? 'Docker DNAT: datagrams keep the client\'s source IP (SIP/RTP safe)' : 'Docker DNAT: the app sees the client\'s source IP';
  return { ...base, bound, verdict: 'ok', note };
}

export function buildRoutingView(service: ServiceRow, rows: DomainRow[], facts: RoutingFacts): RoutingView {
  const ports: PortRoute[] = [];
  if (service.publishedPort && service.port) {
    ports.push(portRoute({ hostPort: service.publishedPort, containerPort: service.port, protocol: 'tcp' }, 'direct', facts));
  }
  const restricted = restrictedMappings(service.portMappings);
  for (const m of service.portMappings ?? []) {
    const i = restricted.indexOf(m);
    // The sidecar listens on FIRST_INNER_PORT + i and publishes hostPort to it.
    ports.push(i >= 0 ? portRoute(m, 'portproxy', facts, FIRST_INNER_PORT + i) : portRoute(m, 'docker', facts));
  }
  return {
    live: facts.live,
    liveNote: facts.live ? null : facts.liveNote ?? 'This service runs on a node: domains are routed by the node\'s Traefik and ports are bound there',
    container: facts.container && service.runtimeId
      ? { name: service.runtimeId, state: facts.container.state, health: facts.container.health, ip: facts.container.ip }
      : null,
    http: httpRoutes(service, rows, facts),
    ports,
  };
}

export async function inspectRoutingContainer(name: string): Promise<ContainerFacts | null> {
  try {
    const raw = JSON.parse(await capture('docker', ['inspect', '--type', 'container', name])) as Array<Record<string, any>>;
    const c = raw[0];
    if (!c) return null;
    const networks = obj(c['NetworkSettings']?.['Networks']);
    const ip = String(obj(networks['ninedeploy'])['IPAddress'] ?? '') || Object.values(networks).map((n) => String(obj(n)['IPAddress'] ?? '')).find(Boolean) || null;
    return {
      state: String(c['State']?.['Status'] ?? 'unknown'),
      health: c['State']?.['Health']?.['Status'] ?? null,
      ip,
      ports: (c['NetworkSettings']?.['Ports'] ?? {}) as ContainerFacts['ports'],
    };
  } catch {
    return null;
  }
}

/** Gather the live facts (local services only) and build the view. */
export async function serviceRoutingView(db: DB, service: Service): Promise<RoutingView> {
  const rows = await db.select().from(domains).where(eq(domains.serviceId, service.id));
  if (service.serverId != null) return buildRoutingView(service, rows, { dynamic: null, container: null, portProxy: null, live: false });
  let dynamic: unknown = null;
  try {
    dynamic = yaml.load(readFileSync(generatedConfigPath(), 'utf8'));
  } catch {
    dynamic = null;
  }
  // A Swarm service's runtime is a Swarm service, not a container: its tasks
  // and the ingress mesh publish the ports, so only the routes are read.
  if (swarmRuntimeOf(service)) {
    return buildRoutingView(service, rows, { dynamic, container: null, portProxy: null, live: false,
      liveNote: 'Swarm service: ports are published by the Swarm ingress, not one container' });
  }
  const local = service.type === 'docker' || service.type === 'compose';
  const [container, portProxy] = await Promise.all([
    local && service.runtimeId ? inspectRoutingContainer(service.runtimeId) : Promise.resolve(null),
    restrictedMappings(service.portMappings).length > 0 ? inspectRoutingContainer(portProxyName(service.slug)) : Promise.resolve(null),
  ]);
  return buildRoutingView(service, rows, { dynamic, container, portProxy, live: true });
}
