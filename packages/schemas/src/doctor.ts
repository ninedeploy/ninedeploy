import { z } from 'zod';

/** One actionable observation from a Doctor scan. `id` is deterministic
 *  (`kind:target`) so a fix request can re-scan, re-locate the finding against
 *  FRESH state and only then execute — a stale report can never drive a
 *  destructive action against a target that stopped qualifying in between. */
export const doctorSeverity = z.enum(['info', 'warn', 'critical']);
export type DoctorSeverity = z.infer<typeof doctorSeverity>;

export const doctorTargetType = z.enum([
  'container',
  'volume',
  'network',
  'image',
  'database',
  'service',
  'deployment',
  'host',
  // Rows identified by a stored `slug` (see the invalid_slug finding).
  'project',
  'workspace',
  'tunnel',
  'oidc_provider',
]);
export type DoctorTargetType = z.infer<typeof doctorTargetType>;

export const doctorFindingKind = z.enum([
  /** A Hub-family container sat exited with no live row claiming it. */
  'exited_container',
  /** A managed volume (nd-svc-/nd-db-) no row owns any more. */
  'orphan_volume',
  /** A per-slug bridge or compose-project network nothing uses any more. */
  'orphan_network',
  /** Dangling `<none>` images (safe, uncontroversial reclaim). */
  'dangling_images',
  /** Builder cache beyond the noise threshold. */
  'build_cache',
  /** Disk usage crossed the warning / critical line. */
  'disk_pressure',
  /** Database row says running, the container disagrees. */
  'database_down',
  /** Database stuck in `creating` — provisioning never finished. */
  'database_stuck',
  /** Service row says running, its runtime container is gone or exited. */
  'service_runtime_desync',
  /** A deploy row stuck in queued/building far past any live window. */
  'stuck_deployment',
  /**
   * A stored `slug` that violates the canonical `slug` contract — legacy rows
   * written before slugify was fixed (r028 stranded a trailing hyphen, r029 a
   * one-character slug), or a hand-written `input.slug` the create route stored
   * without re-validating. Such a row is a record its own API rejects on PATCH.
   */
  'invalid_slug',
  /**
   * r575: the panel's own port listens on a non-loopback address over plain
   * HTTP (bare-metal default 0.0.0.0:3000) — logins and API tokens crossing
   * it are readable on the network. Advisory: changing the bind is the
   * operator's call (it cuts off whoever reaches the panel at http://ip:3000).
   */
  'panel_plaintext_exposure',
  /**
   * r600: enabled sandbox plugins on a Node whose permission model has no
   * network scope (< 25) — their code can reach anything the host can.
   * Advisory: they keep loading (upgrade-safe); upgrading Node closes it.
   */
  'sandbox_plugin_network',
  /**
   * r620: a stored repository analysis holds a nodeVersion that is not a
   * version — host file content captured through a symlinked .nvmrc before
   * 0.10.41. Critical: the exposed secrets must be rotated.
   */
  'repo_insights_leak',
  /**
   * r655: the Hub's remote template registry is fetched over plain http, so
   * anyone on the path can swap the catalog (images, env defaults). Advisory:
   * the source keeps loading (upgrade-safe); new http sources are refused.
   */
  'templates_source_plaintext',
  /**
   * A container a deploy started (it carries that deployment's labels) that
   * is not the service's live generation, while nothing owns it any more: no
   * deploy in flight, no routing transition pending. A failed or cancelled
   * candidate whose cleanup did not land — often still holding host ports.
   * App containers are `<slug>-<deploymentId>`, outside the `nd-` family the
   * exited-container check guards on, so nothing reported them before.
   */
  'deploy_leftover_container',
  /** Service row says running, its container exists but is stopped (a host-port deploy that never restarted it). */
  'service_runtime_stopped',
  /** An HTTP domain routes to a port the service only publishes as UDP: Traefik answers every request with 502. */
  'domain_on_udp_port',
  /** The HTTP readiness probe can never pass on a UDP-only port: every deploy fails at the healthcheck timeout. */
  'healthcheck_unpassable',
  /** A port mapping binds to an IP this host does not have: `docker run` fails with "cannot assign requested address". */
  'port_host_ip_missing',
  /** Two services publish the same host port (protocol + address): the second deploy fails "port is already allocated". */
  'host_port_conflict',
  /** Many published host ports while Docker's userland proxy is on: one docker-proxy process per port. */
  'userland_proxy_ports',
]);
export type DoctorFindingKind = z.infer<typeof doctorFindingKind>;

/** Executable repair actions. Every one re-validates its precondition against
 *  current state inside the fix path; the enum is the full surface. */
export const doctorActionKind = z.enum([
  'remove_container',
  'delete_volume',
  'remove_network',
  'prune_dangling_images',
  'prune_build_cache',
  'run_autoprune',
  'start_database',
  'mark_database_error',
  'sync_service',
  'cancel_deployment',
  /**
   * Rewrite a stored `slug` that violates the canonical contract. Only offered
   * for tables whose slug is NOT also a live Docker identity — renaming a
   * service/database/tunnel row alone would desync it from its bridge,
   * container and volume, so those findings stay advisory with a manual step.
   */
  'repair_slug',
  /** Remove a deploy's leftover container (re-validated: still not live, still unowned). */
  'remove_deploy_leftover',
  /** Start the stopped generation of a running service (primary + replicas). */
  'start_service_runtime',
  /** Switch a service whose HTTP probe cannot pass to the `running` readiness check. */
  'set_healthcheck_running',
]);
export type DoctorActionKind = z.infer<typeof doctorActionKind>;

export const doctorFinding = z.object({
  id: z.string(),
  kind: doctorFindingKind,
  severity: doctorSeverity,
  title: z.string(),
  detail: z.string(),
  target: z.object({
    type: doctorTargetType,
    name: z.string().nullable(),
    id: z.number().nullable(),
  }),
  /** Null when the finding is advisory only (no automated repair). */
  action: doctorActionKind.nullable(),
  sizeBytes: z.number().nullable(),
});
export type DoctorFinding = z.infer<typeof doctorFinding>;

export const doctorHostFacts = z.object({
  diskUsedPercent: z.number(),
  diskTotalBytes: z.number(),
  diskFreeBytes: z.number(),
  dockerImagesBytes: z.number().nullable(),
  dockerVolumesBytes: z.number().nullable(),
  dockerBuildCacheBytes: z.number().nullable(),
});
export type DoctorHostFacts = z.infer<typeof doctorHostFacts>;

export const doctorReport = z.object({
  generatedAt: z.string().datetime(),
  healthy: z.boolean(),
  totals: z.object({
    findings: z.number(),
    critical: z.number(),
    warn: z.number(),
    info: z.number(),
    reclaimableBytes: z.number(),
  }),
  host: doctorHostFacts,
  findings: z.array(doctorFinding),
});
export type DoctorReport = z.infer<typeof doctorReport>;

export const doctorFixRequest = z.object({
  findingId: z.string().min(1),
});
export type DoctorFixRequest = z.infer<typeof doctorFixRequest>;
export type DoctorFixRequestInput = DoctorFixRequest;

export const doctorFixResponse = z.object({
  fixed: z.boolean(),
  id: z.string(),
  action: doctorActionKind,
  log: z.array(z.string()),
  report: doctorReport,
});
export type DoctorFixResponse = z.infer<typeof doctorFixResponse>;
