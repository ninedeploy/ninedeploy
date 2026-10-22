import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { buildConfigs, serviceTargets, type DB, type DeploymentArtifact, type Service } from '@ninedeploy/db';
import { capture } from './exec.js';
import { pushRepository } from '@ninedeploy/schemas';

const artifactSchema = z.object({
  version: z.literal(1), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  repoUrl: z.string().min(1), commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  originDeploymentId: z.number().int().positive(),
  originServerId: z.number().int().positive().optional(),
  builtWithNixpacks: z.boolean(), builtStatic: z.boolean(),
  registry: z.object({ sourceId: z.number().int().positive(), repository: z.string().regex(/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().optional(),
}).strict();

export function parseDockerArtifact(value: unknown): DeploymentArtifact {
  return artifactSchema.parse(value);
}

export function artifactSummary(value: DeploymentArtifact | null | undefined, promotionSourceDeploymentId?: number | null) {
  if (!value) return null;
  const record = parseDockerArtifact(value);
  return { imageId: record.imageId, originDeploymentId: record.originDeploymentId, promotionSourceDeploymentId: promotionSourceDeploymentId ?? null, ...(record.originServerId != null ? { originServerId: record.originServerId } : {}), ...(record.registry ? { registryRef: `${record.registry.repository}@${record.registry.digest}` } : {}) };
}

export function supportsDockerArtifact(service: Pick<Service, 'type' | 'serverId' | 'orchestrator' | 'repoUrl' | 'image' | 'composeContent'>): boolean {
  return service.type === 'docker' && service.orchestrator !== 'swarm' && !!service.repoUrl && !service.image && !service.composeContent;
}

/** Rechecked by the worker before hooks, checkout, or any runtime changes. */
export async function assertArtifactTarget(db: DB, artifact: DeploymentArtifact, service: Service): Promise<void> {
  parseDockerArtifact(artifact);
  if (!supportsDockerArtifact(service) || artifact.repoUrl !== service.repoUrl) {
    throw new Error('Artifact promotion requires a repository-backed Docker service and the same repository');
  }
  const build = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, service.id) });
  if (build?.preDeployCmd || build?.postDeployCmd || build?.preStopCmd) {
    throw new Error('Artifact promotion does not check out source; remove host deploy hooks or use commit promotion');
  }
  if (await db.query.serviceTargets.findFirst({ where: eq(serviceTargets.serviceId, service.id) })) {
    throw new Error('Artifact promotion supports a single target; multi-node fan-out is not supported');
  }
}

/** Run under the release-image lock; a durable panel copy outlives the origin node. */
export async function cacheNodeDockerArtifact(db: DB, artifact: DeploymentArtifact, service: Service, deploymentId: number, log: (line: string) => void): Promise<void> {
  parseDockerArtifact(artifact);
  if (service.serverId == null) return;
  try { await assertArtifactImage(artifact); return; } catch { /* Copy from the running node. */ }
  const source = service.serverId;
  const { agentOp, agentTransportSealed } = await import('./agentClient.js');
  const { capabilityRefusal, nodeLabel } = await import('./agentCapabilities.js');
  const { buildTag, shipImageByStream } = await import('./imageTransfer.js');
  const agent = (op: string, params: Record<string, unknown>, sink: (line: string) => void) => agentOp(db, source, op, params, sink);
  const refusal = await capabilityRefusal(agent, await nodeLabel(db, source), await agentTransportSealed(db, source), {
    cap: ['stream', 'image.manage'], feature: 'retain a node-built deployment artifact on the panel', sealedRequired: true, persist: { db, serverId: source },
  });
  if (refusal) throw new Error(refusal.message);
  await shipImageByStream(db, { source, target: null, deploymentId, serviceId: service.id, imageId: artifact.imageId, tag: buildTag(service.slug, artifact.commitSha, deploymentId) }, log);
  await assertArtifactImage(artifact);
  log(`Retained node-built artifact ${artifact.imageId} on the panel`);
}

/** Apply runtime node guards without treating the artifact as a new source build. */
export function artifactRuntimeService<T extends Service>(service: T): T {
  return { ...service, buildOn: 'panel', buildServerId: null, gitLfs: false };
}

