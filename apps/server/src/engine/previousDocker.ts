import { join } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { config } from '../config.js';
import { deployments, services, type DB, type Service } from '@ninedeploy/db';
import { z } from 'zod';
import { containerIdentityOps } from '../agentOps/containerIdentity.js';
import { run } from '../lib/exec.js';
import { RE_NAME } from '../agentOps/operands.js';
import { dockerBuilder } from './builders/docker.js';
import { MAX_REPLICAS, replicaNames } from './dockerNames.js';
import type { DeployRuntime } from './types.js';

const identitySchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().regex(RE_NAME), managed: z.string().nullable(), serviceId: z.string().nullable(), deploymentId: z.string().nullable() });
export const previousDockerSchema = z.object({
  runtimeId: z.string().regex(RE_NAME), replicas: z.number().int().min(1).max(MAX_REPLICAS), port: z.number().int().min(1).max(65535).nullable(),
  healthPath: z.string(), healthCheck: z.string().nullable(), healthCommand: z.string().nullable(), commitSha: z.string().nullable(),
  deploymentId: z.number().int().positive().nullable(),
  containers: z.array(z.object({ name: z.string().regex(RE_NAME), id: z.string().regex(/^[a-f0-9]{64}$/).nullable() })).length(MAX_REPLICAS),
});
export type PreviousDockerGeneration = z.infer<typeof previousDockerSchema>;
function validate(group: PreviousDockerGeneration) {
  previousDockerSchema.parse(group);
  if (group.containers.some((item, index) => item.name !== replicaNames(group.runtimeId, MAX_REPLICAS)[index])) throw new Error('Previous Docker generation shape is unconfirmed');
}
async function identity(name: string) {
  const lines: string[] = [];
  const code = await containerIdentityOps.ops['docker.identity']!.run({ name }, line => lines.push(line), { sealed: true });
  if (code !== 0 || lines.length !== 1 || !lines[0]!.startsWith('ND-CONTAINER ')) throw new Error('Previous Docker identity is unconfirmed');
  return identitySchema.nullable().parse(JSON.parse(lines[0]!.slice(13)));
}
export async function capturePreviousDocker(db: DB, service: Service): Promise<PreviousDockerGeneration> {
  if (!service.runtimeId || service.serverId != null || !RE_NAME.test(service.runtimeId)) throw new Error('Previous Docker placement is unconfirmed');
  const group: PreviousDockerGeneration = { runtimeId: service.runtimeId, replicas: Math.max(1, service.runtimeReplicas ?? 1), port: service.port, healthPath: service.healthPath,
    healthCheck: service.healthCheck, healthCommand: service.healthCommand, commitSha: service.commitSha, deploymentId: null, containers: [] };
  let priorId: string | null = null;
  for (const name of replicaNames(service.runtimeId, MAX_REPLICAS)) {
    const actual = await identity(name);
    if (actual) {
      // 0.17 containers have service/deployment labels but no managed label. Do not adopt unlabelled names.
      if (actual.name !== name || actual.serviceId !== String(service.id) || !/^\d+$/.test(actual.deploymentId ?? '') || actual.managed != null && actual.managed !== 'service' || priorId != null && actual.deploymentId !== priorId) throw new Error('Previous Docker ownership is unconfirmed');
      priorId = actual.deploymentId;
    }
    group.containers.push({ name, id: actual?.id ?? null });
  }
  if (priorId != null) {
    const deploymentId = Number(priorId), prior = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
    if (!Number.isSafeInteger(deploymentId) || deploymentId <= 0 || !prior || prior.serviceId !== service.id || !['running', 'superseded'].includes(prior.status)) throw new Error('Previous Docker history is unconfirmed');
    group.deploymentId = deploymentId;
  }
  validate(group); return group;
}
export async function previousDockerHealthy(group: PreviousDockerGeneration) {
  validate(group);
  for (const item of group.containers.slice(0, group.replicas)) {
    if (!item.id || (await identity(item.id))?.name !== item.name) return false;
    const runtime: DeployRuntime = { runtimeId: item.id, port: group.port, healthPath: group.healthPath,
      ...(group.healthCheck === 'running' || group.healthCheck === 'command' || group.healthCheck === 'tcp' || group.healthCheck === 'http-strict' ? { healthCheck: group.healthCheck } : {}),
      ...(group.healthCommand ? { healthCommand: group.healthCommand } : {}) };
    if (!await dockerBuilder.isHealthy(runtime, 10_000, 0) || runtime.port !== group.port) return false;
  }
  return true;
}
export async function retirePreviousDocker(db: DB, group: PreviousDockerGeneration, check: () => Promise<unknown>, graceSeconds = 5) {
  validate(group);
  const names = group.containers.map(c => c.name);
  const unreferenced = async () => {
    await check();
    if ((await db.select({ id: services.id }).from(services).where(and(isNull(services.serverId), inArray(services.runtimeId, names))).limit(1)).length) throw new Error('Previous Docker generation is still referenced; retained');
  };
  for (const item of group.containers) {
    await unreferenced();
    if (!item.id) { if (await identity(item.name)) throw new Error('Previous Docker name was reused; retained'); continue; }
    const actual = await identity(item.id);
    if (!actual) continue;
    if (actual.name !== item.name) throw new Error('Previous Docker container was renamed; retained');
    const grace = Math.max(0, Math.min(300, Math.floor(graceSeconds)));
    await unreferenced(); await run('docker', ['stop', '-t', String(grace), item.id], { timeoutMs: (grace + 10) * 1000 }, () => {}); await unreferenced();
    const lines: string[] = [];
    await containerIdentityOps.ops['docker.retire']!.run({ id: item.id, name: item.name }, line => lines.push(line), { sealed: true, lifecycleJournalRoot: join(config.paths.dataDir, 'local-lifecycle') });
    if (!lines.includes(`ND-RETIRED ${item.id}`)) throw new Error('Previous Docker retirement is unconfirmed');
  }
}
export async function previousDockerRetired(group: PreviousDockerGeneration) {
  validate(group);
  for (const item of group.containers) if (await identity(item.id ?? item.name)) return false;
  return true;
}
