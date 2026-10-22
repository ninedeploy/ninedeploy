import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq, sql } from 'drizzle-orm';
import { createClient } from '@ninedeploy/sdk';
import { createDb, deploymentReleaseRecords, deployments, services, users, type DB } from '@ninedeploy/db';
import { createComposeRelease } from '../src/lib/composeRelease.js';
import { readReleaseRecord, storeReleaseRecord } from '../src/lib/releaseRecords.js';
import { decrypt } from '../src/lib/crypto.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import { buildTestApp } from './helpers.js';

const docker = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../src/lib/exec.js', async (original) => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: docker.capture }));

let db: DB;
let close: () => void;
let owner: number;
let serviceId: number;
let deploymentId: number;
const image = `sha256:${'a'.repeat(64)}`;
const secret = 'release-only-private-$HOME-token';
const record = () => createComposeRelease({ serviceId, slug: 'recorded-stack', composeService: 'web', runtimeId: 'ndcmp-recorded-stack-web-1', port: 80, healthPath: '/' }, JSON.stringify({ services: { web: { image: 'nginx:alpine', environment: { SECRET: secret } } } }), { web: image });

beforeEach(async () => {
  docker.capture.mockReset().mockResolvedValue(`${image}\n`);
  vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'c'.repeat(64));
  vi.stubEnv('NINEDEPLOY_MASTER_KEYS', '');
  const created = createDb({ url: 'file::memory:' });
  db = created.db;
  close = () => created.client?.close();
  await created.ready;
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)) });
  [owner] = (await db.insert(users).values({ email: 'records@example.test', name: 'Operator', passwordHash: 'unused', isInstanceOperator: true }).returning({ id: users.id })).map(r => r.id);
  [serviceId] = (await db.insert(services).values({ name: 'Stack', slug: 'recorded-stack', type: 'compose', ownerUserId: owner, composeContent: 'services: {}', composeService: 'web', port: 80 }).returning({ id: services.id })).map(r => r.id);
  [deploymentId] = (await db.insert(deployments).values({ serviceId, status: 'superseded' }).returning({ id: deployments.id })).map(r => r.id);
});

afterEach(() => { close(); vi.unstubAllEnvs(); });

async function app() {
  const app = await buildTestApp({ db });
  await app.register(deploysRoutes, { prefix: '/v1/services' });
  return app;
}
const headers = () => ({ 'x-test-user': String(owner), 'x-test-operator': 'true' });
const url = (action: string) => `/v1/services/${serviceId}/deploys/${deploymentId}/${action}`;

