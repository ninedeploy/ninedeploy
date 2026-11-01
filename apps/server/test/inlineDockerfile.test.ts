/** G1.1 inline Dockerfile: the settings row, the routes, and writing it into a build context. */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
// The clone's retained-volume check asks the local Docker; answer "no volumes" offline.
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async () => ''),
  run: vi.fn(async () => undefined),
}));

const lib = await import('../src/lib/inlineDockerfile.js');
const { inlineDockerfileRoutes } = await import('../src/modules/inlineDockerfile.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, repoUrl: 'https://github.com/acme/api' },
    { id: 6, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.27' },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

const DOCKERFILE = '# syntax=docker/dockerfile:1\nFROM node:22-alpine\nCOPY . .\nCMD ["node","index.js"]\n';

describe('routes', () => {
  it('stores, reads and clears the Dockerfile; refuses image services and text that is not a Dockerfile', async () => {
    const app = await buildTestApp({ db });
    await app.register(inlineDockerfileRoutes, { prefix: '/services' });
    const put = (id: number, content: unknown) => app.inject({ method: 'PUT', url: `/services/${id}/inline-dockerfile`, headers: asUser(1), payload: { content } as object });
    expect((await app.inject({ method: 'GET', url: '/services/5/inline-dockerfile', headers: asUser(1) })).json()).toEqual({ content: null });
    expect((await put(5, DOCKERFILE)).json()).toEqual({ content: DOCKERFILE });
    expect(await lib.getInlineDockerfile(db, 5)).toBe(DOCKERFILE);
    expect((await put(5, 'echo hi')).statusCode).toBe(400);
    expect((await put(5, `FROM x\n${'#'.repeat(70_000)}`)).statusCode).toBe(400);
    const image = await put(6, DOCKERFILE);
    expect(image.statusCode).toBe(400);
    expect(JSON.stringify(image.json())).toContain('inline_dockerfile_unsupported');
    expect((await put(5, null)).json()).toEqual({ content: null });
    await app.close();
  });
});

describe('clone', () => {
  // A temp file, not `:memory:`: the clone runs a libsql transaction (see domainTransfersAuthority.test.ts).
  it('copies the inline Dockerfile with the rest of the build definition', async () => {
    const { createDb } = await import('@ninedeploy/db');
    const { migrate } = await import('drizzle-orm/libsql/migrator');
    const { fileURLToPath } = await import('node:url');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-inline-clone-'));
    const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
    const fileDb = created.db;
    try {
      await migrate(fileDb, { migrationsFolder: fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)) });
      await fileDb.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
      await fileDb.insert(services).values([
        { id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, repoUrl: 'https://github.com/acme/api' },
        { id: 6, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.27' },
      ] as never);
      await lib.setInlineDockerfile(fileDb, 5, DOCKERFILE);
      const app = await buildTestApp({ db: fileDb });
      await app.register(servicesRoutes);
      const operator = asUser({ id: 1, isOperator: true });
      const res = await app.inject({ method: 'POST', url: '/5/clone', headers: operator, payload: { name: 'api copy' } });
      expect(res.statusCode, res.body).toBe(200);
      const copy = res.json().id as number;
      expect(copy).not.toBe(5);
      expect(await lib.getInlineDockerfile(fileDb, copy)).toBe(DOCKERFILE);
      // A service without one clones without one.
      const plain = await app.inject({ method: 'POST', url: '/6/clone', headers: operator, payload: { name: 'web copy' } });
      expect(await lib.getInlineDockerfile(fileDb, plain.json().id as number)).toBeNull();
      await app.close();
    } finally {
      created.client?.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file lock */
      }
    }
  });
});

describe('build context', () => {
  it('writes the file into the base directory and answers its repository-relative path', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'nd-inline-'));
    mkdirSync(path.join(workDir, 'apps', 'api'), { recursive: true });
    writeFileSync(path.join(workDir, 'apps', 'api', 'Dockerfile'), 'FROM scratch\n');
    const rel = lib.writeInlineDockerfile(workDir, '/apps/api', DOCKERFILE);
    expect(rel).toBe('apps/api/.ninedeploy.Dockerfile');
    expect(readFileSync(path.join(workDir, rel), 'utf8')).toBe(DOCKERFILE);
    // The repository's own Dockerfile stays; the build uses the pasted one.
    expect(readFileSync(path.join(workDir, 'apps', 'api', 'Dockerfile'), 'utf8')).toBe('FROM scratch\n');
  });

  it('refuses a base directory outside the checkout or through a symlink, and empties a context', () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'nd-inline-'));
    expect(() => lib.writeInlineDockerfile(workDir, '../../etc', DOCKERFILE)).toThrow(/outside the repository/);
    if (process.platform !== 'win32') {
      symlinkSync(os.tmpdir(), path.join(workDir, 'evil'));
      expect(() => lib.writeInlineDockerfile(workDir, 'evil', DOCKERFILE)).toThrow(/symlink/);
    }
    writeFileSync(path.join(workDir, 'old.txt'), 'x');
    lib.prepareEmptyContext(workDir);
    expect(readdirSync(workDir)).toEqual([]);
    expect(lib.inlineDockerfileSha(DOCKERFILE)).toMatch(/^[0-9a-f]{40}$/);
  });
});
