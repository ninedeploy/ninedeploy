import type { BuildContext, DeployRuntime } from '../types.js';
import type { AgentCall } from './remoteDocker.js';
import { capabilityRefusal } from '../../lib/agentCapabilities.js';
import {
  ensureNodeVolumes,
  NODE_RUN_SPEC_FEATURE,
  type NodeVolumeAttachment,
  nodeRunCapabilities,
  nodeRunNeeds,
  nodeVolumeLabels,
} from '../../lib/remoteVolumes.js';

/**
 * The RUN phase of a remote docker deploy: write the env-file on the node,
 * start the container with `docker.runEnv`, and clean up after it.
 *
 * Moved out of `remoteDocker.ts` unchanged (multi-node T1, a pure move) so the
 * node-volume work (T5, `docker.runSpec` for attachments, `cmd` and the
 * socket) changes this file alone. Every op, parameter and log line is
 * exactly what `remoteDocker.ts` sent before the move.
 *
 * Multi-node T5 (design §4.2): a container that needs a command, the Docker
 * socket or volume attachments starts with `docker.runSpec` instead, after
 * every missing managed volume it mounts was created on the node. A service
 * that needs none of these takes the `docker.runEnv` path byte-for-byte as
 * before, on any agent — the regression baseline.
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
  // ── 0.16 T5 node volumes ──
  /**
   * The service's volume attachments (`ctx.volumeAttachments`). Absent or
   * empty: no attachment is mounted — a service with attachments is refused
   * at queue time unless its caller passes them here.
   */
  volumeAttachments?: readonly NodeVolumeAttachment[];
  /** How refusals name the node (`"edge-1" (#4)`); default `#<serverId>`. */
  nodeLabel?: string;
  /**
   * Whether the panel reaches the node over the sealed transport. Default
   * true: an agent answers its capabilities only inside a sealed ping, so an
   * unsealed one reads as "update the node agent" and nothing is sent.
   */
  sealed?: boolean;
  // ── end 0.16 T5 ──
}

/** One volume a `docker.runSpec` container mounts. */
interface SpecVolume {
  name: string;
  mount: string;
  readOnly: boolean;
}

/** Start the container on the node. Returns the port the runtime listens on. */
export async function runRemoteContainer(agent: AgentCall, input: RemoteRunInput): Promise<{ port: number | null }> {
  const { service, deploymentId, env, name, image: target, previous, log } = input;
  const sink = (line: string) => log(line);

  // ── 0.16 T5 node volumes ──
  // Decided, checked and prepared BEFORE the env-file is written, so a
  // refused deploy leaves no secret on the node and starts nothing.
  const attachments = input.volumeAttachments ?? [];
  const runSpec = nodeRunNeeds(service, attachments).length > 0;
  const specVolumes: SpecVolume[] = [];
  if (runSpec) {
    const label = input.nodeLabel ?? `#${service.serverId ?? '?'}`;
    const refusal = await capabilityRefusal(agent, label, input.sealed ?? true, {
      cap: nodeRunCapabilities(service, attachments),
      feature: NODE_RUN_SPEC_FEATURE,
      sealedRequired: true,
    });
    if (refusal) throw new Error(refusal.message);
    if (service.volumeMount) specVolumes.push({ name: `nd-svc-${service.slug}-data`, mount: service.volumeMount, readOnly: false });
    for (const a of attachments) specVolumes.push({ name: a.volumeName, mount: a.containerPath, readOnly: a.readOnly === true });
    if (specVolumes.length > 0) {
      const { missingDatabaseVolumes } = await ensureNodeVolumes(
        agent,
        specVolumes.map((v) => v.name),
        nodeVolumeLabels({ serviceId: service.id, userId: service.ownerUserId ?? null }),
        log,
      );
      if (missingDatabaseVolumes.length > 0) {
        throw new Error(
          `Database volume ${missingDatabaseVolumes.join(', ')} does not exist on node ${label}. A database volume is created by its database on the same host, never by a service that attaches it.`,
        );
      }
    }
  }
  // ── end 0.16 T5 ──

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
    // ── 0.16 T5 node volumes ──
    if (runSpec) {
      await agent(
        'docker.runSpec',
        runSpecParams(service, {
          name,
          image: target,
          envFile,
          envFileName,
          deploymentId,
          volumes: specVolumes,
          publish: runParams['publish'] as string | undefined,
        }),
        sink,
      );
    } else {
      await agent('docker.runEnv', runParams, sink);
    }
    // ── end 0.16 T5 ──
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

// ── 0.16 T5 node volumes ──
/**
 * The `docker.runSpec` request (agentOps/runSpec.ts validates every field):
 * the restart policy, network, resources, env-file and published port
 * `docker.runEnv` gives, plus the volumes, the command and the socket. The
 * agent adds the r593 recovery labels (`ninedeploy.managed`, the deployment
 * and service ids) itself.
 */
export function runSpecParams(
  service: RemoteRunInput['service'],
  run: {
    name: string;
    image: string;
    envFile: string;
    envFileName: string;
    deploymentId: number;
    volumes: readonly SpecVolume[];
    publish?: string;
  },
): Record<string, unknown> {
  // runSpec accepts only the agent's own env-file shape, which is what
  // `file.writeEnv` answers (`.agent-env/<name>.env`).
  const envFile = /^\.agent-env\/[^/]+\.env$/.test(run.envFile) ? run.envFile : `.agent-env/${run.envFileName}.env`;
  const spec: Record<string, unknown> = {
    name: run.name,
    image: run.image,
    envFile,
    restart: 'unless-stopped',
    network: 'ninedeploy',
    deploymentId: run.deploymentId,
    serviceId: service.id,
  };
  if (run.volumes.length > 0) {
    spec['volumes'] = run.volumes.map((v) => (v.readOnly ? { name: v.name, mount: v.mount, readOnly: true } : { name: v.name, mount: v.mount }));
  }
  if (service.dockerSocket) spec['dockerSocket'] = true;
  if (service.cmd?.length) spec['cmd'] = [...service.cmd];
  if (run.publish !== undefined) spec['publish'] = run.publish;
  if (service.cpuShares > 0) spec['cpuShares'] = service.cpuShares;
  if (service.cpuLimitMilli > 0) spec['cpuLimitMilli'] = service.cpuLimitMilli;
  if (service.memLimitMb > 0) spec['memLimitMb'] = service.memLimitMb;
  return spec;
}
// ── end 0.16 T5 ──
