import { and, eq, isNull, ne } from 'drizzle-orm';
import { databasePublicAccess, type DB, type ServicePortMapping, services } from '@ninedeploy/db';
import { formatPortMapping, portMappingsOverlap } from '@ninedeploy/schemas';
import { config } from '../config.js';
import { forbidden } from './errors.js';
import type { AuthedUser } from './resourceAccess.js';

/**
 * L-6: `publishedPort` becomes `docker run -p <port>:<containerPort>` on the
 * HOST (`engine/builders/docker.ts`), so it spends a host-wide resource that no
 * other tenant can then use. The schema accepts 1-65535 because an admin
 * legitimately needs the whole range; a member does not.
 *
 * Two concrete abuses this closes:
 *
 *   • Privileged ports (<1024). Under the systemd install the panel runs as
 *     root, so a member could bind 25 (SMTP), 53 (DNS), 389 (LDAP) — services
 *     the rest of the network trusts by port number.
 *   • Racing the infrastructure. Docker publishes on first-come-first-served,
 *     so a member who claims the panel's own port, or 80/443, wins it after a
 *     host reboot and serves their container where the panel or Traefik used
 *     to answer.
 *
 * Reserved ports are refused for BOTH roles: an admin taking the panel's port
 * by accident is an outage, not an attack, and the error explains it.
 */

/** Ports that would displace NineDeploy's own listeners. */
export function reservedHostPorts(): number[] {
  return [
    config.port, // the panel API itself
    80, // Traefik web entrypoint
    443, // Traefik websecure entrypoint
    22, // host SSH — losing this locks the operator out
  ];
}

/**
 * Throw unless `user` may bind `port` on the host.
 * `null`/`undefined` means "no host port", which is always allowed.
 *
 * After the team overhaul, the operator-equivalent check is "is the user
 * owner/admin in at least one workspace" (`user.isOperator`).
 */
export function assertMayPublishPort(user: AuthedUser, port: number | null | undefined): void {
  if (port === null || port === undefined) return;

  if (reservedHostPorts().includes(port)) {
    throw forbidden(
      `Host port ${port} is reserved by NineDeploy (panel, Traefik or SSH) and cannot be published by a service.`,
    );
  }
  if (user.isOperator) return;
  if (port < 1024) {
    throw forbidden(
      `Operator access required: host ports below 1024 are privileged. Publish on ${port + 1024} or above, or route the service through a domain instead.`,
    );
  }
}

/**
 * 0.16.1 port mappings: the same rules as one published port, over every
 * port of every range. Reserved ports are refused for both protocols.
 */
export function assertMayPublishMappings(user: AuthedUser, mappings: readonly ServicePortMapping[] | null | undefined): void {
  for (const m of mappings ?? []) {
    const end = m.hostPortEnd ?? m.hostPort;
    const reserved = reservedHostPorts().find((p) => p >= m.hostPort && p <= end);
    if (reserved !== undefined) {
      throw forbidden(
        `Host port ${reserved} (in ${formatPortMapping(m)}) is reserved by NineDeploy (panel, Traefik or SSH) and cannot be published by a service.`,
      );
    }
    if (!user.isOperator && m.hostPort < 1024) {
      throw forbidden(`Operator access required: host ports below 1024 are privileged (${formatPortMapping(m)}).`);
    }
  }
}

/** A host socket range one owner holds. */
type PortClaim = { hostIp?: string | null; hostPort: number; hostPortEnd?: number | null; containerPort: number; protocol: 'tcp' | 'udp'; owner: string };

const claimsOf = (publishedPort: number | null | undefined, mappings: readonly ServicePortMapping[] | null | undefined, owner: string): PortClaim[] => [
  ...(publishedPort ? [{ hostPort: publishedPort, containerPort: publishedPort, protocol: 'tcp' as const, owner }] : []),
  ...(mappings ?? []).map((m) => ({ ...m, protocol: m.protocol ?? 'tcp', owner })),
];

/**
 * Why the host cannot publish these ports for `serviceId`, or null: the
 * direct port inside one of the service's own mappings, another service on
 * the same host (`serverId`, null = the panel host), or a database's public
 * access port (Traefik sidecars bind those on the panel host). Docker would
 * refuse the same at deploy time with "port is already allocated"; saying it
 * when the port is saved names the owner. `serviceId` 0 = a service being
 * created.
 */
export async function hostPortConflict(
  db: DB,
  serviceId: number,
  serverId: number | null | undefined,
  publishedPort: number | null | undefined,
  mappings: readonly ServicePortMapping[] | null | undefined,
): Promise<string | null> {
  const mine = claimsOf(publishedPort, mappings, '');
  if (mine.length === 0) return null;
  const own = publishedPort ? (mappings ?? []).find((m) => portMappingsOverlap(m, { hostPort: publishedPort, containerPort: publishedPort, protocol: 'tcp' })) : undefined;
  if (own) return `Host port ${publishedPort}/tcp is already this service's direct host port.`;
  const others = await db
    .select({ name: services.name, publishedPort: services.publishedPort, portMappings: services.portMappings })
    .from(services)
    .where(and(ne(services.id, serviceId), serverId == null ? isNull(services.serverId) : eq(services.serverId, serverId)));
  const taken: PortClaim[] = others.flatMap((s) => claimsOf(s.publishedPort, s.portMappings, `service "${s.name}"`));
  if (serverId == null) {
    const publicDbs = await db.select({ port: databasePublicAccess.publicPort }).from(databasePublicAccess);
    taken.push(...publicDbs.map((d) => ({ hostPort: d.port, containerPort: d.port, protocol: 'tcp' as const, owner: "a database's public access" })));
  }
  for (const c of mine) {
    const hit = taken.find((t) => portMappingsOverlap(c, t));
    if (hit) return `Host port ${Math.max(c.hostPort, hit.hostPort)}/${c.protocol} is already published by ${hit.owner}.`;
  }
  return null;
}
