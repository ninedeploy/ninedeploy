import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, hostIps, runMigrations, servers, services, users } from '@ninedeploy/db';

/**
 * 0.16.1 IP inventory of the panel host (`/v1/host-ips`): detected addresses
 * merged with what operators saved, one primary at a time, an address
 * dedicated to one docker service on the panel host, and the effects — a
 * dedicated address refused to every other service's port mappings, the
 * primary address offered for automatic URLs. Real migrated SQLite; the
 * host's interfaces are faked.
 */

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
const HOST = [
  { ip: '203.0.113.7', family: 4 as const, iface: 'eth0' },
  { ip: '203.0.113.8', family: 4 as const, iface: 'eth0' },
  { ip: '2001:db8::7', family: 6 as const, iface: 'eth0' },
];
const live = vi.hoisted(() => ({
  listHostAddresses: vi.fn(async (): Promise<Array<{ ip: string; family: 4 | 6; iface: string }> | null> => null),
}));
vi.mock('../src/lib/hostAddresses.js', () => live);
vi.mock('../src/engine/proxy.js', () => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => null),
  getStickyEnabledForService: vi.fn(async () => false),
  NETWORK: 'ninedeploy',
  TRAEFIK_CONTAINER: 'ninedeploy-traefik',
  TRAEFIK_IMAGE: 'traefik:3',
}));

const { hostIpRoutes } = await import('../src/modules/hostIps.js');
const { hostAddressRoutes } = await import('../src/modules/hostAddresses.js');
const { servicesRoutes } = await import('../src/modules/services.js');
const { hostPortConflict } = await import('../src/lib/hostPort.js');
const { primaryHostIp } = await import('../src/lib/hostIps.js');
const { asUser, buildTestApp } = await import('./helpers.js');

let db: DB;
const OWNER = 7;
const member = asUser({ id: OWNER, isOperator: false });

beforeEach(async () => {
  vi.clearAllMocks();
  live.listHostAddresses.mockResolvedValue(HOST);
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: OWNER, email: 'owner@example.com', passwordHash: 'x' },
  ]);
});

async function setup() {
  const [voice, game] = await db
    .insert(services)
    .values([
      { name: 'voice', slug: 'voice', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER },
      { name: 'game', slug: 'game', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER },
    ] as never)
    .returning();
  const app = await buildTestApp({ db });
  await app.register(hostIpRoutes, { prefix: '/host-ips' });
  await app.register(servicesRoutes, { prefix: '/services' });
  await app.register(hostAddressRoutes, { prefix: '/services' });
  const put = (ip: string, payload: object, headers = asUser()) => app.inject({ method: 'PUT', url: `/host-ips/${encodeURIComponent(ip)}`, headers, payload });
  const list = async () => (await app.inject({ method: 'GET', url: '/host-ips', headers: asUser() })).json() as { detected: boolean; addresses: Array<Record<string, unknown>> };
  return { app, voice: voice!, game: game!, put, list };
}

