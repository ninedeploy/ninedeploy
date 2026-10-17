import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfigs, createDb, type DB, runMigrations, services, users } from '@ninedeploy/db';

/**
 * 0.16.1 Dockerfile build arguments: the env-var names a service opts in
 * (`build.buildArgs`) reach `docker build` as `--build-arg KEY=VALUE`, with
 * the values masked wherever the command line is shown. A pre-0.16.1 row has
 * none, so its builds run exactly as before.
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

const { redactedLabel } = await import('../src/lib/exec.js');
const { buildSourceImage, dockerBuildArgs } = await import('../src/engine/builders/docker.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { asUser, buildTestApp } = await import('./helpers.js');

describe('dockerBuildArgs', () => {
  it('passes the listed names that have a value, in order, once each', () => {
    const log = vi.fn();
    const args = dockerBuildArgs(['NEXT_PUBLIC_API', 'NODE_VERSION', 'NEXT_PUBLIC_API'], { NEXT_PUBLIC_API: 'https://api', NODE_VERSION: '22', OTHER: 'x' }, log);
    expect(args).toEqual(['--build-arg', 'NEXT_PUBLIC_API=https://api', '--build-arg', 'NODE_VERSION=22']);
    expect(log).toHaveBeenCalledWith('Build arguments: NEXT_PUBLIC_API, NODE_VERSION');
  });

  it('keeps values verbatim (an `=` or a newline is part of the value)', () => {
    expect(dockerBuildArgs(['K'], { K: 'a=b\nc' }, () => undefined)).toEqual(['--build-arg', 'K=a=b\nc']);
  });

  it('none listed (every pre-0.16.1 service) is no argv and no log line', () => {
    const log = vi.fn();
    expect(dockerBuildArgs(null, { A: '1' }, log)).toEqual([]);
    expect(dockerBuildArgs(undefined, { A: '1' }, log)).toEqual([]);
    expect(dockerBuildArgs([], { A: '1' }, log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('names a listed variable that has no value instead of passing an empty one', () => {
    const log = vi.fn();
    expect(dockerBuildArgs(['A', 'GONE'], { A: '1' }, log)).toEqual(['--build-arg', 'A=1']);
    expect(log.mock.calls.flat().join('\n')).toMatch(/not passed: GONE/);
  });

  it('flags a secret among them (build arguments stay in the image history) without printing its value', () => {
    const log = vi.fn();
    dockerBuildArgs(['TOKEN'], { TOKEN: 's3cr3t' }, log, ['TOKEN']);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toMatch(/TOKEN is a secret/);
    expect(out).toMatch(/image history/);
    expect(out).not.toContain('s3cr3t');
  });
});

describe('the Dockerfile build receives them (wiring)', () => {
  const logged: string[] = [];
  async function build(over: Record<string, unknown>) {
    logged.length = 0;
    const dir = mkdtempSync(path.join(tmpdir(), 'nd-buildargs-'));
    writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\nARG API\n');
    try {
      execMocks.run.mockClear();
      await buildSourceImage(
        {
          deploymentId: 1,
          service: { id: 1, slug: 'web', type: 'docker' },
          workDir: dir,
          commitSha: 'abcdef1234',
          env: { API: 'https://api', SECRET: 'nope' },
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

  it('docker build gets `--build-arg API=…` before the context; unlisted variables stay out', async () => {
    const [argv] = await build({ buildConfig: { buildPack: 'dockerfile', baseDir: '/', buildArgs: ['API'] } });
    expect(argv).toEqual(['build', '-t', 'ninedeploy/web:abcdef1', '-f', 'Dockerfile', '--build-arg', 'API=https://api', '.']);
  });

  it('BuildKit (engine.use_buildkit) gets them too', async () => {
    const calls = await build({ useBuildKit: true, buildConfig: { buildPack: 'dockerfile', baseDir: '/', buildArgs: ['API'] } });
    const buildx = calls.find((a) => a[0] === 'buildx')!;
    expect(buildx.slice(-3)).toEqual(['--build-arg', 'API=https://api', '.']);
    expect(buildx.join(' ')).not.toContain('SECRET');
    // The command line BuildKit logs names the argument and masks its value.
    expect(logged.join('\n')).toContain('--build-arg API=***');
    expect(logged.join('\n')).not.toContain('https://api');
  });

  it('control: a build config without build arguments builds with the exact pre-0.16.1 argv', async () => {
    const [argv] = await build({ buildConfig: { buildPack: 'dockerfile', baseDir: '/', buildArgs: null } });
    expect(argv).toEqual(['build', '-t', 'ninedeploy/web:abcdef1', '-f', 'Dockerfile', '.']);
  });
});

describe('redactedLabel masks build-argument values', () => {
  it('keeps the name, masks the value, in both argv spellings', () => {
    const label = redactedLabel('docker', ['build', '-t', 'img', '--build-arg', 'TOKEN=s3cr3t', '--build-arg=API=https://x', '.']);
    expect(label).toBe('docker build -t img --build-arg TOKEN=*** --build-arg=API=*** .');
    expect(label).not.toContain('s3cr3t');
  });
});

describe('build.buildArgs through the service routes', () => {
  let db: DB;

  beforeEach(async () => {
    ({ db } = createDb({ url: ':memory:' }));
    await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
    await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
  });

  it('a pre-0.16.1 build row reads as none; PATCH stores the names de-duplicated; [] clears back to null', async () => {
    const [svc] = await db
      .insert(services)
      .values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', ownerUserId: 1 } as never)
      .returning();
    await db.insert(buildConfigs).values({ serviceId: svc!.id, buildPack: 'dockerfile', baseDir: '/' });
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });

    const before = (await app.inject({ method: 'GET', url: `/services/${svc!.id}`, headers: asUser() })).json() as { build: { buildArgs: string[] } };
    expect(before.build.buildArgs).toEqual([]);

    const set = await app.inject({
      method: 'PATCH',
      url: `/services/${svc!.id}`,
      headers: asUser(),
      payload: { build: { buildArgs: ['NEXT_PUBLIC_API', ' NODE_VERSION', 'NEXT_PUBLIC_API'] } },
    });
    expect(set.statusCode, set.body).toBe(200);
    const row = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, svc!.id) });
    expect(row?.buildArgs).toEqual(['NEXT_PUBLIC_API', 'NODE_VERSION']);
    // A PATCH of build args leaves the rest of the build config alone.
    expect(row?.buildPack).toBe('dockerfile');
    const after = (await app.inject({ method: 'GET', url: `/services/${svc!.id}`, headers: asUser() })).json() as { build: { buildArgs: string[] } };
    expect(after.build.buildArgs).toEqual(['NEXT_PUBLIC_API', 'NODE_VERSION']);

    const cleared = await app.inject({ method: 'PATCH', url: `/services/${svc!.id}`, headers: asUser(), payload: { build: { buildArgs: [] } } });
    expect(cleared.statusCode).toBe(200);
    expect((await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, svc!.id) }))?.buildArgs).toBeNull();
    await app.close();
  });

  it('refuses a name that is not an environment variable name', async () => {
    const [svc] = await db
      .insert(services)
      .values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', ownerUserId: 1 } as never)
      .returning();
    await db.insert(buildConfigs).values({ serviceId: svc!.id });
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'PATCH', url: `/services/${svc!.id}`, headers: asUser(), payload: { build: { buildArgs: ['A=B'] } } });
    expect(res.statusCode).toBe(400);
    expect((await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, svc!.id) }))?.buildArgs).toBeNull();
    await app.close();
  });
});
