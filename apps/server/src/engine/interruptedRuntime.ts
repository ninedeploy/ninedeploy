import { capture, run } from '../lib/exec.js';
import { DEPLOYMENT_LABEL, MAX_REPLICAS, SERVICE_LABEL, replicaNames } from './dockerNames.js';

/**
 * r593: remove the containers a LOCAL docker deployment had already started
 * when a panel restart interrupted it.
 *
 * The r524 boot recovery fails such a deployment, but the pipeline that would
 * have stopped its blue-green candidate died with the old process — the "new"
 * container kept running untracked: no later deploy names it again (they get
 * new deployment ids), and with a published host port it holds the port so
 * the next deploy fails "port is already allocated".
 *
 * Exactly what the pipeline's own failure path would have removed, and
 * nothing else:
 *   - only containers carrying BOTH this deployment's and this service's
 *     labels (the docker builder sets them from 0.10.38 on — an older,
 *     unlabelled container is never matched, never guessed at by name);
 *   - never the service's current runtime (services.runtimeId) nor its
 *     replicas, whatever their labels say;
 *   - nothing at all when the current runtime no longer exists: a
 *     host-port service retires its previous runtime BEFORE starting the
 *     candidate, so there the candidate may be the only thing serving.
 *
 * Best-effort: the docker daemon being unreachable at boot leaves the
 * containers for the operator, it never fails the recovery. Returns the names
 * it removed.
 */
export async function removeInterruptedCandidates(
  deploymentId: number,
  serviceId: number,
  currentRuntimeId: string | null,
): Promise<string[]> {
  let names: string[];
  try {
    names = (
      await capture('docker', [
        'ps',
        '-a',
        '--filter',
        `label=${DEPLOYMENT_LABEL}=${deploymentId}`,
        '--filter',
        `label=${SERVICE_LABEL}=${serviceId}`,
        '--format',
        '{{.Names}}',
      ])
    )
      .split(/\r?\n/)
      .map((n) => n.trim().replace(/^\//, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
  const keep = new Set(currentRuntimeId ? replicaNames(currentRuntimeId, MAX_REPLICAS) : []);
  const victims = names.filter((n) => !keep.has(n));
  if (victims.length === 0) return [];
  if (currentRuntimeId) {
    try {
      await capture('docker', ['inspect', '--format', '{{.State.Status}}', currentRuntimeId]);
    } catch {
      // The previous runtime is gone (or the daemon blinked): the candidate
      // may be all that serves this service — leave it.
      return [];
    }
  }
  try {
    await run('docker', ['rm', '-f', ...victims], {}, () => undefined);
  } catch {
    return [];
  }
  return victims;
}
