import type { BuildConfig, Service, ServiceVolumeAttachment } from '@ninedeploy/db';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import type { IBuildCache } from '../kernel/types.js';

export interface BuildContext {
  deploymentId: number;
  service: Service;
  buildConfig?: BuildConfig;
  /** Absolute path to the checked-out working copy. */
  workDir: string;
  /** Resolved commit SHA. */
  commitSha: string;
  /**
   * For image deploys: an explicit image digest to run instead of `service.image`
   * (used by rollback to pin the exact image). When absent, `service.image` is used.
   */
  imageDigest?: string;
  /** Environment variables to inject at runtime (service env vars + attached DB connection strings). */
  env: Record<string, string>;
  /**
   * Private-registry credentials (from a registry-type source): username +
   * password used to `docker login` before pulling the image. Absent for
   * public registries.
   */
  registryAuth?: { username: string; password: string; server?: string };
  /**
   * Remote server this service deploys to (null = this host).
   *
   * NOT IMPLEMENTED BY ANY BUILDER YET. docker, pm2 and compose all shell out
   * locally through `lib/exec.ts`, so a deploy with this set would land on the
   * panel host — `runDeployment` therefore refuses it outright
   * (`lib/remoteDeploy.ts`) rather than deploying to the wrong machine. The
   * field and the caller below stay as the seam a remote builder will use.
   */
  serverId?: number;
  /**
   * When serverId is set, the pipeline pre-binds this typed-op caller so
   * builders can run remote operations without touching the DB layer.
   * Currently unused — see the note on `serverId`. The typed agent protocol
   * itself is live: `modules/networks.ts` drives remote hosts through it.
   */
  agentCall?: (op: string, params: Record<string, unknown>, sink: (line: string) => void) => Promise<{ exitCode: number; lines: string[] }>;
  /**
   * Additional named volumes the service mounts alongside its primary
   * `service.volumeMount`. Persistence is handled by Docker; the builder
   * simply adds `-v <volumeName>:<containerPath>[:ro]` for each row. May
   * be empty (then the builder only mounts the primary, if set).
   */
  volumeAttachments?: ServiceVolumeAttachment[];
  /**
   * The repo's `.ninedeploy` manifest, when it ships one.
   *
   * The pipeline has already folded the manifest's `build.*` fields into
   * `buildConfig` (panel > manifest > auto-detect) before the builder sees
   * this, so a builder only needs the raw manifest for the sections that
   * cannot be expressed as a BuildConfig — `runtime` and `phases`, which the
   * Docker builder renders into a `nixpacks.toml`.
   */
  manifest?: NinedeployManifest;
  /** Append a log line (persisted + broadcast to subscribers). */
  log: (line: string) => void;
  /**
   * Sprint 4 G-01 PR-B: when the operator has `engine.use_buildkit`
   * turned on and a build cache is registered on the kernel, the
   * pipeline populates these two fields so the Docker builder can
   * route the build through `docker buildx` and consult the cache.
   * Absent on hosts that ship the legacy builder only.
   */
  useBuildKit?: boolean;
  buildCache?: IBuildCache;
  /**
   * Sink for `build.cache.*` observations, supplied by the worker so the
   * events carry the key the build actually consulted. The BuildCachePlugin
   * used to synthesise its own key (`service:<id>:no-commit`) that nothing
   * ever stored under, so every deploy published a `miss` that could not
   * have been anything else.
   */
  onBuildCacheEvent?: (event: import('./builders/buildkit.js').BuildCacheEvent) => void;
}

/** Identifies a running workload so the engine can stop/inspect it later. */
export interface DeployRuntime {
  /** Docker container name or PM2 process name. */
  runtimeId: string;
  port: number | null;
  healthPath: string;
  /** Resolved image digest the runtime is actually running (for exact rollback). */
  imageDigest?: string;
  /** Replica count the deploy actually achieved (primary included). The
   * proxy renders this — never the desired count — so a replica that failed
   * to start does not linger as a dead round-robin backend. */
  replicas?: number;
}

/** A runtime backend (Docker / PM2). Implementations live in ./builders. */
export interface Builder {
  buildAndRun(ctx: BuildContext, previous?: DeployRuntime): Promise<DeployRuntime>;
  isHealthy(runtime: DeployRuntime, timeoutMs?: number, directGraceMs?: number, log?: (line: string) => void): Promise<boolean>;
  stop(runtimeId: string, opts?: { graceSeconds?: number }): Promise<void>;
}
