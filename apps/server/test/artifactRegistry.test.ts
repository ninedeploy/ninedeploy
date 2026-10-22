import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { deployments, servers, services, sources, type DB, type DeploymentArtifact, type Service } from '@ninedeploy/db';
import { archiveDockerArtifact, artifactSummary, assertArtifactAvailable, assertArtifactTarget, cacheNodeDockerArtifact, prepareArtifactImage } from '../src/lib/dockerArtifact.js';
import { setBoundRegistryHosts } from '../src/lib/registryBinding.js';
import { encrypt } from '../src/lib/crypto.js';
import { closeMigratedDb, migratedDb } from './lib/githubAppKit.js';

const h = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn(), agentOp: vi.fn(), sealed: vi.fn(), ship: vi.fn() }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture, run: h.run }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: h.agentOp, agentTransportSealed: h.sealed }));
vi.mock('../src/lib/imageTransfer.js', async original => ({ ...await original<typeof import('../src/lib/imageTransfer.js')>(), shipImageByStream: h.ship }));
const IMAGE = `sha256:${'a'.repeat(64)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const ARTIFACT: DeploymentArtifact = { version: 1, imageId: IMAGE, repoUrl: 'https://example.test/app.git', commitSha: 'c'.repeat(40), originDeploymentId: 1, builtWithNixpacks: false, builtStatic: false };
const ARCHIVED: DeploymentArtifact = { ...ARTIFACT, registry: { sourceId: 1, repository: 'registry.example.test/team/app', digest: DIGEST } };
let db: DB;
let service: Service;
beforeEach(async () => {
  vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
  db = await migratedDb();
  await db.insert(sources).values({ id: 1, name: 'Archive registry', type: 'registry', registryUsername: 'operator', tokenEncrypted: encrypt('fixture-registry-secret') });
  await setBoundRegistryHosts(db, 1, ['registry.example.test']);
  await db.insert(services).values({ id: 1, name: 'target', slug: 'target', type: 'docker', repoUrl: ARTIFACT.repoUrl, pushRegistrySourceId: 1, pushRepository: 'team/app' });
  await db.insert(deployments).values({ id: 1, serviceId: 1, status: 'queued', commitSha: ARTIFACT.commitSha, artifact: ARCHIVED });
  service = (await db.query.services.findFirst())!;
  h.capture.mockReset().mockResolvedValue(IMAGE);
  h.run.mockReset().mockImplementation(async (_cmd, args, _opts, sink) => { if (args[0] === 'push') sink(`artifact: digest: ${DIGEST} size: 123`); return { stdout: '', stderr: '' }; });
  h.sealed.mockReset().mockResolvedValue(true);
  h.ship.mockReset().mockResolvedValue({ method: 'stream', ref: 'fixture', bytes: 123, sha256: 'a'.repeat(64), durationMs: 1 });
  h.agentOp.mockReset().mockImplementation(async (_db, _id, op) => ({ exitCode: 0, lines: op === 'agent.ping' ? ['ND-AGENT {"version":"0.17.0","caps":["image.manage","stream"]}'] : op === 'docker.imageInspect' ? [`${IMAGE}|123`] : [] }));
});
afterEach(() => { closeMigratedDb(db); vi.unstubAllEnvs(); });

describe('immutable artifact registry archive', () => {
  it('retains a node-built image on the panel and exposes historical origin without requiring the node later', async () => {
    await db.insert(servers).values({ id: 4, name: 'origin', host: 'origin.example.test', tokenEncrypted: encrypt('fixture-node-token') });
    const artifact = { ...ARTIFACT, originServerId: 4 };
    h.capture.mockRejectedValueOnce(new Error('not on panel')).mockResolvedValueOnce(IMAGE);
    await cacheNodeDockerArtifact(db, artifact, { ...service, serverId: 4 }, 1, () => undefined);
    expect(h.ship).toHaveBeenCalledWith(db, expect.objectContaining({ source: 4, target: null, imageId: IMAGE, deploymentId: 1 }), expect.any(Function));
    await db.update(deployments).set({ artifact }).where(eq(deployments.id, 1));
    await db.delete(servers).where(eq(servers.id, 4));
    const record = (await db.query.deployments.findFirst())!.artifact!;
    expect(artifactSummary(record)).toMatchObject({ originServerId: 4, originDeploymentId: 1 });
    await assertArtifactAvailable(db, record);
    expect(h.ship).toHaveBeenCalledTimes(1);
  });
  it('reuses an already verified panel copy without contacting the origin node', async () => {
    await cacheNodeDockerArtifact(db, { ...ARTIFACT, originServerId: 99 }, { ...service, serverId: 99 }, 1, () => undefined);
    expect(h.agentOp).not.toHaveBeenCalled();
    expect(h.ship).not.toHaveBeenCalled();
  });
  it.each(['unsealed', 'old agent', 'transfer failure', 'wrong image'])('never records an unavailable node copy: %s', async failure => {
    await db.insert(servers).values({ id: 4, name: 'origin', host: 'origin.example.test', tokenEncrypted: encrypt('fixture-node-token') });
    h.capture.mockRejectedValueOnce(new Error('not on panel'));
    if (failure === 'unsealed') h.sealed.mockResolvedValue(false);
    if (failure === 'old agent') h.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ND-AGENT {"version":"0.10.0","caps":[]}'] });
    if (failure === 'transfer failure') h.ship.mockRejectedValue(new Error('transfer failed'));
    if (failure === 'wrong image') h.capture.mockResolvedValueOnce(`sha256:${'d'.repeat(64)}`);
    await expect(cacheNodeDockerArtifact(db, { ...ARTIFACT, originServerId: 4 }, { ...service, serverId: 4 }, 1, () => undefined)).rejects.toThrow();
    expect((await db.query.deployments.findFirst())!.artifact).toEqual(ARCHIVED);
    if (failure === 'unsealed' || failure === 'old agent') expect(h.ship).not.toHaveBeenCalled();
  });
  it('archives the exact image and records the returned manifest digest without credentials', async () => {
    const record = await archiveDockerArtifact(db, ARTIFACT, service, () => undefined);
    expect(record).toEqual(ARCHIVED);
    expect(h.run.mock.calls.some(call => JSON.stringify(call[1]) === JSON.stringify(['tag', IMAGE, `registry.example.test/team/app:${'a'.repeat(64)}`]))).toBe(true);
    expect(artifactSummary(record)).toMatchObject({ registryRef: `registry.example.test/team/app@${DIGEST}` });
    expect(JSON.stringify(record)).not.toContain('fixture-registry-secret');
    const login = h.run.mock.calls.find(call => call[1][0] === 'login');
    expect(login?.[1]).not.toContain('fixture-registry-secret');
    expect(login?.[4].toString()).toBe('fixture-registry-secret\n');
  });
  it('accepts a missing local image for enqueue without pulling its valid archive', async () => {
    h.capture.mockRejectedValue(new Error('missing'));
    await assertArtifactAvailable(db, ARCHIVED);
    expect(h.run).not.toHaveBeenCalled();
    await expect(assertArtifactAvailable(db, ARTIFACT)).rejects.toThrow('no rebuild or pull');
  });
  it('restores the panel image by manifest digest and verifies its image ID', async () => {
    h.capture.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(`${IMAGE}|123`).mockResolvedValueOnce(IMAGE);
    await prepareArtifactImage(db, ARCHIVED, service, 1, () => undefined);
    expect(h.run.mock.calls.filter(call => call[1][0] === 'pull').map(call => call[1])).toEqual([['pull', `registry.example.test/team/app@${DIGEST}`]]);
    expect(await db.query.imageTransfers.findFirst()).toMatchObject({ status: 'completed', method: 'registry', imageId: IMAGE });
  });
  it.each(['registry.other.test', 'registry.example.test,registry.other.test'])('refuses revoked or ambiguous credential binding: %s', async hosts => {
    h.capture.mockRejectedValue(new Error('missing'));
    await setBoundRegistryHosts(db, 1, hosts.split(','));
    await expect(prepareArtifactImage(db, ARCHIVED, service, 1, () => undefined)).rejects.toThrow(/binding changed|exactly one/);
    expect(h.run).not.toHaveBeenCalled();
  });
  it('fails a mismatched registry image before it can run and records the failed transfer', async () => {
    h.capture.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(`sha256:${'d'.repeat(64)}|123`);
    await expect(prepareArtifactImage(db, ARCHIVED, service, 1, () => undefined)).rejects.toThrow('not ' + IMAGE);
    expect(await db.query.imageTransfers.findFirst()).toMatchObject({ status: 'failed' });
    expect(h.run.mock.calls.some(call => call[1][0] === 'build')).toBe(false);
    expect(h.run.mock.calls.some(call => call[1][0] === 'logout')).toBe(true);
  });
  it('pulls a copied archive onto a sealed node after original history and local image are gone', async () => {
    await db.insert(servers).values({ id: 4, name: 'node', host: 'node.example.test', tokenEncrypted: encrypt('fixture-node-token') });
    service = { ...service, serverId: 4 };
    await db.delete(deployments).where(eq(deployments.id, 1));
    await db.insert(deployments).values({ id: 2, serviceId: 1, artifact: ARCHIVED });
    h.capture.mockRejectedValue(new Error('missing'));
    await assertArtifactTarget(db, ARCHIVED, service);
    await prepareArtifactImage(db, ARCHIVED, service, 2, () => undefined);
    const ops = h.agentOp.mock.calls.map(call => call[2]);
    expect(ops).toContain('docker.pull');
    expect(ops).not.toContain('git.ensure');
    expect(ops).not.toContain('docker.build');
    expect(h.agentOp.mock.calls.find(call => call[2] === 'docker.pull')?.[3]).toEqual({ image: `registry.example.test/team/app@${DIGEST}` });
    expect(await db.query.imageTransfers.findFirst()).toMatchObject({ targetServerId: 4, deploymentId: 2, status: 'completed' });
  });
  it.each([false, true])('refuses unsealed or old node before registry login (sealed=%s)', async sealed => {
    await db.insert(servers).values({ id: 4, name: 'node', host: 'node.example.test', tokenEncrypted: encrypt('fixture-node-token') });
    h.sealed.mockResolvedValue(sealed);
    h.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ND-AGENT {"version":"0.10.0","caps":[]}'] });
    await expect(prepareArtifactImage(db, ARCHIVED, { ...service, serverId: 4 }, 1, () => undefined)).rejects.toThrow(/unencrypted|agent/i);
    expect(h.agentOp.mock.calls.some(call => call[2] === 'docker.login')).toBe(false);
  });
});
