import type { Builder, BuildContext, DeployRuntime } from '../types.js';
import { assertCloneTargetAllowed } from '../../lib/gitEgress.js';

/**
 * Remote Docker builder — deploys a service onto a registered node through the
 * typed agent protocol.
 *
 * Why this exists
 * ---------------
 * `server_id` has been on the services table, on the Servers page and in the
 * BuildContext since the fleet feature shipped, and no builder ever read it:
 * docker, pm2 and compose all shell out locally through `lib/exec.ts`. A
 * service pinned to a node would therefore have been built and started on the
 * PANEL host while the panel, the Servers page and the deploy log all reported
 * the node. `lib/remoteDeploy.ts` refused the deploy outright rather than put
 * the container on the wrong machine; this builder is what finally makes the
 * refusal unnecessary for the shape it covers.
 *
 * Ingress model
 * -------------
 * Each node runs its OWN Traefik (`proxy.ensure` on the agent) and terminates
 * TLS for the services that live on it — the operator points the domain at the
 * node, not at the panel. Production traffic therefore never hairpins through
 * the panel host, which is what makes multi-node worth having. The container
 * joins the node's `ninedeploy` network and the node's Traefik reaches it by
 * container name, exactly as the panel's own Traefik does locally, so no host
 * port has to be published for a domain to work.
 *
 * What this covers, and what it refuses
 * -------------------------------------
 * Covered: `docker` services that run a pre-built IMAGE, and those that build a
 * Dockerfile from a git repository.
 *
 * Refused, loudly, rather than silently mishandled:
 *   - Nixpacks (Dockerfile-less source). Nixpacks is not installed on a node
 *     and the agent has no op for it; the honest fix is either an agent-side
 *     nixpacks or a panel-side build pushed to a registry, and neither is a
 *     thing this builder should fake.
 *   - PM2 and Compose services. The agent has no PM2 op at all, and a Compose
 *     stack needs its file materialised on the node first.
 * Each refusal throws with a message naming the reason, so the deployment fails
 * recoverably with an explanation instead of landing somewhere unexpected.
 *
 * Health
 * ------
 * Remote health is CONTAINER STATE, not an HTTP probe: the panel sits outside
 * the node's Docker network and cannot reach the container, and publishing a
 * host port purely to be probed would expose every remote service on the node's
 * public interface. `isHealthy` polls `docker.inspect` until the container
 * reports `running` and stays there. This is a weaker signal than the local
 * builder's HTTP probe and the deploy log says so.
 */

/** The typed-op caller the pipeline binds for a service pinned to a node. */
export type AgentCall = (
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
) => Promise<{ exitCode: number; lines: string[] }>;

/** Thrown for a service shape this builder deliberately does not handle. */
export class RemoteDeployUnsupportedError extends Error {
  readonly code = 'remote_deploy_unsupported';
  constructor(message: string) {
    super(message);
    this.name = 'RemoteDeployUnsupportedError';
  }
}

/**
 * Container-state values `docker inspect --format '{{.State.Status}}'` can
 * report. Anything not in the "settled and healthy" set keeps the poll going.
 */
const TERMINAL_BAD = new Set(['exited', 'dead', 'removing']);

