import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, domains, runMigrations, services, users } from '@ninedeploy/db';

/**
 * 0.16.11 scale to zero through the services routes: the PATCH that sets
 * `sleepAfterMinutes`, putting a service to sleep and waking it by hand, and
 * start / stop ending a sleep. Docker and the proxy are faked.
 */

const h = vi.hoisted(() => ({
  run: vi.fn(async (..._a: unknown[]) => undefined),
  capture: vi.fn(async (..._a: unknown[]) => ''),
  isHealthy: vi.fn(async (..._a: unknown[]) => true),
  writeDynamicConfig: vi.fn(async (..._a: unknown[]) => undefined),
  audit: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: h.audit }));
// Stop uses exec directly, outside sleepDeps. Keep this route test independent
// of a real Docker daemon, just like the sleep/wake operations below.
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  run: h.run,
  capture: h.capture,
}));
vi.mock('../src/lib/sleepRuntime.js', () => ({
  sleepDeps: (db: DB) => ({
    db,
    docker: async (args: string[]) => {
      await h.run('docker', args);
    },
    probe: async () => h.isHealthy(),
    writeConfig: () => h.writeDynamicConfig(db),
    audit: (action: string, entity: string, meta: Record<string, unknown>) => h.audit(db, null, action, entity, meta),
    sleep: async () => undefined,
    log: () => undefined,
  }),
}));
const reach = vi.hoisted(() => ({ wakeUnreachableReason: vi.fn(async (): Promise<string | null> => null) }));
vi.mock('../src/lib/panelUpstream.js', () => ({ ...reach, panelWakeUpstream: () => 'http://host.docker.internal:3000', detectPanelOnNetwork: async () => false }));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: h.writeDynamicConfig,
}));

const { servicesRoutes } = await import('../src/modules/services.js');
const { resetSleepState } = await import('../src/lib/sleep.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
let app: Awaited<ReturnType<typeof buildTestApp>>;
const OWNER = asUser({ id: 2, isOperator: false });
const row = async () => (await db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 5) }))!;

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 2, email: 'owner@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, status: 'running', runtimeId: 'web-9', port: 3000 },
    { id: 6, name: 'stack', slug: 'stack', type: 'compose', branch: 'main', ownerUserId: 2 },
  ] as never);
  await db.insert(domains).values({ serviceId: 5, hostname: 'web.example.com', path: '/', status: 'active' } as never);
  app = await buildTestApp({ db });
  await app.register(servicesRoutes, { prefix: '/v1/services' });
  for (const f of Object.values(h)) f.mockClear();
  resetSleepState();
});
afterEach(async () => {
  await app.close();
});

describe('sleepAfterMinutes', () => {
  it('is stored and shown, with asleepAt; null turns it off; only docker services take it', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { sleepAfterMinutes: 15 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ sleepAfterMinutes: 15, asleepAt: null });
    expect((await app.inject({ method: 'PATCH', url: '/v1/services/5', headers: OWNER, payload: { sleepAfterMinutes: null } })).json().sleepAfterMinutes).toBeNull();
    const compose = await app.inject({ method: 'PATCH', url: '/v1/services/6', headers: OWNER, payload: { sleepAfterMinutes: 15 } });
    expect(compose.statusCode).toBe(400);
    expect(compose.json().error.message).toBe('Scale to zero applies to docker services only');
  });
});