describe('host IP inventory', () => {
  it('a panel with nothing saved lists the detected addresses, none primary or dedicated', async () => {
    const { app, list } = await setup();
    expect(await list()).toEqual({
      detected: true,
      addresses: [
        { ip: '203.0.113.7', family: 4, iface: 'eth0', detected: true, label: null, primary: false, dedicatedTo: null },
        { ip: '203.0.113.8', family: 4, iface: 'eth0', detected: true, label: null, primary: false, dedicatedTo: null },
        { ip: '2001:db8::7', family: 6, iface: 'eth0', detected: true, label: null, primary: false, dedicatedTo: null },
      ],
    });
    expect((await app.inject({ method: 'GET', url: '/host-ips/primary', headers: member })).json()).toEqual({ ip: null });
    await app.close();
  });

  it('labels an address and keeps one primary at a time', async () => {
    const { app, put, list } = await setup();
    const first = await put('203.0.113.7', { label: 'main', primary: true });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ ip: '203.0.113.7', label: 'main', primary: true });
    expect((await put('2001:DB8::7', { primary: true })).json()).toMatchObject({ ip: '2001:db8::7', primary: true });
    const view = await list();
    expect(view.addresses.filter((a) => a.primary).map((a) => a.ip)).toEqual(['2001:db8::7']);
    expect(view.addresses.find((a) => a.ip === '203.0.113.7')).toMatchObject({ label: 'main', primary: false });
    expect(await primaryHostIp(db)).toBe('2001:db8::7');
    expect((await app.inject({ method: 'GET', url: '/host-ips/primary', headers: member })).json()).toEqual({ ip: '2001:db8::7' });
    // An empty label clears it.
    expect((await put('203.0.113.7', { label: '' })).json()).toMatchObject({ label: null });
    await app.close();
  });

  it('refuses an address the host does not have, a malformed one and unknown fields; operators only', async () => {
    const { app, put } = await setup();
    const unknown = await put('198.51.100.9', { label: 'x' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toMatch(/not an address of this server \(it has 203\.0\.113\.7, 203\.0\.113\.8, 2001:db8::7\)/);
    expect((await put('0.0.0.0', { label: 'x' })).statusCode).toBe(400);
    expect((await put('not-an-ip', { label: 'x' })).statusCode).toBe(400);
    expect((await put('203.0.113.7', { colour: 'red' })).statusCode).toBe(400);
    expect((await put('203.0.113.7', { label: 'x' }, member)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/host-ips', headers: member })).statusCode).toBe(403);
    await app.close();
  });

  it('when the host cannot be read, a saved address stays listed and a new one is taken as given', async () => {
    const { app, put, list } = await setup();
    await put('203.0.113.7', { label: 'main' });
    live.listHostAddresses.mockResolvedValue(null);
    expect((await put('198.51.100.9', { label: 'failover' })).statusCode).toBe(200);
    const view = await list();
    expect(view.detected).toBe(false);
    expect(view.addresses.map((a) => [a.ip, a.detected, a.iface])).toEqual([
      ['203.0.113.7', false, null],
      ['198.51.100.9', false, null],
    ]);
    expect((await app.inject({ method: 'DELETE', url: '/host-ips/198.51.100.9', headers: asUser() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/host-ips/198.51.100.9', headers: asUser() })).statusCode).toBe(404);
    expect((await list()).addresses.map((a) => a.ip)).toEqual(['203.0.113.7']);
    await app.close();
  });

  it('a dedicated address is refused to every other service, and offered to its own', async () => {
    const { app, voice, game, put } = await setup();
    const dedicate = await put('203.0.113.8', { serviceId: voice.id });
    expect(dedicate.statusCode, dedicate.body).toBe(200);
    expect(dedicate.json()).toMatchObject({ dedicatedTo: { id: voice.id, name: 'voice' } });

    const patch = (id: number, payload: object) => app.inject({ method: 'PATCH', url: `/services/${id}`, headers: asUser(), payload });
    const taken = await patch(game.id, { portMappings: [{ hostIp: '203.0.113.8', hostPort: 53, containerPort: 53, protocol: 'udp' }] });
    expect(taken.statusCode).toBe(409);
    expect(taken.body).toMatch(/203\.0\.113\.8 is dedicated to service \\"voice\\"/);
    expect((await patch(voice.id, { portMappings: [{ hostIp: '203.0.113.8', hostPort: 53, containerPort: 53, protocol: 'udp' }] })).statusCode).toBe(200);
    expect(await hostPortConflict(db, game.id, null, null, [{ hostIp: '203.0.113.7', hostPort: 53, containerPort: 53, protocol: 'udp' }])).toBeNull();

    const forVoice = (await app.inject({ method: 'GET', url: `/services/${voice.id}/host-addresses`, headers: asUser() })).json() as { addresses: Array<Record<string, unknown>> };
    expect(forVoice.addresses.find((a) => a.ip === '203.0.113.8')).toMatchObject({ dedicated: 'self' });
    const forGame = (await app.inject({ method: 'GET', url: `/services/${game.id}/host-addresses`, headers: asUser() })).json() as { addresses: Array<Record<string, unknown>> };
    expect(forGame.addresses.find((a) => a.ip === '203.0.113.8')).toMatchObject({ dedicated: 'other' });
    expect(forGame.addresses.find((a) => a.ip === '203.0.113.7')).toMatchObject({ dedicated: null });

    // Shared again: anyone may bind it.
    expect((await put('203.0.113.8', { serviceId: null })).json()).toMatchObject({ dedicatedTo: null });
    expect(await hostPortConflict(db, game.id, null, null, [{ hostIp: '203.0.113.8', hostPort: 54, containerPort: 54, protocol: 'udp' }])).toBeNull();
    await app.close();
  });

  it('dedication is refused while another service binds the address, and for a non-docker or node service', async () => {
    const { app, voice, game, put } = await setup();
    await db.update(services).set({ portMappings: [{ hostIp: '203.0.113.8', hostPort: 9000, hostPortEnd: null, containerPort: 9000, protocol: 'udp' }] }).where((await import('drizzle-orm')).eq(services.id, game.id));
    const held = await put('203.0.113.8', { serviceId: voice.id });
    expect(held.statusCode).toBe(409);
    expect(held.body).toMatch(/Service \\"game\\" publishes ports on 203\.0\.113\.8/);

    const [node] = await db.insert(servers).values({ name: 'n1', host: '198.51.100.20', tokenEncrypted: 'v1:x' }).returning();
    const [remote, stack] = await db
      .insert(services)
      .values([
        { name: 'remote', slug: 'remote', type: 'docker', image: 'x', branch: 'main', ownerUserId: OWNER, serverId: node!.id },
        { name: 'stack', slug: 'stack', type: 'compose', branch: 'main', ownerUserId: OWNER },
      ] as never)
      .returning();
    expect((await put('203.0.113.7', { serviceId: remote!.id })).statusCode).toBe(400);
    expect((await put('203.0.113.7', { serviceId: stack!.id })).statusCode).toBe(400);
    expect((await put('203.0.113.7', { serviceId: 999 })).statusCode).toBe(404);
    expect(await db.select().from(hostIps)).toEqual([]);
    await app.close();
  });

  it('deleting the service shares its address again', async () => {
    const { app, voice, put, list } = await setup();
    await put('203.0.113.8', { serviceId: voice.id, label: 'voice ip' });
    await db.delete(services).where((await import('drizzle-orm')).eq(services.id, voice.id));
    expect((await list()).addresses.find((a) => a.ip === '203.0.113.8')).toMatchObject({ label: 'voice ip', dedicatedTo: null });
    await app.close();
  });
});
