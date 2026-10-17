import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, services, users } from '@ninedeploy/db';
import { runtimeOptions, updateService } from '@ninedeploy/schemas';

/**
 * 0.16.1 advanced container options and the per-service healthcheck timeout:
 * the schema admits only the structured, allowlisted fields; only an operator
 * changes the options; the docker run line and its compose twin carry exactly
 * the same flags; a pre-0.16.1 service (both columns null) runs as before.
 *
 * Real migrated SQLite for the routes; Docker and Traefik are fakes.
 */

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

const { renderRuntimeCompose, runtimeOptionArgs } = await import('../src/engine/builders/docker.js');
const { normalizeRuntimeOptions, servicesRoutes } = await import('../src/modules/services.js');
const { asUser, buildTestApp } = await import('./helpers.js');

describe('runtimeOptions schema', () => {
  it('accepts the structured fields', () => {
    expect(runtimeOptions.safeParse({ gpus: 'all', shmSizeMb: 1024, init: true, ulimitNofile: 65536, capAdd: ['NET_ADMIN', 'SYS_PTRACE'] }).success).toBe(true);
    expect(runtimeOptions.safeParse({ gpus: 2 }).success).toBe(true);
  });

  it('refuses capabilities that lead out of the container, unknown keys and out-of-range values', () => {
    for (const cap of ['SYS_ADMIN', 'SYS_MODULE', 'DAC_READ_SEARCH', 'ALL']) expect(runtimeOptions.safeParse({ capAdd: [cap] }).success, cap).toBe(false);
    // No free-form flags: privileged, host network or a host mount cannot be asked for.
    expect(runtimeOptions.safeParse({ privileged: true }).success).toBe(false);
    expect(runtimeOptions.safeParse({ extraArgs: ['--network=host'] }).success).toBe(false);
    expect(runtimeOptions.safeParse({ gpus: 0 }).success).toBe(false);
    expect(runtimeOptions.safeParse({ gpus: 'device=0' }).success).toBe(false);
    expect(runtimeOptions.safeParse({ shmSizeMb: 0 }).success).toBe(false);
    expect(runtimeOptions.safeParse({ ulimitNofile: 10 }).success).toBe(false);
  });

  it('bounds the healthcheck timeout to 10–3600 s; null restores the default', () => {
    expect(updateService.safeParse({ healthTimeoutSeconds: 900 }).success).toBe(true);
    expect(updateService.safeParse({ healthTimeoutSeconds: null }).success).toBe(true);
    expect(updateService.safeParse({ healthTimeoutSeconds: 5 }).success).toBe(false);
    expect(updateService.safeParse({ healthTimeoutSeconds: 7200 }).success).toBe(false);
  });
});

describe('docker run flags and the compose twin', () => {
  const all = { gpus: 'all' as const, shmSizeMb: 2048, init: true, ulimitNofile: 65536, capAdd: ['NET_ADMIN', 'SYS_PTRACE'] };

  it('maps every option to its docker run flag', () => {
    expect(runtimeOptionArgs(all)).toEqual([
      '--gpus', 'all', '--shm-size', '2048m', '--init', '--ulimit', 'nofile=65536:65536', '--cap-add', 'NET_ADMIN', '--cap-add', 'SYS_PTRACE',
    ]);
    expect(runtimeOptionArgs({ gpus: 2 })).toEqual(['--gpus', '2']);
  });

  it('none set (every pre-0.16.1 service) is no flag at all', () => {
    expect(runtimeOptionArgs(null)).toEqual([]);
    expect(runtimeOptionArgs(undefined)).toEqual([]);
    expect(runtimeOptionArgs({})).toEqual([]);
  });

  const base = {
    name: 'web-1', image: 'img', restart: 'unless-stopped', bridge: 'nd-svc-web', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0,
    dataVolume: null, dataMount: null, attachments: [], publishedPort: null, containerPort: null, dockerSocket: false, cmd: null, envFile: null,
  };

  it('renders the same options as compose keys', () => {
    const yaml = renderRuntimeCompose({ ...base, runtimeOptions: all });
    expect(yaml).toContain('    shm_size: "2048m"');
    expect(yaml).toContain('    init: true');
    expect(yaml).toContain('    ulimits:\n      nofile:\n        soft: 65536\n        hard: 65536');
    expect(yaml).toContain('    cap_add:\n      - "NET_ADMIN"\n      - "SYS_PTRACE"');
    expect(yaml).toContain('            - driver: "nvidia"\n              count: "all"\n              capabilities: ["gpu"]');
    expect(renderRuntimeCompose({ ...base, runtimeOptions: { gpus: 3 } })).toContain('              count: 3');
  });

  it('control: without options the compose file is byte-identical to before', () => {
    expect(renderRuntimeCompose({ ...base, runtimeOptions: null })).toBe(renderRuntimeCompose(base));
    expect(renderRuntimeCompose(base)).not.toMatch(/shm_size|cap_add|ulimits|init:|deploy:/);
  });
});

