import { eq } from 'drizzle-orm';
import { buildConfigs, type DB } from '@ninedeploy/db';
import { forbidden } from './errors.js';
import type { AuthedUser } from './resourceAccess.js';

/**
 * Which parts of a service definition amount to code execution on the HOST,
 * rather than inside an isolated container.
 *
 * The `member` role is a real privilege boundary: exec, the volume and
 * container file managers and exec-jobs are all admin-only because they give
 * host-level reach. Five deploy-path features gave a member the same reach
 * without going through any of those gates:
 *
 *   • PM2 services run `sh -c <installCmd>` / `<buildCmd>` on the host, and
 *     their start command becomes a host process (engine/builders/pm2.ts).
 *   • preDeploy / postDeploy / preStop hooks execute host binaries
 *     (engine/pipeline.ts).
 *   • Compose deploys run attacker-authored YAML, which can request
 *     `privileged: true` or bind-mount `/` (engine/builders/compose.ts).
 *   • A template with `dockerSocket` mounts /var/run/docker.sock into the
 *     container, which is equivalent to host root (engine/builders/docker.ts).
 *   • The `static` build pack runs `sh -c <installCmd>` / `<buildCmd>` on
 *     the host before containerising the output — same reach as PM2, hidden
 *     behind an innocent-looking `type: 'docker'` service
 *     (engine/builders/staticSite.ts).
 *
 * Reasons are returned rather than a bare boolean so the 403 can say WHICH
 * part of the request needs an admin — "forbidden" with no explanation on a
 * deploy form is a support ticket.
 */
export interface PrivilegeInput {
  type?: string | null;
  dockerSocket?: boolean | null;
  build?: {
    buildPack?: string | null;
    preDeployCmd?: string | null;
    postDeployCmd?: string | null;
    preStopCmd?: string | null;
  } | null;
}

export function hostPrivilegeReasons(input: PrivilegeInput): string[] {
  const reasons: string[] = [];
  if (input.type === 'pm2') {
    reasons.push('PM2 services run their install, build and start commands directly on the host');
  }
  if (input.type === 'compose') {
    reasons.push('Compose deploys run the repository’s compose file, which can mount host paths or request privileged containers');
  }
  if (input.build?.preDeployCmd || input.build?.postDeployCmd || input.build?.preStopCmd) {
    reasons.push('Deployment lifecycle hooks (pre-deploy / post-deploy / pre-stop) execute binaries on the host');
  }
  if (input.build?.buildPack === 'static') {
    reasons.push('The static build pack runs its install and build commands directly on the host');
  }
  if (input.dockerSocket) {
    reasons.push('This template mounts the Docker socket, which grants control of every container on the host');
  }
  return reasons;
}

/** Throw 403 (listing the reasons) unless the caller is an operator. */
export function assertMayUseHostPrivilege(user: AuthedUser, input: PrivilegeInput): void {
  if (user.isOperator) return;
  const reasons = hostPrivilegeReasons(input);
  if (reasons.length === 0) return;
  throw forbidden(`Operator access required: ${reasons.join('; ')}.`);
}

/**
 * Same decision for an ALREADY STORED service — used on the deploy path, so a
 * definition that predates this rule (or was created by an operator) cannot be
 * redeployed by a non-operator to obtain the same host execution.
 */
export async function assertMayDeployStoredService(
  db: DB,
  user: AuthedUser,
  service: { id: number; type: string; dockerSocket?: boolean | null },
): Promise<void> {
  if (user.isOperator) return;
  const build = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, service.id) });
  assertMayUseHostPrivilege(user, {
    type: service.type,
    dockerSocket: service.dockerSocket ?? false,
    build: build ?? null,
  });
}