describe('POST /:id/sleep and /:id/wake', () => {
  it('puts a service to sleep by hand and wakes it again', async () => {
    const sleep = await app.inject({ method: 'POST', url: '/v1/services/5/sleep', headers: OWNER });
    expect(sleep.statusCode, sleep.body).toBe(200);
    expect((await row()).asleepAt).not.toBeNull();
    expect(h.run).toHaveBeenCalledWith('docker', ['stop', '-t', '10', 'web-9']);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), 2, 'service.sleep_now', 'web #5', { serviceId: 5 });
    expect((await app.inject({ url: '/v1/services/5', headers: OWNER })).json().asleepAt).toEqual(expect.any(String));
    const again = await app.inject({ method: 'POST', url: '/v1/services/5/sleep', headers: OWNER });
    expect(again.json().error).toMatchObject({ code: 'cannot_sleep', message: 'Cannot put the service to sleep: the service is asleep already' });

    const wake = await app.inject({ method: 'POST', url: '/v1/services/5/wake', headers: OWNER });
    expect(wake.statusCode, wake.body).toBe(200);
    expect((await row()).asleepAt).toBeNull();
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), null, 'service.wake', 'web', expect.objectContaining({ trigger: 'manual' }));
    expect((await app.inject({ method: 'POST', url: '/v1/services/5/wake', headers: OWNER })).json().error.code).toBe('not_asleep');
  });

  it('a wake that fails is a 409 and the service stays asleep', async () => {
    await db.update(services).set({ asleepAt: new Date(0) });
    h.isHealthy.mockResolvedValueOnce(false);
    const res = await app.inject({ method: 'POST', url: '/v1/services/5/wake', headers: OWNER });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('wake_failed');
    expect((await row()).asleepAt).not.toBeNull();
  });

  it('refuses what could never be woken, or slept at all', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'compose' }, 'scale to zero applies to docker services only'],
      [{ serverId: null, status: 'stopped' }, 'the service is not running'],
      [{ orchestrator: 'swarm', status: 'running' }, 'scale to zero does not apply to Swarm services'],
    ];
    for (const [set, reason] of cases) {
      await db.update(services).set({ type: 'docker', status: 'running', orchestrator: null, ...set } as never);
      const res = await app.inject({ method: 'POST', url: '/v1/services/5/sleep', headers: OWNER });
      expect(res.json().error.message).toBe(`Cannot put the service to sleep: ${reason}`);
    }
    await db.update(services).set({ orchestrator: null, status: 'running' });
    // Never put to sleep what Traefik could not wake.
    reach.wakeUnreachableReason.mockResolvedValueOnce('Traefik cannot reach the panel at http://x:3000');
    expect((await app.inject({ method: 'POST', url: '/v1/services/5/sleep', headers: OWNER })).json().error.message).toBe(
      'Cannot put the service to sleep: Traefik cannot reach the panel at http://x:3000',
    );
    await db.delete(domains);
    expect((await app.inject({ method: 'POST', url: '/v1/services/5/sleep', headers: OWNER })).json().error.message).toMatch(/no domain routes/);
  });

  it('a stale row loses the race to a deploy: 409 sleep_failed', async () => {
    // The guarded asleepAt write finds the row changed under it (a deploy finished meanwhile).
    const real = db.update.bind(db);
    vi.spyOn(db, 'update').mockImplementation(((t: never) => {
      const q = real(t);
      return {
        set: (v: Record<string, unknown>) => (v.asleepAt ? { where: () => ({ returning: async () => [] }) } : q.set(v)),
      };
    }) as never);
    const res = await app.inject({ method: 'POST', url: '/v1/services/5/sleep', headers: OWNER });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('sleep_failed');
    vi.restoreAllMocks();
  });
});

describe('start and stop end a sleep', () => {
  it('start wakes a sleeping service instead of a plain start', async () => {
    await db.update(services).set({ asleepAt: new Date(0) });
    const res = await app.inject({ method: 'POST', url: '/v1/services/5/start', headers: OWNER });
    expect(res.json()).toEqual({ ok: true, status: 'running' });
    expect((await row()).asleepAt).toBeNull();
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), null, 'service.wake', 'web', expect.objectContaining({ trigger: 'start' }));
  });

  it('stop clears the sleep and routes the domains back to the service', async () => {
    await db.update(services).set({ asleepAt: new Date(0) });
    const res = await app.inject({ method: 'POST', url: '/v1/services/5/stop', headers: OWNER });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.capture).toHaveBeenCalledWith('docker', ['stop', '-t', '5', 'web-9']);
    expect(await row()).toMatchObject({ status: 'stopped', asleepAt: null });
    expect(h.writeDynamicConfig).toHaveBeenCalled();
  });
});
