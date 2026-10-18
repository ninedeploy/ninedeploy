import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, serviceFiles, serviceVolumeAttachments, services, users } from '@ninedeploy/db';

/**
 * 0.16.3 file mounts against a real migrated SQLite: the routes store the
 * content encrypted and keep it from viewers; a deploy writes each file into
 * its own per-deployment directory (older ones pruned) and the docker builder
 * mounts it read-only; anything that would not run as a panel-host docker
 * container is refused rather than started without its files.
 */

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);
// The Docker daemon's view of a path is the path itself in tests.
vi.mock('../src/lib/hostPath.js', () => ({ hostPathFor: vi.fn(async (p: string) => p) }));

const { serviceFileRoutes } = await import('../src/modules/serviceFiles.js');
const { FILE_MOUNTS_PANEL_ONLY, fileMountRefusal, prepareFileMounts, removeServiceFilesDir, serviceFilesDir } = await import('../src/lib/serviceFiles.js');
const { renderRuntimeCompose } = await import('../src/engine/builders/docker.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
const OWNER = 7;
const member = asUser({ id: OWNER, isOperator: false });
let seq = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: OWNER, email: 'owner@example.com', passwordHash: 'x' },
    { id: 9, email: 'other@example.com', passwordHash: 'x' },
  ]);
});

async function setup(values: Record<string, unknown> = {}) {
  const slug = `files-${process.pid}-${++seq}`;
  const [svc] = await db
    .insert(services)
    .values({ name: slug, slug, type: 'docker', image: 'nginx', branch: 'main', ownerUserId: OWNER, ...values } as never)
    .returning();
  const app = await buildTestApp({ db });
  await app.register(serviceFileRoutes, { prefix: '/services' });
  const put = (payload: Record<string, unknown>, headers = member) => app.inject({ method: 'PUT', url: `/services/${svc!.id}/files`, headers, payload });
  const list = () => app.inject({ method: 'GET', url: `/services/${svc!.id}/files`, headers: member });
  return { app, svc: svc!, put, list };
}

describe('file mount routes', () => {
  it('creates, lists, reads, replaces and deletes; the content is encrypted at rest', async () => {
    const { app, svc, put, list } = await setup();
    const created = await put({ path: '/etc/nginx/nginx.conf', content: 'events {}\n' });
    expect(created.statusCode, created.body).toBe(200);
    const { id } = created.json() as { id: number };
    expect(created.json()).toMatchObject({ path: '/etc/nginx/nginx.conf', size: 10 });
    expect(auditMock.audit).toHaveBeenCalledWith(db, OWNER, 'service.file.create', `${svc.name} /etc/nginx/nginx.conf`, { serviceId: svc.id });

    const row = await db.query.serviceFiles.findFirst({ where: eq(serviceFiles.id, id) });
    expect(row?.contentEncrypted).not.toContain('events');

    expect((await put({ path: '/app/b.yaml', content: 'é' })).json()).toMatchObject({ size: 2 });
    expect((await list()).json()).toEqual([
      expect.objectContaining({ path: '/app/b.yaml' }),
      expect.objectContaining({ id, path: '/etc/nginx/nginx.conf', size: 10 }),
    ]);
    expect(JSON.stringify((await list()).json())).not.toContain('events');

    const read = await app.inject({ method: 'GET', url: `/services/${svc.id}/files/${id}`, headers: member });
    expect(read.json()).toMatchObject({ id, path: '/etc/nginx/nginx.conf', content: 'events {}\n' });

    // Same path: replaced in place, same id.
    const replaced = await put({ path: '/etc/nginx/nginx.conf', content: 'events { worker_connections 64; }' });
    expect(replaced.json()).toMatchObject({ id });
    expect(auditMock.audit).toHaveBeenCalledWith(db, OWNER, 'service.file.update', expect.any(String), { serviceId: svc.id });

    expect((await app.inject({ method: 'DELETE', url: `/services/${svc.id}/files/${id}`, headers: member })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'DELETE', url: `/services/${svc.id}/files/${id}`, headers: member })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/services/${svc.id}/files/${id}`, headers: member })).statusCode).toBe(404);
    await app.close();
  });

  it('refuses bad paths, a path a volume already uses, and more than 20 files', async () => {
    const { app, svc, put } = await setup({ volumeMount: '/data/app.db' });
    for (const path of ['/etc/hosts', '/proc/x', 'relative.conf', '/a/../b', '/dir/']) expect((await put({ path, content: 'x' })).statusCode, path).toBe(400);
    expect((await put({ path: '/data/app.db', content: 'x' })).statusCode).toBe(409);
    await db.insert(serviceVolumeAttachments).values({ serviceId: svc.id, volumeName: 'shared', containerPath: '/shared/x.conf' });
    const onVolume = await put({ path: '/shared/x.conf', content: 'x' });
    expect(onVolume.statusCode).toBe(409);
    expect(onVolume.json().error.message).toMatch(/volume shared/);
    for (let i = 0; i < 20; i++) expect((await put({ path: `/app/f${i}.conf`, content: 'x' })).statusCode).toBe(200);
    expect((await put({ path: '/app/one-too-many.conf', content: 'x' })).statusCode).toBe(409);
    // Replacing an existing one is still fine at the limit.
    expect((await put({ path: '/app/f0.conf', content: 'y' })).statusCode).toBe(200);
    await app.close();
  });

  it('refuses a service whose container would not get the files', async () => {
    for (const values of [{ serverId: null, type: 'compose', image: null }, { orchestrator: 'swarm' }]) {
      const { app, put } = await setup(values);
      const res = await put({ path: '/app/x.conf', content: 'x' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(FILE_MOUNTS_PANEL_ONLY);
      await app.close();
    }
  });

  it('needs a member seat to read content or change files; a viewer still lists them', async () => {
    const { app, svc, put } = await setup();
    const { id } = (await put({ path: '/app/x.conf', content: 'secret=1' })).json() as { id: number };
    const outsider = asUser({ id: 9, isOperator: false });
    expect((await app.inject({ method: 'GET', url: `/services/${svc.id}/files`, headers: outsider })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/services/${svc.id}/files/${id}`, headers: outsider })).statusCode).toBe(404);
    expect((await put({ path: '/app/y.conf', content: 'x' }, outsider)).statusCode).toBe(404);
    await app.close();
  });
});

