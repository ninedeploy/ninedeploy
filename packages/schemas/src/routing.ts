/**
 * `GET /v1/services/:id/routing`: where a service's traffic goes right now —
 * each domain through the router Traefik was actually given, each host port
 * through what Docker actually bound.
 */

export type RoutingHopVerdict = 'ok' | 'warn' | 'error' | 'unknown';

export interface ServiceHttpRoute {
  domainId: number;
  hostname: string;
  path: string | null;
  ssl: boolean;
  /** Traefik router name, null when Traefik has none for this domain. */
  router: string | null;
  /** Server URLs behind the router (`http://<container>:<port>`). */
  upstreams: string[];
  verdict: RoutingHopVerdict;
  note: string;
  /** Why the hop fails, for checks that act on it (the Doctor); absent when nothing is wrong with the route itself. */
  problem?: 'no_router' | 'no_upstream' | 'stale_upstream' | 'container_down';
}

export interface ServicePortRoute {
  protocol: 'tcp' | 'udp';
  hostIp: string | null;
  hostPort: number;
  hostPortEnd: number | null;
  containerPort: number;
  /** `docker`: `-p` DNAT (keeps the client's source IP); `portproxy`: the allow-list sidecar; `direct`: the service's published port. */
  via: 'docker' | 'portproxy' | 'direct';
  allowFrom: string[] | null;
  /** Host sockets Docker bound (`ip:port/proto`); null when the host was not inspected. */
  bound: string[] | null;
  verdict: RoutingHopVerdict;
  note: string;
  /** Why the hop fails; absent when the port is bound (or was not inspected). */
  problem?: 'unbound' | 'container_down' | 'proxy_missing';
}

export interface ServiceRoutingView {
  /** False for a service on a node: the configuration is shown, not inspected. */
  live: boolean;
  liveNote: string | null;
  container: { name: string; state: string; health: string | null; ip: string | null } | null;
  http: ServiceHttpRoute[];
  ports: ServicePortRoute[];
}
