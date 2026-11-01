import { load } from 'js-yaml';
import type { ServingTrafficOpen } from '@ninedeploy/schemas';

type Dict = Record<string, unknown>;
const dict = (value: unknown): value is Dict => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Zero traffic is meaningful only when the selected serving leaves are routed. */
export function servingTrafficRoutesMatch(input: ServingTrafficOpen): boolean {
  try {
    const document = load(input.routingConfig);
    if (!dict(document) || !dict(document.http) || !dict(document.http.routers) || !dict(document.http.services)) return false;
    const expected = new Set(input.serving.map(target => `http://${target.name}:${target.port}`));
    let primary = false;
    for (const [name, router] of Object.entries(document.http.routers)) {
      if (!name.startsWith(`${input.slug}_`)) continue;
      const suffix = name.slice(input.slug.length + 1);
      if (!/^\d+(?:_http|_bypass)?$/.test(suffix)) continue;
      if (suffix.endsWith('_bypass') || !dict(router) || typeof router.service !== 'string') return false;
      const reference = router.service.endsWith('@file') ? router.service.slice(0, -5) : router.service;
      const service = document.http.services[reference];
      if (!dict(service) || !dict(service.loadBalancer) || !Array.isArray(service.loadBalancer.servers)) return false;
      const servers = service.loadBalancer.servers;
      if (servers.length !== expected.size || !servers.every(server => dict(server) && typeof server.url === 'string' && expected.has(server.url)) ||
        new Set(servers.map(server => (server as Dict).url)).size !== expected.size) return false;
      if (/^\d+$/.test(suffix)) primary = true;
    }
    return primary;
  } catch { return false; }
}
