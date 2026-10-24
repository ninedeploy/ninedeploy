import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { deployments, type DB, type Service } from '@ninedeploy/db';
import { z } from 'zod';
import { encrypt, decrypt } from '../lib/crypto.js';
import { dockerEngineRequest } from '../lib/dockerEngineApi.js';
import { localSwarmInfo, RE_SWARM_NODE_ID, swarmRuntimeOf } from '../lib/swarm.js';
import { capture, sleep } from '../lib/exec.js';
import { swarmSpecFingerprint, type ManagedSwarmSpec } from './swarmServiceSpec.js';
import { verifySwarmTaskImages } from './swarmArtifact.js';

const RETIREMENT = 'ninedeploy.retirement';
const id = z.string().regex(/^[a-z0-9]{25}$/);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const receiptSchema = z.object({
  managerNodeId: id, id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  deploymentId: z.number().int().positive(), imageRef: z.string().min(1).max(1024), imageId: imageId.nullable(),
  knownImageIds: z.array(imageId).max(10), replicas: z.number().int().min(0).max(10),
  retirement: z.object({ epoch: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
type PreviousNativeGeneration = z.infer<typeof receiptSchema>;
function decode(encoded: string) { try { return receiptSchema.parse(JSON.parse(decrypt(encoded))); } catch { return refusal(); } }
type Native = { ID: string; Version: { Index: number }; Spec: ManagedSwarmSpec; UpdateStatus?: { State?: string } };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (spec: ManagedSwarmSpec) => record(record(spec.Mode).Replicated).Replicas;
const image = (spec: ManagedSwarmSpec) => record(record(spec.TaskTemplate).ContainerSpec).Image;
async function drained(receipt: PreviousNativeGeneration) {
  const states = (await capture('docker', ['service', 'ps', '--no-trunc', '--format', '{{.CurrentState}}', receipt.id], { timeoutMs: 10_000, maxOutputBytes: 128 * 1024 })).split('\n').map(s => s.trim()).filter(Boolean);
  return states.every(s => /^(Shutdown|Failed|Complete|Rejected|Orphaned|Remove)\b/.test(s));
}
function refusal(): never { throw new Error('Previous native Swarm identity or revision is unconfirmed; retained for review'); }
async function read(name: string): Promise<Native> {
  const result = await dockerEngineRequest('GET', `/services/${name}`), value = result.body as Native;
  if (result.status !== 200 || !value || !RE_SWARM_NODE_ID.test(value.ID) || !Number.isSafeInteger(value.Version?.Index) || value.Version.Index < 0 || typeof value.Spec?.Name !== 'string') refusal();
  return value;
}
async function current(receipt: PreviousNativeGeneration, name: string, retired = false) {
  receiptSchema.parse(receipt);
  const info = await localSwarmInfo();
  if (!info.controlAvailable || info.nodeId !== receipt.managerNodeId) refusal();
  const value = await read(receipt.id), hash = swarmSpecFingerprint(value.Spec);
  if (value.ID !== receipt.id || value.Spec.Name !== name || (hash !== receipt.fingerprint && !(retired && hash === receipt.retirement?.fingerprint && record(value.Spec.Labels)[RETIREMENT] === receipt.retirement.epoch && count(value.Spec) === 0))) refusal();
  return value;
}

/** Encrypt spec fingerprints as well as provenance; native environment/commands stay in Docker. */
export async function capturePreviousNative(db: DB, service: Service): Promise<string> {
  const name = swarmRuntimeOf(service);
  if (!name || service.serverId != null) refusal();
  const info = await localSwarmInfo();
  if (!info.controlAvailable || !info.nodeId) refusal();
  const value = await read(name), labels = record(value.Spec.Labels), deploymentId = Number(labels['ninedeploy.deployment']);
  const replicas = count(value.Spec), imageRef = image(value.Spec);
  if (labels['ninedeploy.managed'] !== 'service' || labels['ninedeploy.service'] !== String(service.id) || value.Spec.Name !== name || !Number.isSafeInteger(deploymentId) || deploymentId <= 0 || !Number.isInteger(replicas) || Number(replicas) < 0 || Number(replicas) > 10 || typeof imageRef !== 'string') refusal();
  const prior = await db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) });
  if (!prior || prior.serviceId !== service.id || !['running', 'superseded'].includes(prior.status)) refusal();
  const receipt: PreviousNativeGeneration = { managerNodeId: info.nodeId, id: value.ID, fingerprint: swarmSpecFingerprint(value.Spec), deploymentId,
    imageRef, imageId: prior.imageDigest?.match(/^sha256:[a-f0-9]{64}$/) ? prior.imageDigest : null, knownImageIds: [], replicas: Number(replicas) };
  if (receipt.replicas) receipt.knownImageIds = await verifySwarmTaskImages(db, { runtimeId: name, imageRef, imageId: receipt.imageId, replicas: receipt.replicas, serviceId: service.id, deploymentId, panelNodeId: info.nodeId, nativeServiceId: value.ID });
  receiptSchema.parse(receipt); return encrypt(JSON.stringify(receipt));
}

export async function previousNativeHealthy(db: DB, encoded: string, serviceId: number, runtime: { runtimeId: string; port: number | null; healthPath: string }) {
  const receipt = decode(encoded);
  const value = await current(receipt, runtime.runtimeId);
  if (!receipt.replicas || ['paused', 'rollback_paused', 'updating', 'rollback_started'].includes(value.UpdateStatus?.State ?? '')) return false;
  const hasHealth = !!record(record(value.Spec.TaskTemplate).ContainerSpec).Healthcheck;
  await verifySwarmTaskImages(db, { runtimeId: runtime.runtimeId, imageRef: receipt.imageRef, imageId: receipt.imageId, replicas: receipt.replicas,
    serviceId, deploymentId: receipt.deploymentId, panelNodeId: receipt.managerNodeId, nativeServiceId: receipt.id, knownImageIds: receipt.knownImageIds, freshHealth: true, requireHealthy: hasHealth });
  const { swarmHealthy } = await import('./swarmDeploy.js');
  return swarmHealthy({ ...runtime, ...(hasHealth ? { healthCheck: 'command' as const } : {}) }, 10_000, () => undefined);
}

/** CAS to an owned zero-replica archive; Docker service DELETE has no revision fence. */
export async function retirePreviousNative(encoded: string, name: string, check: () => Promise<unknown>, persist: (encoded: string) => Promise<void>) {
  const receipt = decode(encoded);
  await check(); let observed = await current(receipt, name, true);
  if (swarmSpecFingerprint(observed.Spec) === receipt.fingerprint) {
    const epoch = receipt.retirement?.epoch ?? randomUUID();
    const spec: ManagedSwarmSpec = { ...observed.Spec, Mode: { Replicated: { Replicas: 0 } }, Labels: { ...record(observed.Spec.Labels), [RETIREMENT]: epoch } };
    const fingerprint = swarmSpecFingerprint(spec);
    if (receipt.retirement && receipt.retirement.fingerprint !== fingerprint) refusal();
    receipt.retirement = { epoch, fingerprint }; await persist(encrypt(JSON.stringify(receipt))); await check();
    // The observed Engine version protects concurrent native changes; a 409 is retained, never retried blindly.
    const result = await dockerEngineRequest('POST', `/services/${observed.ID}/update?version=${observed.Version.Index}`, spec);
    if (result.status !== 200) refusal();
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    await check(); observed = await current(receipt, name, true);
    if (swarmSpecFingerprint(observed.Spec) !== receipt.retirement?.fingerprint) refusal();
    if (await drained(receipt)) return;
    if (Date.now() >= deadline) throw new Error('Previous native tasks are still draining; recovery retained');
    await sleep(500);
  }
}

export async function previousNativeRetired(encoded: string, name: string) {
  const receipt = decode(encoded);
  if (!receipt.retirement) return false;
  const value = await current(receipt, name, true);
  return swarmSpecFingerprint(value.Spec) === receipt.retirement.fingerprint && await drained(receipt);
}
