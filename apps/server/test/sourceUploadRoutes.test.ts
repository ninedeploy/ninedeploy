import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, runMigrations, services, users } from '@ninedeploy/db';

/**
 * 0.16.1 `POST/GET /v1/services/:id/source` against a real migrated SQLite:
 * an upload-sourced service takes an archive and queues a deploy of exactly
 * that upload; every other service, a node service whose placement cannot
 * fetch it and a broken archive are refused, the first two before the body
 * is read.
 */

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
// 0.16.7: a node service's deploy is checked against the node (it pings it).
const remote = vi.hoisted(() => ({ assertRemoteServiceSupported: vi.fn(async (_db: unknown, _svc: unknown) => undefined) }));
vi.mock('../src/lib/remoteDeploy.js', () => remote);

const { sourceUploadRoutes } = await import('../src/modules/sourceUploads.js');
const { listSourceUploads, removeSourceUploads } = await import('../src/lib/sourceUpload.js');
const { asUser, buildTestApp } = await import('./helpers.js');

/** A one-file stored zip. */
function zipOf(name: string, text: string): Buffer {
  const n = Buffer.from(name);
  const d = Buffer.from(text);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(crc32(d), 14);
  local.writeUInt32LE(d.length, 18);
  local.writeUInt32LE(d.length, 22);
  local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt32LE(crc32(d), 16);
  cd.writeUInt32LE(d.length, 20);
  cd.writeUInt32LE(d.length, 24);
  cd.writeUInt16LE(n.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + n.length, 12);
  eocd.writeUInt32LE(30 + n.length + d.length, 16);
  return Buffer.concat([local, n, d, cd, n, eocd]);
}

let db: DB;
let made: number[] = [];

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
});
afterEach(() => {
  for (const id of made) removeSourceUploads(id);
  made = [];
});

