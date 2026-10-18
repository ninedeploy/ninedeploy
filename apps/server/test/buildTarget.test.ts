import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfigs, createDb, type DB, runMigrations, services, users } from '@ninedeploy/db';

/**
 * 0.16.2 Dockerfile build stage: `build.buildTarget` reaches `docker build`
 * (and BuildKit) as `--target <stage>`. A pre-0.16.2 row has none, so its
 * builds run with the exact argv they had before.
 *
 * Real migrated SQLite for the route round trip; Docker and Traefik are fakes.
 */

const execMocks = vi.hoisted(() => ({
  run: vi.fn(async (..._args: unknown[]) => undefined),
  capture: vi.fn(async (..._args: unknown[]) => ''),
}));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  run: execMocks.run,
  capture: execMocks.capture,
}));
vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentOp: vi.fn(async () => ({ exitCode: 0, lines: [] })),
}));
vi.mock('../src/engine/proxy.js', () => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => null),
  getStickyEnabledForService: vi.fn(async () => false),
  NETWORK: 'ninedeploy',
  TRAEFIK_CONTAINER: 'ninedeploy-traefik',
  TRAEFIK_IMAGE: 'traefik:3',
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { buildSourceImage } = await import('../src/engine/builders/docker.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { asUser, buildTestApp } = await import('./helpers.js');

describe('the Dockerfile build stops at the stage (wiring)', () => {
  const logged: string[] = [];
  async function build(over: Record<string, unknown>) {
    logged.length = 0;
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-buildtarget-'));
    writeFileSync(path.join(dir, 'Dockerfile'), 'FROM alpine AS build\nFROM scratch AS runtime\nFROM alpine AS dev\n');
    try {
      execMocks.run.mockClear();
      await buildSourceImage(
        {
          deploymentId: 1,
          service: { id: 1, slug: 'web', type: 'docker' },
          workDir: dir,
          commitSha: 'abcdef1234',
          env: { API: 'https://api' },
          log: (line: string) => logged.push(line),
          ...over,
        } as never,
        'ninedeploy/web:abcdef1',
      );
      return execMocks.run.mock.calls.map((c) => c[1] as string[]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('docker build gets `--target runtime` before the context, after the build arguments', async () => {
    const [argv] = await build({ buildConfig: { buildPack: 'dockerfile', baseDir: '/', buildArgs: ['API'], buildTarget: 'runtime' } });
    expect(argv).toEqual(['build', '-t', 'ninedeploy/web:abcdef1', '-f', 'Dockerfile', '--build-arg', 'API=https://api', '--target', 'runtime', '.']);
    expect(logged).toContain('Building stage "runtime" of Dockerfile');
  });

  it('BuildKit (engine.use_buildkit) gets it too', async () => {
    const calls = await build({ useBuildKit: true, buildConfig: { buildPack: 'dockerfile', baseDir: '/', buildTarget: 'runtime' } });
    const buildx = calls.find((a) => a[0] === 'buildx')!;
    expect(buildx.slice(-3)).toEqual(['--target', 'runtime', '.']);
  });

  it('control: a build config without a stage builds with the exact pre-0.16.2 argv', async () => {
    const [argv] = await build({ buildConfig: { buildPack: 'dockerfile', baseDir: '/', buildTarget: null } });
    expect(argv).toEqual(['build', '-t', 'ninedeploy/web:abcdef1', '-f', 'Dockerfile', '.']);
    expect(logged.join('\n')).not.toContain('Building stage');
  });
});

describe('build.buildTarget through the service routes', () => {
  let db: DB;

  beforeEach(async () => {
    ({ db } = createDb({ url: ':memory:' }));
    await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
    await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
  });

  async function setup() {
    const [svc] = await db
      .insert(services)
      .values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', ownerUserId: 1 } as never)
      .returning();
    await db.insert(buildConfigs).values({ serviceId: svc!.id, buildPack: 'dockerfile', baseDir: '/' });
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    const row = async () => db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, svc!.id) });
    const patch = (build: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/services/${svc!.id}`, headers: asUser(), payload: { build } });
    return { app, id: svc!.id, row, patch };
  }

  it('a pre-0.16.2 build row reads as none; PATCH stores a stage; "" and null clear it', async () => {
    const { app, id, row, patch } = await setup();
    const read = async () => ((await app.inject({ method: 'GET', url: `/services/${id}`, headers: asUser() })).json() as { build: { buildTarget: string | null } }).build;
    expect((await read()).buildTarget).toBeNull();

    expect((await patch({ buildTarget: 'runtime' })).statusCode).toBe(200);
    expect(await row()).toMatchObject({ buildTarget: 'runtime', buildPack: 'dockerfile' });
    expect((await read()).buildTarget).toBe('runtime');
    // A PATCH of something else leaves the stage alone.
    expect((await patch({ buildCmd: 'make' })).statusCode).toBe(200);
    expect((await row())?.buildTarget).toBe('runtime');

    expect((await patch({ buildTarget: '' })).statusCode).toBe(200);
    expect((await row())?.buildTarget).toBeNull();
    await patch({ buildTarget: 'runtime' });
    expect((await patch({ buildTarget: null })).statusCode).toBe(200);
    expect((await row())?.buildTarget).toBeNull();
    await app.close();
  });

  it('refuses a stage name Docker would not take, or one that reads as a flag', async () => {
    const { app, row, patch } = await setup();
    for (const bad of ['--push', '-t', '1st', 'two words']) expect((await patch({ buildTarget: bad })).statusCode).toBe(400);
    expect((await row())?.buildTarget).toBeNull();
    await app.close();
  });
});
