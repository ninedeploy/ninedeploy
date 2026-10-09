import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, servers, services, users } from '@ninedeploy/db';
import { servicePlacementView } from '@ninedeploy/schemas';

/**
 * 0.16 T8 surfaces: the additive response fields the SDK, CLI and web read.
 *
 *  - `GET /v1/services/:id` carries `placement` (design §6.6), the same view
 *    as `GET /v1/services/:id/placement`; a 0.15 row reads all nulls.
 *  - `GET /v1/servers` carries the Swarm membership recorded on join
 *    (`swarmNodeId`, `swarmRole`); a node not in the swarm reads nulls.
 *
 * Real migrated SQLite; Docker, the agent and Traefik are fakes.
 */

vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async () => ''),
  run: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentOp: vi.fn(async () => ({ exitCode: 0, lines: [] })),
  agentPingLines: vi.fn(async () => ({ lines: [] })),
  agentTransportSealed: vi.fn(async () => true),
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

const { servicesRoutes } = await import('../src/modules/services.js');
const { servicePlacementRoutes } = await import('../src/modules/servicePlacement.js');
const { serverRoutes } = await import('../src/modules/servers.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
});

async function service(values: Record<string, unknown> = {}) {
  const [svc] = await db
    .insert(services)
    .values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', ownerUserId: 1, ...values } as never)
    .returning();
  return svc!;
}

describe('GET /v1/services/:id carries placement (design §6.6)', () => {
  it('a 0.15 row reads every key null; a set placement reads back, equal to GET /:id/placement', async () => {
    const app = await buildTestApp({ db });
    await app.register(servicesRoutes, { prefix: '/services' });
    await app.register(servicePlacementRoutes, { prefix: '/services' });
    const svc = await service();

    const before = (await app.inject({ method: 'GET', url: `/services/${svc.id}`, headers: asUser() })).json() as Record<string, unknown>;
    expect(before['placement']).toEqual({ buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: null });
    expect(servicePlacementView.safeParse(before['placement']).success).toBe(true);

    await db.update(services).set({ buildOn: 'panel', orchestrator: 'container' }).where(eq(services.id, svc.id));
    const detail = (await app.inject({ method: 'GET', url: `/services/${svc.id}`, headers: asUser() })).json() as Record<string, unknown>;
    const own = (await app.inject({ method: 'GET', url: `/services/${svc.id}/placement`, headers: asUser() })).json();
    expect(detail['placement']).toEqual({ buildOn: 'panel', buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: 'container' });
    expect(detail['placement']).toEqual(own);
    // The 0.15 detail fields are unchanged.
    expect(detail).toMatchObject({ id: svc.id, name: 'web', build: null });

    // The list endpoint stays as it was (detail only).
    const list = (await app.inject({ method: 'GET', url: '/services', headers: asUser() })).json() as Array<Record<string, unknown>>;
    expect(list[0]).not.toHaveProperty('placement');
    await app.close();
  });
});

describe('GET /v1/servers carries the Swarm membership', () => {
  it('null for a node outside the swarm; the recorded id and role once it joined', async () => {
    const app = await buildTestApp({ db });
    await app.register(serverRoutes, { prefix: '/servers' });
    const [row] = await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'offline' }).returning();

    const [outside] = (await app.inject({ method: 'GET', url: '/servers', headers: asUser() })).json() as Array<Record<string, unknown>>;
    expect(outside).toMatchObject({ id: row!.id, swarmNodeId: null, swarmRole: null });
    // The earlier additive fields are still there.
    expect(outside).toHaveProperty('features');
    expect(outside).toHaveProperty('databases', 0);

    await db.update(servers).set({ swarmNodeId: 'abcdefghijklmnopqrstuvwxy', swarmRole: 'worker' }).where(eq(servers.id, row!.id));
    const [member] = (await app.inject({ method: 'GET', url: '/servers', headers: asUser() })).json() as Array<Record<string, unknown>>;
    expect(member).toMatchObject({ swarmNodeId: 'abcdefghijklmnopqrstuvwxy', swarmRole: 'worker' });
    expect(Object.keys(member!)).not.toContain('tokenEncrypted');
    await app.close();
  });
});
