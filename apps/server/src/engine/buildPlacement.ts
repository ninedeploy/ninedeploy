import type { DB } from '@ninedeploy/db';

/**
 * Build placement (multi-node): where a service's image is built — where it
 * runs (`target`, today), on the panel host, or on a build server — before it
 * is shipped to every host that runs it.
 *
 * Design: .temp_files/run_0.16/DESIGN.md §6.2, §6.3. Owner: task T4.
 *
 * T1 stub, called from the pipeline (mount point M5, block `0.16 T4 build
 * placement`). It answers `target` for every service, so every deploy builds
 * where it runs exactly as in 0.15; T4 replaces the body.
 */

export type BuildPlacement =
  /** Build where the service runs (NULL `build_on`, every pre-0072 row). */
  | { kind: 'target' }
  /** Build on the panel host, then ship. */
  | { kind: 'panel' }
  /** Build on the build server `serverId`, then ship. */
  | { kind: 'server'; serverId: number };

export async function resolveBuildPlacement(
  _db: DB,
  _service: { id: number; serverId?: number | null },
): Promise<BuildPlacement> {
  return { kind: 'target' };
}