describe('deploy-time file mounts', () => {
  it('writes each file into the deployment directory (0644), returns read-only mounts, and keeps three deployments', async () => {
    const { svc, put, app } = await setup();
    await put({ path: '/etc/nginx/nginx.conf', content: 'events {}' });
    await put({ path: '/app/config.yaml', content: 'a: 1' });
    const log = vi.fn();
    const mounts = await prepareFileMounts(db, svc, 11, log);
    expect(mounts.map((m) => m.containerPath).sort()).toEqual(['/app/config.yaml', '/etc/nginx/nginx.conf']);
    for (const m of mounts) {
      expect(path.dirname(m.hostPath)).toBe(path.join(serviceFilesDir(svc.slug), 'd11'));
      if (process.platform !== 'win32') expect(statSync(m.hostPath).mode & 0o777).toBe(0o644);
    }
    const nginx = mounts.find((m) => m.containerPath === '/etc/nginx/nginx.conf')!;
    expect(readFileSync(nginx.hostPath, 'utf8')).toBe('events {}');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^File mounts: .*\(read-only\)$/));

    for (const d of [12, 13, 14]) await prepareFileMounts(db, svc, d, () => undefined);
    expect(readdirSync(serviceFilesDir(svc.slug)).sort()).toEqual(['d12', 'd13', 'd14']);

    removeServiceFilesDir(svc.slug);
    expect(existsSync(serviceFilesDir(svc.slug))).toBe(false);
    await app.close();
  });

  it('a service without files writes nothing and mounts nothing', async () => {
    const { svc, app } = await setup();
    expect(await prepareFileMounts(db, svc, 1, () => undefined)).toEqual([]);
    expect(existsSync(serviceFilesDir(svc.slug))).toBe(false);
    await app.close();
  });

  it('refuses a node, Swarm, compose or pm2 service that has files; never one without', async () => {
    const { svc, put, app } = await setup();
    expect(await fileMountRefusal(db, svc)).toBeNull();
    for (const shape of [{ serverId: 4 }, { orchestrator: 'swarm' }, { type: 'compose' }, { type: 'pm2' }]) {
      expect(await fileMountRefusal(db, { ...svc, ...shape })).toBeNull();
    }
    await put({ path: '/app/x.conf', content: 'x' });
    expect(await fileMountRefusal(db, svc)).toBeNull();
    for (const shape of [{ serverId: 4 }, { orchestrator: 'swarm' }, { type: 'compose' }, { type: 'pm2' }]) {
      expect(await fileMountRefusal(db, { ...svc, ...shape })).toBe(FILE_MOUNTS_PANEL_ONLY);
    }
    await app.close();
  });

  it('the compose fallback (multi-line env) mounts them too', () => {
    const yaml = renderRuntimeCompose({
      name: 'web-1',
      image: 'nginx',
      restart: 'unless-stopped',
      bridge: 'nd-svc-web',
      cpuShares: 0,
      cpuLimitMilli: 0,
      memLimitMb: 0,
      dataVolume: null,
      dataMount: null,
      attachments: [],
      fileMounts: [{ hostPath: '/srv/nd/service-files/web/d3/5', containerPath: '/app/x.conf' }],
      publishedPort: null,
      containerPort: null,
      dockerSocket: false,
      cmd: null,
      envFile: '/tmp/env',
      labels: [],
      runtimeOptions: null,
      portMappings: null,
    } as never);
    expect(yaml).toContain('/srv/nd/service-files/web/d3/5:/app/x.conf:ro');
  });
});