async function archiveTarget(db: DB, artifact: DeploymentArtifact) {
  const { resolvePushTarget } = await import('./imageTransfer.js');
  const record = parseDockerArtifact(artifact).registry;
  if (!record) throw new Error('Recorded artifact has no registry archive');
  const slash = record.repository.indexOf('/');
  const repository = pushRepository.parse(record.repository.slice(slash + 1));
  const target = await resolvePushTarget(db, { pushRegistrySourceId: record.sourceId, pushRepository: repository });
  if (!target || target.repository !== record.repository) throw new Error('Artifact registry credential binding changed; restore the recorded registry host');
  return target;
}

/** Queue checks never pull, build or change a runtime. */
export async function assertArtifactAvailable(db: DB, artifact: DeploymentArtifact): Promise<void> {
  try { await assertArtifactImage(artifact); }
  catch (err) {
    if (!artifact.registry) throw err;
    await archiveTarget(db, artifact);
  }
}

/** Called only for a fresh build after the existing secret-export guard passes. */
export async function archiveDockerArtifact(db: DB, artifact: DeploymentArtifact, service: Service, log: (line: string) => void): Promise<DeploymentArtifact> {
  parseDockerArtifact(artifact);
  if (service.pushRegistrySourceId == null && !service.pushRepository) return artifact;
  const { resolvePushTarget, pushImage } = await import('./imageTransfer.js');
  const target = await resolvePushTarget(db, service);
  if (!target) return artifact;
  const result = await pushImage(db, null, { tag: artifact.imageId, target }, log);
  return parseDockerArtifact({ ...artifact, registry: { sourceId: service.pushRegistrySourceId, repository: target.repository, digest: result.digest } });
}

/** Restore/ship a pinned image before starting a candidate. Never rebuild or pull a tag. */
export async function prepareArtifactImage(db: DB, artifact: DeploymentArtifact, service: Service, deploymentId: number, log: (line: string) => void): Promise<void> {
  parseDockerArtifact(artifact);
  const target = service.serverId ?? null;
  if (target != null) {
    const { agentOp, agentTransportSealed } = await import('./agentClient.js');
    const { capabilityRefusal, nodeLabel } = await import('./agentCapabilities.js');
    const { buildTag, nodeImageInfo, pullImageByDigest, shipImageByStream } = await import('./imageTransfer.js');
    const agent = (op: string, params: Record<string, unknown>, sink: (line: string) => void) => agentOp(db, target, op, params, sink);
    const refusal = await capabilityRefusal(agent, await nodeLabel(db, target), await agentTransportSealed(db, target), {
      cap: artifact.registry ? 'image.manage' : ['stream', 'image.manage'], feature: 'receive an immutable deployment artifact', sealedRequired: true, persist: { db, serverId: target },
    });
    if (refusal) throw new Error(refusal.message);
    if (artifact.registry) {
      const credentials = await archiveTarget(db, artifact);
      await pullImageByDigest(db, { deploymentId, serviceId: service.id, source: null, target, imageId: artifact.imageId, ...artifact.registry }, credentials, log);
    } else {
      await assertArtifactImage(artifact);
      await shipImageByStream(db, { deploymentId, serviceId: service.id, source: null, target, imageId: artifact.imageId, tag: buildTag(service.slug, artifact.commitSha, deploymentId) }, log);
    }
    // Older agents must not turn an unverifiable pull into success.
    if ((await nodeImageInfo(agent, artifact.imageId, `#${target}`)).id !== artifact.imageId) throw new Error('Artifact image identity on target node does not match');
    return;
  }
  try { await assertArtifactImage(artifact); }
  catch (err) {
    if (!artifact.registry) throw err;
    const credentials = await archiveTarget(db, artifact);
    const { pullImageByDigest } = await import('./imageTransfer.js');
    await pullImageByDigest(db, { deploymentId, serviceId: service.id, source: null, target: null, imageId: artifact.imageId, ...artifact.registry }, credentials, log);
    await assertArtifactImage(artifact);
  }
}

export async function assertArtifactImage(artifact: DeploymentArtifact): Promise<void> {
  parseDockerArtifact(artifact);
  try {
    const id = (await capture('docker', ['image', 'inspect', artifact.imageId, '--format', '{{.Id}}'], { timeoutMs: 10_000 })).trim();
    if (id !== artifact.imageId) throw new Error('identity mismatch');
  } catch {
    throw new Error('Recorded artifact image is missing or Docker is unreachable; no rebuild or pull was attempted');
  }
}
