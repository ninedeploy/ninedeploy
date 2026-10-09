import type { BuildContext, DeployRuntime } from '../types.js';
import type { AgentCall } from './remoteDocker.js';

/**
 * The RUN phase of a remote docker deploy: write the env-file on the node,
 * start the container with `docker.runEnv`, and clean up after it.
 *
 * Moved out of `remoteDocker.ts` unchanged (multi-node T1, a pure move) so the
 * node-volume work (T5, `docker.runSpec` for attachments, `cmd` and the
 * socket) changes this file alone. Every op, parameter and log line is
 * exactly what `remoteDocker.ts` sent before the move.
 */

/**
 * r267: the env map as it must travel to an agent's `file.writeEnv`. The
 * agent refuses any value containing a newline (a physical newline would let
 * the rest of the value be parsed as further env-file keys), while the panel
 * accepts multi-line values and the local builder (`writeEnvFile` in
 * docker.ts) stores them as literal `\n` escapes — so a service with a PEM
 * key or a multi-line JSON secret deployed locally and failed on every node.
 * Escaping here, panel-side, applies the local convention and works with
 * agents already in the field.
 */
export function envForAgent(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\r\n?|\n/g, '\\n')]));
}

export interface RemoteRunInput {
  service: BuildContext['service'];
  deploymentId: number;
  env: Record<string, string>;
  /** This generation's container name (`<slug>-<deploymentId>`). */
  name: string;
  /** The image to run: the pulled release or the tag built on the node. */
  image: string;
  previous?: DeployRuntime;
  log: (line: string) => void;
}

/** Start the container on the node. Returns the port the runtime listens on. */
export async function runRemoteContainer(agent: AgentCall, input: RemoteRunInput): Promise<{ port: number | null }> {
  const { service, deploymentId, env, name, image: target, previous, log } = input;
  const sink = (line: string) => log(line);

  // Environment reaches the node as a 0600 env-file written by the agent,
  // never as argv: `docker.runEnv` mounts it with --env-file, so no secret
  // is visible in the node's process table.
  const envFileName = `${service.slug}-${deploymentId}`;
  const wrote = await agent('file.writeEnv', { name: envFileName, env: envForAgent(env) }, sink);
  const envFile =
    wrote.lines.find((l) => l.startsWith('wrote '))?.slice('wrote '.length) ??
    `.agent-env/${envFileName}.env`;

  const resolvedPort = service.port ?? null;
  const runParams: Record<string, unknown> = { name, image: target, envFile };
  if (service.cpuShares > 0) runParams['cpuShares'] = String(service.cpuShares);
  if (service.cpuLimitMilli > 0) runParams['cpuLimitMilli'] = String(service.cpuLimitMilli);
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

  // r264: a host-published port cannot run blue-green — Docker refuses to
  // bind the same host port twice, so every redeploy after the first died
  // on "port is already allocated" (leaving a Created container behind)
  // while the old generation kept the port. Same rule as the local builder
  // (docker.ts) and the fan-out (fanout.ts): retire the previous runtime
  // FIRST and deploy sequentially.
  if (runParams['publish'] !== undefined && previous?.runtimeId && previous.runtimeId !== name) {
    log(
      `Host port ${service.publishedPort} is published — retiring previous runtime ${previous.runtimeId} on the node before start (sequential deploy, no blue-green)`,
    );
    await agent('docker.rm', { name: previous.runtimeId }, sink).catch((err: unknown) =>
      log(
        `warning: could not remove ${previous.runtimeId}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  log(`Starting ${name} on the node …`);
  try {
    await agent('docker.runEnv', runParams, sink);
  } catch (err) {
    // r264: `docker run -d` that fails after create (a port conflict, a bad
    // mount) leaves a Created container under this deployment's name, and
    // the pipeline has no runtime to stop. Remove it; the run error is
    // still what fails the deployment.
    await agent('docker.rm', { name }, () => undefined).catch(() => undefined);
    throw err;
  } finally {
    // The env-file has been consumed by `docker run`; leaving decrypted
    // secrets on the node's disk after that is pure exposure.
    await agent('file.deleteEnv', { name: envFileName }, sink).catch(() => undefined);
  }

  return { port: resolvedPort };
}
