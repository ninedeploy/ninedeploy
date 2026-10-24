import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, buildConfigs, deployments, environments, servers, services, serviceTargets, serviceWorkspaces, users, workspaceMembers, workspaces, type DB, type DeploymentArtifact } from '@ninedeploy/db';
import { mapAuditToDomainEvent } from '../src/kernel/auditBridge.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import { assertArtifactImage, parseDockerArtifact } from '../src/lib/dockerArtifact.js';
import { retainedReleaseImageIds } from '../src/lib/releaseImageRetention.js';
import { asUser, buildTestApp } from './helpers.js';
import { closeMigratedDb, migratedDb } from './lib/githubAppKit.js';
const h = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture }));
const IMAGE = `sha256:${'a'.repeat(64)}`;
const SHA = 'c'.repeat(40);
const REPO = 'https://github.com/acme/app.git';
const ARTIFACT: DeploymentArtifact = { version: 1, imageId: IMAGE, repoUrl: REPO, commitSha: SHA, originDeploymentId: 1, builtWithNixpacks: true, builtStatic: false };
let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'operator@example.test', passwordHash: 'x', isInstanceOperator: true });
  await db.insert(services).values([
    { id: 1, name: 'staging', slug: 'staging', type: 'docker', repoUrl: REPO },
    { id: 2, name: 'production', slug: 'production', type: 'docker', repoUrl: REPO },
  ]);
  await db.insert(deployments).values({ id: 1, serviceId: 1, status: 'running', commitSha: SHA, artifact: ARTIFACT });
  h.capture.mockReset().mockResolvedValue(IMAGE);
});
afterEach(() => closeMigratedDb(db));
async function promote(body: Record<string, unknown> = {}, headers = asUser()) {
  const app = await buildTestApp({ db });
  await app.register(deploysRoutes, { prefix: '/services' });
  try { return await app.inject({ method: 'POST', url: '/services/1/promote', headers, payload: { targetServiceId: 2, mode: 'artifact', sourceDeploymentId: 1, ...body } }); }
  finally { await app.close(); }
}
describe('immutable Docker artifact promotion', () => {
  it.each(['promote', 'rollback'])('queues the exact recorded image with configured fan-out targets for %s', async action => {
    const serviceId = action === 'promote' ? 2 : 1;
    await db.insert(servers).values({ id: 5, name: 'edge', host: 'edge.example.test', tokenEncrypted: 'fixture-only' });
    await db.insert(serviceTargets).values({ serviceId, serverId: 5, runtimeId: 'previous-edge', status: 'running' });
    const app = await buildTestApp({ db }); await app.register(deploysRoutes, { prefix: '/services' });
    try {
      const response = await app.inject({ method: 'POST', url: action === 'promote' ? '/services/1/promote' : '/services/1/deploys/1/rollback', headers: asUser(), payload: action === 'promote' ? { targetServiceId: 2, mode: 'artifact', sourceDeploymentId: 1 } : {} });
      expect(response.statusCode, response.body).toBe(200);
      expect(await db.query.deployments.findFirst({ where: eq(deployments.id, response.json().deploymentId) })).toMatchObject({ serviceId, artifact: ARTIFACT, commitSha: SHA, status: 'queued' });
      expect(await db.query.serviceTargets.findFirst({ where: eq(serviceTargets.serviceId, serviceId) })).toMatchObject({ runtimeId: 'previous-edge', status: 'running' });
    } finally { await app.close(); }
  });
  it.each(['promote', 'rollback'])('queues the immutable image for a Swarm target: %s', async action => {
    const id = action === 'promote' ? 2 : 1;
    await db.update(services).set({ orchestrator: 'swarm' }).where(eq(services.id, id));
    const app = await buildTestApp({ db }); await app.register(deploysRoutes, { prefix: '/services' });
    try {
      const result = await app.inject({ method: 'POST', url: action === 'promote' ? '/services/1/promote' : '/services/1/deploys/1/rollback', headers: asUser(), payload: action === 'promote' ? { targetServiceId: 2, mode: 'artifact', sourceDeploymentId: 1 } : {} });
      expect(result.statusCode, result.body).toBe(200);
      expect(await db.query.deployments.findFirst({ where: eq(deployments.id, result.json().deploymentId) })).toMatchObject({ serviceId: id, artifact: ARTIFACT, commitSha: SHA, status: 'queued' });
    } finally { await app.close(); }
  });
  it('promotes a retained node-built artifact after its origin node and source history are removed', async () => {
    await db.insert(servers).values({ id: 4, name: 'old origin', host: 'old.example.test', tokenEncrypted: 'fixture-only' });
    await db.update(services).set({ serverId: 4 }).where(eq(services.id, 1));
    await db.update(deployments).set({ artifact: { ...ARTIFACT, originServerId: 4 } }).where(eq(deployments.id, 1));
    await db.delete(servers).where(eq(servers.id, 4));
    const result = await promote();
    expect(result.statusCode).toBe(200);
    await db.delete(deployments).where(eq(deployments.id, 1));
    const row = await db.query.deployments.findFirst({ where: eq(deployments.id, result.json().deploymentId) });
    expect(row?.artifact).toEqual({ ...ARTIFACT, originServerId: 4 });
    expect(await retainedReleaseImageIds(db)).toEqual(new Set([IMAGE]));
  });
  it.each(['promote', 'rollback'])('publishes the new target deployment identity for artifact %s', async action => {
    let queuedId: number;
    if (action === 'promote') {
      const result = await promote(); expect(result.statusCode).toBe(200); queuedId = result.json().deploymentId;
    } else {
      const app = await buildTestApp({ db }); await app.register(deploysRoutes, { prefix: '/services' });
      try {
        const result = await app.inject({ method: 'POST', url: '/services/1/deploys/1/rollback', headers: asUser(), payload: {} });
        expect(result.statusCode).toBe(200); queuedId = result.json().deploymentId;
      } finally { await app.close(); }
    }
    const row = await db.query.auditLog.findFirst({ where: eq(auditLog.action, `deploy.${action}`) });
    expect(row).toBeDefined();
    const mapped = mapAuditToDomainEvent({ id: row!.id, action: row!.action, entity: row!.entity, ts: row!.ts.toISOString() });
    expect(mapped?.payload).toMatchObject({ deploymentId: queuedId!, serviceName: action === 'promote' ? 'production' : 'staging' });
    expect(row!.meta).toMatchObject({ deploymentId: queuedId!, targetServiceId: action === 'promote' ? 2 : 1, sourceDeploymentId: 1 });
  });
  it.each([false, true])('requires protected-source secret authority before exporting a baked image (preview=%s)', async preview => {
    await db.insert(users).values([{ id: 2, email: 'admin@example.test', passwordHash: 'x' }, { id: 3, email: 'member@example.test', passwordHash: 'x' }]);
    await db.insert(workspaces).values({ id: 1, name: 'Acme', slug: 'acme', ownerId: 2 });
    await db.insert(workspaceMembers).values([{ workspaceId: 1, userId: 2, role: 'admin' }, { workspaceId: 1, userId: 3, role: 'member' }]);
    await db.insert(environments).values({ id: 1, workspaceId: 1, name: 'protected production', slug: 'production', protected: true });
    await db.update(services).set({ ownerUserId: 3 });
    if (preview) await db.insert(services).values({ id: 3, name: 'protected parent', slug: 'protected-parent', type: 'docker', environmentId: 1, ownerUserId: 3 });
    await db.update(services).set(preview ? { previewParentServiceId: 3 } : { environmentId: 1 }).where(eq(services.id, 1));
    await db.insert(serviceWorkspaces).values([{ serviceId: 1, workspaceId: 1 }, { serviceId: 2, workspaceId: 1 }]);
    const refused = await promote({}, asUser({ id: 3, isOperator: false }));
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('protected_lane');
    expect(h.capture).not.toHaveBeenCalled();
    expect((await promote({ mode: 'commit' }, asUser({ id: 3, isOperator: false }))).statusCode).toBe(200);
    expect((await promote({}, asUser({ id: 2, isOperator: false }))).statusCode).toBe(200);
  });
  it('queues an independent copy, exposes identity and retains it after source history expires', async () => {
    const result = await promote();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ mode: 'artifact', imageId: IMAGE, commitSha: SHA });
    const queued = await db.query.deployments.findFirst({ where: eq(deployments.id, result.json().deploymentId) });
    expect(queued).toMatchObject({ serviceId: 2, status: 'queued', commitSha: SHA, artifact: ARTIFACT, promotionSourceDeploymentId: 1 });
    await db.delete(deployments).where(eq(deployments.id, 1));
    expect(await retainedReleaseImageIds(db)).toEqual(new Set([IMAGE]));
    const app = await buildTestApp({ db });
    await app.register(deploysRoutes, { prefix: '/services' });
    try {
      const list = await app.inject({ url: '/services/2/deploys', headers: asUser() });
      expect(list.json()[0].artifact).toEqual({ imageId: IMAGE, originDeploymentId: 1, promotionSourceDeploymentId: 1 });
      expect(JSON.stringify(list.json())).not.toContain(REPO);
    } finally { await app.close(); }
    await db.delete(deployments).where(eq(deployments.id, queued!.id));
    expect(await retainedReleaseImageIds(db)).toEqual(new Set());
  });
  it.each(['', `sha256:${'b'.repeat(64)}`])('refuses missing or mismatched image identity (%s) before enqueue', async response => {
    h.capture.mockResolvedValue(response);
    expect((await promote()).statusCode).toBe(400);
    expect(await db.query.deployments.findMany()).toHaveLength(1);
    expect(h.capture).toHaveBeenCalledWith('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { timeoutMs: 10_000 });
  });
  it('hides daemon details and never silently rebuilds on Docker failure', async () => {
    h.capture.mockRejectedValue(new Error('private-host-credential'));
    const result = await promote();
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('no rebuild or pull');
    expect(result.body).not.toContain('private-host-credential');
  });
  it.each([null, { ...ARTIFACT, commitSha: 'b'.repeat(40) }, { ...ARTIFACT, repoUrl: 'https://other.test/app.git' }])('rejects absent or stale source metadata', async artifact => {
    await db.update(deployments).set({ artifact });
    expect((await promote()).statusCode).toBe(400);
    expect(h.capture).not.toHaveBeenCalled();
  });
  it('refuses a stale selection and enforces source permissions', async () => {
    expect((await promote({ sourceDeploymentId: 99 })).statusCode).toBe(400);
    expect((await promote({}, asUser({ id: 8, isOperator: false }))).statusCode).toBe(404);
    expect(h.capture).not.toHaveBeenCalled();
  });
  it.each([{ type: 'compose' }, { repoUrl: 'https://github.com/other/repo.git' }, { image: 'nginx:latest' }])('refuses incompatible target %j', async patch => {
    await db.update(services).set(patch).where(eq(services.id, 2));
    expect((await promote()).statusCode).toBe(400);
    expect(h.capture).not.toHaveBeenCalled();
  });
  it.each(['preDeployCmd', 'postDeployCmd', 'preStopCmd'] as const)('refuses checkout-dependent hook %s', async field => {
    await db.insert(buildConfigs).values({ serviceId: 2, [field]: 'node ./script.mjs' });
    const result = await promote();
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain('host deploy hooks');
  });
  it('keeps legacy commit promotion when no artifact was recorded', async () => {
    await db.update(deployments).set({ artifact: null });
    const result = await promote({ mode: 'commit' });
    expect(result.statusCode).toBe(200);
    expect(h.capture).not.toHaveBeenCalled();
    const queued = await db.query.deployments.findFirst({ where: eq(deployments.id, result.json().deploymentId) });
    expect(queued?.artifact).toBeNull();
    expect(queued?.commitSha).toBe(SHA);
  });
  it('fails cleanup closed for unreadable artifact history', async () => {
    await db.update(deployments).set({ artifact: { ...ARTIFACT, imageId: 'mutable:latest' } });
    await expect(retainedReleaseImageIds(db)).rejects.toThrow('Image cleanup refused');
  });
  it('validates identifiers before invoking Docker', async () => {
    expect(() => parseDockerArtifact({ ...ARTIFACT, imageId: '--help' })).toThrow();
    await expect(assertArtifactImage({ ...ARTIFACT, imageId: '--help' })).rejects.toThrow();
    expect(h.capture).not.toHaveBeenCalled();
  });
  it('rolls back a served artifact without returning to the rebuild path', async () => {
    await db.update(deployments).set({ status: 'superseded' });
    const app = await buildTestApp({ db });
    await app.register(deploysRoutes, { prefix: '/services' });
    try {
      const info = await app.inject({ url: '/services/1/deploys/1/release', headers: asUser() });
      expect(info.json()).toMatchObject({ available: true, mode: 'recorded-docker', imageCount: 1 });
      const result = await app.inject({ method: 'POST', url: '/services/1/deploys/1/rollback', headers: asUser(), payload: {} });
      expect(result.statusCode).toBe(200);
      expect(await db.query.deployments.findFirst({ where: eq(deployments.id, result.json().deploymentId) })).toMatchObject({ artifact: ARTIFACT, promotionSourceDeploymentId: 1, commitSha: SHA });
      h.capture.mockRejectedValue(new Error('image removed'));
      expect((await app.inject({ url: '/services/1/deploys/1/release', headers: asUser() })).json()).toMatchObject({ available: false, mode: 'unavailable' });
      expect((await app.inject({ method: 'POST', url: '/services/1/deploys/1/rollback', headers: asUser(), payload: {} })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