describe('normalizeRuntimeOptions', () => {
  it('drops unset, false and empty fields, sorts capabilities, and reads nothing as null', () => {
    expect(normalizeRuntimeOptions({ gpus: null, shmSizeMb: null, init: false, capAdd: [] })).toBeNull();
    expect(normalizeRuntimeOptions(null)).toBeNull();
    expect(normalizeRuntimeOptions({ init: true, capAdd: ['SYS_PTRACE', 'NET_ADMIN', 'SYS_PTRACE'] })).toEqual({ init: true, capAdd: ['NET_ADMIN', 'SYS_PTRACE'] });
  });
});

describe('PATCH /services/:id', () => {
  let db: DB;
  const OWNER = 7;

  beforeEach(async () => {
    ({ db } = createDb({ url: ':memory:' }));
    await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
    await db.insert(users).values([
      { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
      { id: OWNER, email: 'owner@example.com', passwordHash: 'x' },
    ]);
  });

  async function setup(values: Record<string, unknown> = {}) {
    const [svc] = await db
      .insert(services)
      .values({ name: 'ollama', slug: 'ollama', type: 'docker', image: 'ollama/ollama', branch: 'main', ownerUserId: OWNER, ...values } as never)
      .returning();
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    const row = async () => (await db.query.services.findFirst({ where: eq(services.id, svc!.id) }))!;
    return { app, id: svc!.id, row };
  }
  const member = asUser({ id: OWNER, isOperator: false });

  it('a pre-0.16.1 service reads both fields as null', async () => {
    const { app, id } = await setup();
    const body = (await app.inject({ method: 'GET', url: `/services/${id}`, headers: asUser() })).json() as Record<string, unknown>;
    expect(body['runtimeOptions']).toBeNull();
    expect(body['healthTimeoutSeconds']).toBeNull();
    await app.close();
  });

  it('an operator sets the options (stored normalised) and clears them with null', async () => {
    const { app, id, row } = await setup();
    const set = await app.inject({
      method: 'PATCH',
      url: `/services/${id}`,
      headers: asUser(),
      payload: { runtimeOptions: { gpus: 'all', shmSizeMb: 1024, init: false, capAdd: ['SYS_PTRACE', 'NET_ADMIN'] } },
    });
    expect(set.statusCode, set.body).toBe(200);
    expect((await row()).runtimeOptions).toEqual({ gpus: 'all', shmSizeMb: 1024, capAdd: ['NET_ADMIN', 'SYS_PTRACE'] });
    const body = (await app.inject({ method: 'GET', url: `/services/${id}`, headers: asUser() })).json() as Record<string, unknown>;
    expect(body['runtimeOptions']).toEqual({ gpus: 'all', shmSizeMb: 1024, capAdd: ['NET_ADMIN', 'SYS_PTRACE'] });

    const cleared = await app.inject({ method: 'PATCH', url: `/services/${id}`, headers: asUser(), payload: { runtimeOptions: null } });
    expect(cleared.statusCode).toBe(200);
    expect((await row()).runtimeOptions).toBeNull();
    await app.close();
  });

  it('a member cannot change them, but may re-send them unchanged and edit everything else', async () => {
    const { app, id, row } = await setup({ runtimeOptions: { gpus: 'all' } });
    const denied = await app.inject({ method: 'PATCH', url: `/services/${id}`, headers: member, payload: { runtimeOptions: { gpus: 'all', capAdd: ['NET_ADMIN'] } } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toMatch(/Operator access required: advanced container options/);
    const cleared = await app.inject({ method: 'PATCH', url: `/services/${id}`, headers: member, payload: { runtimeOptions: null } });
    expect(cleared.statusCode).toBe(403);
    expect((await row()).runtimeOptions).toEqual({ gpus: 'all' });

    const same = await app.inject({ method: 'PATCH', url: `/services/${id}`, headers: member, payload: { runtimeOptions: { gpus: 'all' }, healthTimeoutSeconds: 900 } });
    expect(same.statusCode, same.body).toBe(200);
    expect((await row()).healthTimeoutSeconds).toBe(900);
    await app.close();
  });

  it('refuses options on a service that is not a docker service', async () => {
    const { app, id } = await setup({ type: 'compose', image: null });
    const res = await app.inject({ method: 'PATCH', url: `/services/${id}`, headers: asUser(), payload: { runtimeOptions: { init: true } } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('a member sets and resets the healthcheck timeout', async () => {
    const { app, id, row } = await setup();
    expect((await app.inject({ method: 'PATCH', url: `/services/${id}`, headers: member, payload: { healthTimeoutSeconds: 1200 } })).statusCode).toBe(200);
    expect((await row()).healthTimeoutSeconds).toBe(1200);
    expect((await app.inject({ method: 'PATCH', url: `/services/${id}`, headers: member, payload: { healthTimeoutSeconds: null } })).statusCode).toBe(200);
    expect((await row()).healthTimeoutSeconds).toBeNull();
    expect((await app.inject({ method: 'PATCH', url: `/services/${id}`, headers: member, payload: { healthTimeoutSeconds: 1 } })).statusCode).toBe(400);
    await app.close();
  });
});
