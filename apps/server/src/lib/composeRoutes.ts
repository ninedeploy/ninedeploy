import yaml from 'js-yaml';
import { eq } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';
import { composeRoute, type ComposeRoute } from '@ninedeploy/schemas';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G2.1 a domain per compose service. By default every domain of a compose
 * stack routes to its main service (`services.composeService`). A domain can
 * name another service of the stack, and its port, instead; Traefik already
 * shares the project's default network, so it reaches that container by the
 * name compose gives it, `ndcmp-<slug>-<service>-1`.
 *
 * No migration: `compose_route:<domainId>` holds `{ service, port }`. The
 * proxy render reads every row in one query (lib/maintenance.ts
 * `routingOverrides`).
 */

export const COMPOSE_ROUTE_PREFIX = 'compose_route:';
const key = (domainId: number) => `${COMPOSE_ROUTE_PREFIX}${domainId}`;

export function parseComposeRoute(raw: unknown): ComposeRoute | null {
  const parsed = composeRoute.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function getComposeRoute(db: DB, domainId: number): Promise<ComposeRoute | null> {
  return parseComposeRoute(await getSettingJson<unknown>(db, key(domainId), null));
}

export async function setComposeRoute(db: DB, domainId: number, route: ComposeRoute | null): Promise<void> {
  if (!route) await db.delete(settings).where(eq(settings.key, key(domainId)));
  else await setSettingJson(db, key(domainId), composeRoute.parse(route));
}

/** The container compose runs for one service of the stack (the first replica). */
export function composeServiceContainer(slug: string, service: string): string {
  return `ndcmp-${slug}-${service}-1`;
}

/**
 * Whether `ndcmp-<slug>-<service>-1` could also be ANOTHER stack's container:
 * a stack `shop` routing to `x-web` names `ndcmp-shop-x-web-1`, which is the
 * `web` container of a stack `shop-x`. Traefik shares every stack's network,
 * so such a route would reach someone else's service. Refused when saved and
 * skipped (main service) when rendered.
 */
export function composeRouteCollides(slug: string, service: string, composeSlugs: Iterable<string>): boolean {
  const name = `${slug}-${service}`;
  for (const other of composeSlugs) {
    if (other !== slug && other.startsWith(`${slug}-`) && name.startsWith(`${other}-`)) return true;
  }
  return false;
}

/** The services an inline compose file declares, or null when it cannot be read. */
export function inlineComposeServices(content: string | null | undefined): string[] | null {
  if (!content) return null;
  try {
    const doc = yaml.load(content) as { services?: Record<string, unknown> } | null;
    return doc && doc.services && typeof doc.services === 'object' ? Object.keys(doc.services) : null;
  } catch {
    return null;
  }
}

/** The variable suffix of a compose service name: upper case, anything else as `_`. */
export function composeServiceKey(service: string): string {
  return service.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * The per-service magic variables of a compose stack: for each active domain
 * routed to another service of the stack, `SERVICE_FQDN_<SERVICE>` (the host)
 * and `SERVICE_URL_<SERVICE>` (scheme, host and path). A variable the service
 * already sets keeps its value.
 */
export async function composeRouteEnv(
  db: DB,
  serviceId: number,
  existing: Record<string, string>,
): Promise<Record<string, string>> {
  const rows = await db.query.domains.findMany({ where: (d, { and: both, eq: is }) => both(is(d.serviceId, serviceId), is(d.status, 'active')) });
  const out: Record<string, string> = {};
  for (const d of rows) {
    const route = await getComposeRoute(db, d.id);
    if (!route || String(d.hostname).startsWith('*.')) continue;
    const name = composeServiceKey(route.service);
    const path = String(d.path ?? '').replace(/\/+$/, '');
    const fqdn = `SERVICE_FQDN_${name}`;
    const url = `SERVICE_URL_${name}`;
    if (!(fqdn in existing) && !(fqdn in out)) out[fqdn] = String(d.hostname);
    if (!(url in existing) && !(url in out)) out[url] = `${d.ssl ? 'https' : 'http'}://${d.hostname}${path}`;
  }
  return out;
}