export function createRemoteDockerBuilder(agent: AgentCall): Builder {
  /** Parse the `state` inspect format: `<status>|<ip>`. */
  const parseState = (lines: string[]): { status: string; ip: string } => {
    const raw = lines.filter((l) => l.trim() !== '').at(-1) ?? '';
    const [status = '', ip = ''] = raw.trim().split('|');
    return { status, ip };
  };

  return {
    async buildAndRun(ctx: BuildContext, previous?: DeployRuntime): Promise<DeployRuntime> {
      void previous;
      const { service, buildConfig, deploymentId, commitSha, env, imageDigest, registryAuth, log } = ctx;

      if (service.type !== 'docker') {
        throw new RemoteDeployUnsupportedError(
          `Remote deployments support docker services only; "${service.name}" is a ${service.type} service. ` +
            'Clear the target server to deploy it on the panel host.',
        );
      }

      // The workspace name becomes a directory on the node and is validated
      // there too (`resolveWorkspace`), but failing here gives the operator a
      // message naming the service instead of an agent-side rejection.
      const workspace = service.slug;
      const name = `${service.slug}-${deploymentId}`;
      const sink = (line: string) => log(line);

      let target: string;
      if (service.image) {
        // Pre-built image (template / one-click). On rollback the deployment
        // row pins the exact digest, same as the local builder.
        target = imageDigest ?? service.image;
        if (registryAuth) {
          log(`Logging in to ${registryAuth.server || 'docker.io'} on the node …`);
          await agent(
            'docker.login',
            {
              username: registryAuth.username,
              password: registryAuth.password,
              ...(registryAuth.server ? { server: registryAuth.server } : {}),
            },
            sink,
          );
        }
        try {
          log(`Pulling ${target} on the node …`);
          await agent('docker.pull', { image: target }, sink);
        } finally {
          if (registryAuth) {
            await agent(
              'docker.logout',
              registryAuth.server ? { server: registryAuth.server } : {},
              sink,
            ).catch(() => undefined);
          }
        }
      } else {
        const pack = buildConfig?.buildPack ?? 'auto';
        if (pack === 'nixpacks') {
          throw new RemoteDeployUnsupportedError(
            'Nixpacks builds are not available on a remote node yet — the node has no nixpacks and the ' +
              'agent has no operation for it. Add a Dockerfile to the repository, or clear the target ' +
              'server to build on the panel host.',
          );
        }
        if (!service.repoUrl) {
          throw new RemoteDeployUnsupportedError(
            `"${service.name}" has neither an image nor a repository URL, so there is nothing to deploy on the node.`,
          );
        }

        // Same egress gate as a panel-side checkout (r099): the clone runs from
        // the NODE's network position — a cloud VM with its own metadata
        // service, or a LAN — and used to skip the check entirely.
        await assertCloneTargetAllowed(service.repoUrl);
        log(`Fetching ${service.repoUrl} into the node workspace "${workspace}" …`);
        await agent('git.ensure', { workspace, url: service.repoUrl, depth: '1' }, sink);
        if (service.branch) {
          await agent('git.fetch', { workspace }, sink);
          await agent('git.checkout', { workspace, ref: service.branch }, sink);
        }
        if (commitSha) {
          await agent('git.reset', { workspace, sha: commitSha }, sink);
        }

        target = `ninedeploy/${service.slug}:${commitSha.slice(0, 7) || 'latest'}`;
        const dockerfile = (buildConfig?.dockerfilePath || 'Dockerfile').replace(/^\/+/, '') || 'Dockerfile';
        const baseDir = (buildConfig?.baseDir || '.').replace(/^\/+/, '') || '.';
        log(
          'Remote builds require a Dockerfile — the node has no Nixpacks. ' +
            `Building ${target} from ${dockerfile} …`,
        );
        await agent('docker.build', { workspace, tag: target, dockerfile, context: baseDir }, sink);
      }

      // Environment reaches the node as a 0600 env-file written by the agent,
      // never as argv: `docker.runEnv` mounts it with --env-file, so no secret
      // is visible in the node's process table.
      const envFileName = `${service.slug}-${deploymentId}`;
      const wrote = await agent('file.writeEnv', { name: envFileName, env }, sink);
      const envFile =
        wrote.lines.find((l) => l.startsWith('wrote '))?.slice('wrote '.length) ??
        `.agent-env/${envFileName}.env`;

      const resolvedPort = service.port ?? null;
      const runParams: Record<string, unknown> = { name, image: target, envFile };
      if (service.cpuShares > 0) runParams['cpuShares'] = String(service.cpuShares);
      if (service.memLimitMb > 0) runParams['memLimitMb'] = String(service.memLimitMb);
      if (service.volumeMount) {
        runParams['volume'] = `nd-svc-${service.slug}-data`;
        runParams['mount'] = service.volumeMount;
      }
      // A published port is only needed for direct, domain-less access. Domain
      // traffic goes through the NODE's Traefik over the shared network, so the
      // common case publishes nothing.
      if (service.publishedPort && resolvedPort) {
        runParams['publish'] = `${service.publishedPort}:${resolvedPort}`;
      }

      log(`Starting ${name} on the node …`);
      try {
        await agent('docker.runEnv', runParams, sink);
      } finally {
        // The env-file has been consumed by `docker run`; leaving decrypted
        // secrets on the node's disk after that is pure exposure.
        await agent('file.deleteEnv', { name: envFileName }, sink).catch(() => undefined);
      }

      return {
        runtimeId: name,
        port: resolvedPort,
        healthPath: service.healthPath ?? '/',
        imageDigest: target,
      };
    },

    async isHealthy(
      runtime: DeployRuntime,
      timeoutMs = 300_000,
      directGraceMs = 10_000,
      log: (line: string) => void = () => undefined,
    ): Promise<boolean> {
      void directGraceMs;
      const deadline = Date.now() + timeoutMs;
      let reported = false;
      while (Date.now() < deadline) {
        try {
          const res = await agent(
            'docker.inspect',
            { name: runtime.runtimeId, format: 'state' },
            () => undefined,
          );
          const { status } = parseState(res.lines);
          if (status === 'running') {
            if (!reported) {
              log(
                `${runtime.runtimeId} is running on the node. Remote health is container state, not an ` +
                  'HTTP probe: the panel is outside the node network.',
              );
            }
            return true;
          }
          if (TERMINAL_BAD.has(status)) {
            log(`${runtime.runtimeId} reached state "${status}" on the node`);
            // Pull the container's own output so the failure is diagnosable
            // from the deploy log rather than only from the node.
            await agent('docker.logs', { name: runtime.runtimeId }, log).catch(() => undefined);
            return false;
          }
          reported = true;
        } catch (err) {
          // Inspect fails while the container is still being created, and also
          // when the node is briefly unreachable. Both are worth retrying
          // inside the deadline; the last failure is reported on timeout.
          log(`waiting for ${runtime.runtimeId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      log(`${runtime.runtimeId} did not reach a running state on the node within ${Math.round(timeoutMs / 1000)}s`);
      return false;
    },

    async stop(runtimeId: string, opts?: { graceSeconds?: number }): Promise<void> {
      // The agent's stop op pins `-t 5`; a per-service grace is a local-only
      // refinement today. Both calls are best-effort: a container that is
      // already gone must not fail the teardown.
      void opts;
      await agent('docker.stop', { name: runtimeId }, () => undefined).catch(() => undefined);
      await agent('docker.rm', { name: runtimeId }, () => undefined).catch(() => undefined);
    },
  };
}
