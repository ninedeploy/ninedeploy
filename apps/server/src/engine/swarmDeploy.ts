/**
 * Swarm deploy flow (multi-node): build, distribute the image, `docker stack
 * deploy`, wait for convergence, route through the overlay.
 *
 * Design: .temp_files/run_0.16/DESIGN.md §7.3, §7.4. Owner: task T7.
 *
 * T1 stub, called from the pipeline (mount point M5, block `0.16 T7 swarm`).
 * `isSwarmService` answers false for every service, so no deploy reaches the
 * Swarm branch and every service runs plain containers as in 0.15. T7 makes
 * it read `services.orchestrator` and adds `swarmDeploy`.
 */
export function isSwarmService(_service: { orchestrator?: string | null }): boolean {
  return false;
}
