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