async function setup(values: Record<string, unknown> = {}) {
  const [svc] = await db
    .insert(services)
    .values({ name: 'drop', slug: `drop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type: 'docker', branch: 'main', ownerUserId: 1, ...values } as never)
    .returning();
  made.push(svc!.id);
  const app = await buildTestApp({ db });
  await app.register(sourceUploadRoutes, { prefix: '/services' });
  return { app, id: svc!.id };
}

const upload = (id: number, body: Buffer, query = '') => ({
  method: 'POST' as const,
  url: `/services/${id}/source${query}`,
  headers: { ...asUser(), 'content-type': 'application/zip' },
  payload: body,
});

describe('POST /services/:id/source', () => {
  it('keeps the archive and queues a deploy pinned to it', async () => {
    const { app, id } = await setup();
    const res = await app.inject(upload(id, zipOf('Dockerfile', 'FROM nginx\n')));
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { sha: string; format: string; entries: number; deploymentId: number };
    expect(body).toMatchObject({ format: 'zip', entries: 1 });
    const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, body.deploymentId) });
    expect(dep).toMatchObject({ serviceId: id, status: 'queued', commitSha: body.sha });
    expect(dep?.message).toMatch(/^Uploaded source/);
    expect(listSourceUploads(id).map((u) => u.sha)).toEqual([body.sha]);

    const list = (await app.inject({ method: 'GET', url: `/services/${id}/source`, headers: asUser() })).json();
    expect(list).toMatchObject({ uploadSourced: true, uploads: [{ sha: body.sha, format: 'zip' }] });
    await app.close();
  });

  it('?deploy=false only keeps it', async () => {
    const { app, id } = await setup();
    const res = await app.inject(upload(id, zipOf('a.txt', 'x'), '?deploy=false'));
    expect(res.statusCode).toBe(201);
    expect(res.json().deploymentId).toBeNull();
    expect(await db.query.deployments.findMany({ where: eq(deployments.serviceId, id) })).toEqual([]);
    await app.close();
  });

  it('a service with a repository or an image says uploads are not for it (409)', async () => {
    for (const values of [{ repoUrl: 'https://github.com/acme/web.git' }, { image: 'nginx:latest' }]) {
      const { app, id } = await setup(values);
      const res = await app.inject(upload(id, zipOf('a', 'x')));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/Uploads are for a service created without one/);
      expect(listSourceUploads(id)).toEqual([]);
      await app.close();
    }
  });

  it('0.16.7: a node service takes uploads (built on the panel, shipped); its deploy is checked against the node first', async () => {
    const { servers } = await import('@ninedeploy/db');
    const { HttpError } = await import('../src/lib/errors.js');
    const [node] = await db.insert(servers).values({ name: 'n1', host: '10.0.0.2', tokenEncrypted: 'v1:x' } as never).returning();
    const { app, id } = await setup({ serverId: node!.id });
    remote.assertRemoteServiceSupported.mockClear();
    const res = await app.inject(upload(id, zipOf('Dockerfile', 'FROM nginx\n')));
    expect(res.statusCode, res.body).toBe(201);
    expect(remote.assertRemoteServiceSupported).toHaveBeenCalledTimes(1);
    expect(remote.assertRemoteServiceSupported.mock.calls[0]![1]).toMatchObject({ id, serverId: node!.id });
    const dep = await db.query.deployments.findFirst({ where: eq(deployments.id, res.json().deploymentId) });
    expect(dep).toMatchObject({ serviceId: id, status: 'queued' });

    // ?deploy=false only keeps it: the node is not asked.
    remote.assertRemoteServiceSupported.mockClear();
    expect((await app.inject(upload(id, zipOf('a.txt', 'y'), '?deploy=false'))).statusCode).toBe(201);
    expect(remote.assertRemoteServiceSupported).not.toHaveBeenCalled();

    // A node that cannot receive an image refuses before anything is kept.
    remote.assertRemoteServiceSupported.mockRejectedValueOnce(new HttpError(422, 'node_agent_outdated', 'Node "n1" cannot receive an image'));
    const kept = listSourceUploads(id).length;
    const old = await app.inject(upload(id, zipOf('b.txt', 'z')));
    expect(old.statusCode).toBe(422);
    expect(old.json().error).toMatchObject({ code: 'node_agent_outdated' });
    expect(listSourceUploads(id)).toHaveLength(kept);
    await app.close();
  });

  it('0.16.7: a node service whose placement is the node or a build server is refused (it cannot fetch the archive)', async () => {
    const { servers } = await import('@ninedeploy/db');
    const [node] = await db.insert(servers).values({ name: 'n1', host: '10.0.0.2', tokenEncrypted: 'v1:x' } as never).returning();
    for (const buildOn of ['target', 'server']) {
      const { app, id } = await setup({ serverId: node!.id, buildOn });
      const res = await app.inject(upload(id, zipOf('a', 'x')));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'remote_deploy_unsupported' });
      expect(res.json().error.message).toMatch(/a node or a build server cannot fetch the archive/);
      expect(listSourceUploads(id)).toEqual([]);
      await app.close();
    }
    // Build on: panel, chosen, takes it.
    const { app, id } = await setup({ serverId: node!.id, buildOn: 'panel' });
    expect((await app.inject(upload(id, zipOf('a', 'x'), '?deploy=false'))).statusCode).toBe(201);
    await app.close();
  });

  it('a broken or hostile archive is a 400 naming why, and nothing is kept or queued', async () => {
    const { app, id } = await setup();
    const res = await app.inject(upload(id, Buffer.from('definitely not an archive')));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'invalid_archive' });
    expect(res.json().error.message).toMatch(/\.zip or a \.tar\.gz/);
    const evil = zipOf('../escape.sh', 'x');
    const res2 = await app.inject(upload(id, evil));
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.message).toMatch(/Unsafe path/);
    expect(listSourceUploads(id)).toEqual([]);
    expect(await db.query.deployments.findMany({ where: eq(deployments.serviceId, id) })).toEqual([]);
    await app.close();
  });

  it('a JSON body is told to send the raw archive', async () => {
    const { app, id } = await setup();
    const res = await app.inject({ method: 'POST', url: `/services/${id}/source`, headers: asUser(), payload: { file: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/raw request body/);
    await app.close();
  });
});