describe('encrypted release persistence and restore API', () => {
  it('distinguishes Docker failure from missing images and hides host details', async () => {
    await storeReleaseRecord(db, deploymentId, record());
    docker.capture.mockRejectedValue(new Error('daemon unavailable tcp://private-host:2375 secret=private'));
    const server = await app();
    const info = await server.inject({ url: url('release'), headers: headers() });
    expect(info.json()).toMatchObject({ available: false, mode: 'recorded-compose', imageAvailability: 'unknown', missingImageCount: null });
    const response = await server.inject({ method: 'POST', url: url('rollback'), headers: headers() });
    expect(response.statusCode).toBe(400);
    expect(response.body + info.body).not.toContain('private');
    expect(await db.query.deployments.findMany()).toHaveLength(1);
  });

  it('rechecks images on submission after an eligible preview', async () => {
    await storeReleaseRecord(db, deploymentId, record());
    const server = await app();
    expect((await server.inject({ url: url('release'), headers: headers() })).json()).toMatchObject({ available: true, imageAvailability: 'present', missingImageCount: 0 });
    docker.capture.mockResolvedValue('');
    expect((await server.inject({ method: 'POST', url: url('rollback'), headers: headers() })).statusCode).toBe(400);
    expect(await db.query.deployments.findMany()).toHaveLength(1);
    expect(docker.capture).toHaveBeenCalledTimes(2);
    expect(docker.capture).toHaveBeenCalledWith('docker', ['image', 'ls', '--all', '--quiet', '--no-trunc'], { timeoutMs: 10_000, maxOutputBytes: 8 * 1024 * 1024 });
  });

  it('counts unique missing IDs across services and accepts untagged image IDs', async () => {
    const original = record();
    const otherImage = `sha256:${'b'.repeat(64)}`;
    original.model.services = { web: { image, pull_policy: 'never' }, worker: { image, pull_policy: 'never' }, db: { image: otherImage, pull_policy: 'never' } };
    await storeReleaseRecord(db, deploymentId, original);
    docker.capture.mockResolvedValue(`\n${otherImage}\n${otherImage}\n`);
    const server = await app();
    expect((await server.inject({ url: url('release'), headers: headers() })).json()).toMatchObject({ available: false, missingImageCount: 1 });
    docker.capture.mockResolvedValue(`${image}\n${otherImage}\n`);
    expect((await server.inject({ url: url('release'), headers: headers() })).json()).toMatchObject({ available: true, missingImageCount: 0 });
  });

  it('refuses missing recorded images before queueing and reports their absence without secrets', async () => {
    await storeReleaseRecord(db, deploymentId, record());
    docker.capture.mockResolvedValue('');
    const server = await app();
    const info = await server.inject({ url: url('release'), headers: headers() });
    expect(info.json()).toMatchObject({ available: false, imageAvailability: 'missing', missingImageCount: 1 });
    const response = await server.inject({ method: 'POST', url: url('rollback'), headers: headers() });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(image);
    expect(info.body).not.toContain(secret);
    expect(await db.query.deployments.findMany()).toHaveLength(1);
  });

  it('stores encrypted values separately, refuses overwrite, and removes records with their deployment', async () => {
    const original = record();
    await storeReleaseRecord(db, deploymentId, original);
    const row = await db.query.deploymentReleaseRecords.findFirst();
    expect(row!.payloadEncrypted).not.toContain(secret);
    expect(JSON.parse(decrypt(row!.payloadEncrypted))).toEqual(original);
    await storeReleaseRecord(db, deploymentId, { ...original, port: 9000 });
    expect((await readReleaseRecord(db, deploymentId))!.port).toBe(80);
    await db.delete(deployments).where(eq(deployments.id, deploymentId));
    expect(await readReleaseRecord(db, deploymentId)).toBeNull();
  });

  it('returns only metadata and copies immutable restore input before the original is pruned', async () => {
    await storeReleaseRecord(db, deploymentId, record());
    const server = await app();
    const info = await server.inject({ url: url('release'), headers: headers() });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ available: true, mode: 'recorded-compose', imageCount: 1 });
    expect(info.body).not.toContain(secret);
    expect(info.body).not.toContain('payloadEncrypted');
    expect(info.body).not.toContain(image);
    const sdk = createClient({ baseUrl: 'http://panel.test', token: 'fixture', fetch: async (input, init) => {
      const r = await server.inject({ method: (init?.method ?? 'GET') as 'GET', url: new URL(String(input)).pathname, headers: headers() });
      return new Response(r.body, { status: r.statusCode });
    } });
    expect(await sdk.deploys.releaseInfo(serviceId, deploymentId)).toEqual(info.json());
    const response = await server.inject({ method: 'POST', url: url('rollback'), headers: headers() });
    expect(response.statusCode, response.body).toBe(200);
    const queued = response.json().deploymentId as number;
    expect((await db.query.deployments.findFirst({ where: eq(deployments.id, queued) }))!.restoredFromDeploymentId).toBe(deploymentId);
    await db.delete(deployments).where(eq(deployments.id, deploymentId));
    expect(await readReleaseRecord(db, queued)).toEqual(record());
  });

  it('refuses old inline history, unserved records and changed hosts without enqueuing', async () => {
    const server = await app();
    expect((await server.inject({ method: 'POST', url: url('rollback'), headers: headers() })).statusCode).toBe(400);
    await storeReleaseRecord(db, deploymentId, record());
    await db.update(deployments).set({ status: 'failed' }).where(eq(deployments.id, deploymentId));
    expect((await server.inject({ method: 'POST', url: url('rollback'), headers: headers() })).statusCode).toBe(400);
    await db.update(deployments).set({ status: 'superseded' }).where(eq(deployments.id, deploymentId));
    await db.update(services).set({ slug: 'moved-stack' }).where(eq(services.id, serviceId));
    expect((await server.inject({ method: 'POST', url: url('rollback'), headers: headers() })).statusCode).toBe(400);
    expect(await db.query.deployments.findMany()).toHaveLength(1);
  });

  it('does not expose or enqueue corrupt ciphertext or another service record', async () => {
    await storeReleaseRecord(db, deploymentId, record());
    await db.update(deploymentReleaseRecords).set({ payloadEncrypted: 'corrupt' });
    const server = await app();
    expect((await server.inject({ url: url('release'), headers: headers() })).json().available).toBe(false);
    expect((await server.inject({ method: 'POST', url: url('rollback'), headers: headers() })).statusCode).toBe(400);
    const [other] = await db.insert(services).values({ name: 'Other', slug: 'other-recorded', type: 'docker', ownerUserId: owner }).returning({ id: services.id });
    const response = await server.inject({ url: `/v1/services/${other!.id}/deploys/${deploymentId}/release`, headers: headers() });
    expect(response.statusCode).toBe(404);
    expect(await db.query.deployments.findMany()).toHaveLength(1);
  });

  it('keeps service and host privilege checks in front of a restore', async () => {
    await storeReleaseRecord(db, deploymentId, record());
    const server = await app();
    const denied = await server.inject({ method: 'POST', url: url('rollback'), headers: { ...headers(), 'x-test-operator': 'false' } });
    expect(denied.statusCode).toBe(403);
    expect(docker.capture).not.toHaveBeenCalled();
    expect(await db.query.deployments.findMany()).toHaveLength(1);
    const list = await server.inject({ url: `/v1/services/${serviceId}/deploys`, headers: headers() });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain('payloadEncrypted');
  });

  it('rolls back the enqueue when the copied record cannot be stored', async () => {
    await storeReleaseRecord(db, deploymentId, record());
    await db.run(sql.raw(`create trigger reject_copy before insert on deployment_release_records when new.deployment_id != ${deploymentId} begin select raise(abort, 'storage proof'); end`));
    const server = await app();
    const response = await server.inject({ method: 'POST', url: url('rollback'), headers: headers() });
    expect(response.statusCode).toBe(500);
    expect(await db.query.deployments.findMany()).toHaveLength(1);
    expect(await readReleaseRecord(db, deploymentId)).toEqual(record());
  });

  it('refuses a changed primary container identity before enqueuing', async () => {
    await storeReleaseRecord(db, deploymentId, record());
    await db.update(services).set({ runtimeId: 'different-primary-container' }).where(eq(services.id, serviceId));
    const server = await app();
    expect((await server.inject({ url: url('release'), headers: headers() })).json().available).toBe(false);
    expect((await server.inject({ method: 'POST', url: url('rollback'), headers: headers() })).statusCode).toBe(400);
    expect(await db.query.deployments.findMany()).toHaveLength(1);
  });
});
