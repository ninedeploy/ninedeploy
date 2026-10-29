/**
 * G4.3 DigitalOcean droplets (`lib/digitaloceanCloud.ts`, `modules/cloud.ts`)
 * against a migrated in-memory SQLite. The DigitalOcean API is a fake router
 * in place of `guardedFetch`; nothing leaves the process. What happens after
 * the VM exists (rekey, sweep) is Hetzner's code, tested in hetznerCloud.test.ts.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { servers, services, settings, type DB } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return { guardedFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>() };
});
vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/egressGuard.js')>();
  return { ...actual, guardedFetch: h.guardedFetch };
});

const lib = await import('../../src/lib/digitaloceanCloud.js');
const hetzner = await import('../../src/lib/hetznerCloud.js');
const { decrypt } = await import('../../src/lib/crypto.js');
const { cloudRoutes } = await import('../../src/modules/cloud.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, json, migratedDb } = await import('./githubAppKit.js');

const TOKEN = `dop_v1_${'a'.repeat(60)}wxyz`;

interface Call {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}
let calls: Call[];
let routes: Array<{ method: string; path: RegExp; reply: (c: Call) => Response }>;
const on = (method: string, path: RegExp, reply: (c: Call) => Response) => routes.unshift({ method, path, reply });

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  calls = [];
  routes = [];
  h.guardedFetch.mockReset();
  h.guardedFetch.mockImplementation(async (url, init) => {
    const u = new URL(String(url));
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: u.pathname.replace(/^\/v2/, ''),
      search: u.search,
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const route = routes.find((r) => r.method === call.method && r.path.test(call.path));
    return route ? route.reply(call) : json(404, { id: 'not_found', message: 'The resource you were accessing could not be found.' });
  });
  on('GET', /^\/account$/, () => json(200, { account: { status: 'active' } }));
});
afterEach(() => closeMigratedDb(db));

const saveToken = () => lib.saveDigitalOceanToken(db, TOKEN);
const droplet = (id: number, ip?: string) => ({ id, status: 'new', networks: { v4: ip ? [{ ip_address: '10.0.0.2', type: 'private' }, { ip_address: ip, type: 'public' }] : [] } });
const FAST = { addressStepMs: 1, addressTimeoutMs: 200 };

describe('token', () => {
  it('is proven with a read call, stored encrypted and shown back only as a hint', async () => {
    expect(await lib.digitalOceanStatus(db)).toEqual({ configured: false, tokenHint: null });
    expect(await saveToken()).toEqual({ configured: true, tokenHint: '…wxyz' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/account', auth: `Bearer ${TOKEN}` });
    const row = await db.query.settings.findFirst({ where: eq(settings.key, 'digitalocean_token_encrypted') });
    expect(String(row?.value)).not.toContain(TOKEN);
    expect(decrypt(String(row?.value))).toBe(TOKEN);
    await lib.deleteDigitalOceanToken(db);
    expect((await lib.digitalOceanStatus(db)).configured).toBe(false);
  });

  it('is not stored when DigitalOcean refuses it; an unreachable API is a 502', async () => {
    on('GET', /^\/account$/, () => json(401, { id: 'unauthorized', message: 'Unable to authenticate you' }));
    await expect(saveToken()).rejects.toMatchObject({ statusCode: 400, code: 'digitalocean_api_error' });
    h.guardedFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(saveToken()).rejects.toMatchObject({ statusCode: 502, code: 'digitalocean_unreachable' });
    expect((await lib.digitalOceanStatus(db)).configured).toBe(false);
    await expect(lib.digitalOceanOptions(db)).rejects.toMatchObject({ statusCode: 409, code: 'digitalocean_not_configured' });
  });
});

describe('options', () => {
  it('lists available regions and sizes, and only the distributions the bootstrap supports', async () => {
    await saveToken();
    on('GET', /^\/regions$/, () => json(200, { regions: [{ slug: 'fra1', name: 'Frankfurt 1', available: true }, { slug: 'old1', name: 'Old', available: false }] }));
    on('GET', /^\/sizes$/, () =>
      json(200, {
        sizes: [
          { slug: 's-1vcpu-1gb', description: 'Basic', vcpus: 1, memory: 1024, disk: 25, price_monthly: 6, regions: ['fra1', 'ams3'], available: true },
          { slug: 'gone', vcpus: 1, memory: 512, disk: 10, price_monthly: 4, regions: [], available: false },
        ],
      }),
    );
    on('GET', /^\/images$/, () =>
      json(200, {
        images: [
          { slug: 'ubuntu-24-04-x64', distribution: 'Ubuntu', name: '24.04 (LTS) x64', regions: ['fra1'] },
          { slug: 'rockylinux-9-x64', distribution: 'Rocky Linux', name: '9 x64', regions: ['fra1'] },
          { slug: 'freebsd-14', distribution: 'FreeBSD', name: '14', regions: ['fra1'] },
          { slug: null, distribution: 'Ubuntu', name: 'no slug', regions: [] },
          { slug: 'debian-old', distribution: 'Debian', name: 'old', status: 'retired', regions: [] },
        ],
      }),
    );
    on('GET', /^\/account\/keys$/, () => json(200, { ssh_keys: [{ id: 7, name: 'laptop', fingerprint: 'aa:bb' }] }));
    expect(await lib.digitalOceanOptions(db)).toEqual({
      regions: [{ slug: 'fra1', name: 'Frankfurt 1' }],
      sizes: [{ slug: 's-1vcpu-1gb', description: 'Basic', vcpus: 1, memoryGb: 1, diskGb: 25, priceMonthly: 6, regions: ['ams3', 'fra1'] }],
      images: [
        { slug: 'rockylinux-9-x64', description: 'Rocky Linux 9 x64', regions: ['fra1'] },
        { slug: 'ubuntu-24-04-x64', description: 'Ubuntu 24.04 (LTS) x64', regions: ['fra1'] },
      ],
      sshKeys: [{ id: 7, name: 'laptop', fingerprint: 'aa:bb' }],
    });
  });
});

describe('create', () => {
  const input = { name: 'edge-do', region: 'fra1', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', sshKeyIds: [7] };

  it('creates a tagged droplet whose user data starts the agent, waits for its public IPv4, and registers an offline node', async () => {
    await saveToken();
    on('POST', /^\/droplets$/, () => json(202, { droplet: droplet(4242) }));
    let reads = 0;
    on('GET', /^\/droplets\/4242$/, () => (++reads < 2 ? json(500, { id: 'server_error', message: 'try again' }) : json(200, { droplet: droplet(4242, '203.0.113.9') })));
    const waitForAgent = vi.fn();
    const created = await lib.createDigitalOceanServer(db, input, { waitForAgent, ...FAST });
    expect(created).toEqual({ serverId: expect.any(Number), providerServerId: 4242, ipv4: '203.0.113.9' });

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ name: 'edge-do', region: 'fra1', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64', ssh_keys: [7], tags: ['ninedeploy'], ipv6: true });
    const node = await db.query.servers.findFirst({ where: eq(servers.id, created.serverId) });
    expect(node).toMatchObject({ name: 'edge-do', host: '203.0.113.9', port: 4600, status: 'offline' });
    const agentToken = decrypt(node!.tokenEncrypted);
    // The user data carries only the hash of the agent key, and asks for the rekey.
    const userData = String(post.body!['user_data']);
    expect(userData).toContain(createHash('sha256').update(agentToken).digest('hex'));
    expect(userData).not.toContain(agentToken);
    expect(waitForAgent).toHaveBeenCalledWith(created.serverId, '203.0.113.9', 4600, agentToken);
    // Linked like a Hetzner node, so the shared rekey and sweep cover it.
    expect(await hetzner.cloudNodeAwaitingRekey(db, created.serverId)).toBe(true);
    expect((await hetzner.readCloudLinks(db)).map((l) => l.link.provider)).toEqual(['digitalocean']);
  });

  it('deletes the droplet again when it gets no public IPv4, or when its address is still another node', async () => {
    await saveToken();
    on('POST', /^\/droplets$/, () => json(202, { droplet: droplet(5) }));
    on('GET', /^\/droplets\/5$/, () => json(200, { droplet: droplet(5) }));
    on('DELETE', /^\/droplets\/5$/, () => new Response(null, { status: 204 }));
    await expect(lib.createDigitalOceanServer(db, input, FAST)).rejects.toMatchObject({ statusCode: 502, code: 'digitalocean_no_ipv4' });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/droplets/5')).toBe(true);

    calls = [];
    await db.insert(servers).values({ name: 'old', host: '198.51.100.1', port: 4600, tokenEncrypted: 'x', status: 'online' });
    on('POST', /^\/droplets$/, () => json(202, { droplet: droplet(6, '198.51.100.1') }));
    on('DELETE', /^\/droplets\/6$/, () => new Response(null, { status: 204 }));
    await expect(lib.createDigitalOceanServer(db, input, FAST)).rejects.toMatchObject({ statusCode: 409 });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/droplets/6')).toBe(true);
  });
});

describe('list and delete', () => {
  async function created() {
    await saveToken();
    on('POST', /^\/droplets$/, () => json(202, { droplet: droplet(77, '203.0.113.20') }));
    return lib.createDigitalOceanServer(db, { name: 'd1', region: 'fra1', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' }, FAST);
  }

  it('lists our droplets with DigitalOcean’s status, and only DigitalOcean’s nodes', async () => {
    expect(await lib.listDigitalOceanServers(db)).toEqual([]);
    const { serverId } = await created();
    on('GET', /^\/droplets$/, (c) => (c.search.includes('tag_name=ninedeploy') ? json(200, { droplets: [{ id: 77, status: 'active' }] }) : json(400, {})));
    const [row] = await lib.listDigitalOceanServers(db);
    expect(row).toMatchObject({ serverId, provider: 'digitalocean', providerServerId: 77, location: 'fra1', serverType: 's-1vcpu-1gb', providerStatus: 'active', nodeStatus: 'offline' });
    expect(await hetzner.listHetznerServers(db)).toEqual([]);
    // DigitalOcean unreadable: the row stays, with no provider status.
    on('GET', /^\/droplets$/, () => json(500, { id: 'server_error', message: 'x' }));
    expect((await lib.listDigitalOceanServers(db))[0]!.providerStatus).toBeNull();
  });

  it('deletes the droplet and the node, refuses while the node hosts a service, and finishes when the droplet is already gone', async () => {
    const { serverId } = await created();
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', serverId } as never).returning();
    await expect(lib.deleteDigitalOceanServer(db, serverId)).rejects.toMatchObject({ statusCode: 409, code: 'server_hosts_services' });
    await db.delete(services).where(eq(services.id, svc!.id));

    // 404 from DigitalOcean: already gone, the panel side is still cleaned up.
    expect(await lib.deleteDigitalOceanServer(db, serverId)).toEqual({ providerServerId: 77, name: 'd1' });
    expect(await db.query.servers.findFirst({ where: eq(servers.id, serverId) })).toBeUndefined();
    expect(await hetzner.readCloudLinks(db)).toEqual([]);
    await expect(lib.deleteDigitalOceanServer(db, serverId)).rejects.toMatchObject({ statusCode: 404 });
    // A Hetzner node is not DigitalOcean's to delete.
    await expect(hetzner.deleteHetznerServer(db, serverId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a DigitalOcean refusal other than 404 keeps the node', async () => {
    const { serverId } = await created();
    on('DELETE', /^\/droplets\/77$/, () => json(403, { id: 'forbidden', message: 'no' }));
    await expect(lib.deleteDigitalOceanServer(db, serverId)).rejects.toMatchObject({ code: 'digitalocean_api_error' });
    expect(await db.query.servers.findFirst({ where: eq(servers.id, serverId) })).toBeDefined();
  });
});

describe('routes', () => {
  it('are operator only, validate the body, and audit the token and the server', async () => {
    const app = await buildTestApp({ db });
    await app.register(cloudRoutes, { prefix: '/cloud' });
    const OP = asUser({ id: 1, isOperator: true });
    const MEMBER = asUser({ id: 2, isOperator: false });
    expect((await app.inject({ url: '/cloud/digitalocean', headers: MEMBER })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/cloud/digitalocean/token', headers: OP, payload: { token: 'short' } })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: '/cloud/digitalocean/token', headers: OP, payload: { token: TOKEN } });
    expect(put.json()).toEqual({ configured: true, tokenHint: '…wxyz' });
    on('GET', /^\/regions$/, () => json(200, { regions: [] }));
    on('GET', /^\/sizes$/, () => json(200, { sizes: [] }));
    on('GET', /^\/images$/, () => json(200, { images: [] }));
    on('GET', /^\/account\/keys$/, () => json(200, { ssh_keys: [] }));
    expect((await app.inject({ url: '/cloud/digitalocean/options', headers: OP })).json()).toEqual({ regions: [], sizes: [], images: [], sshKeys: [] });

    on('POST', /^\/droplets$/, () => json(202, { droplet: droplet(9, '203.0.113.30') }));
    const create = await app.inject({
      method: 'POST',
      url: '/cloud/digitalocean/servers',
      headers: OP,
      payload: { name: 'route-do', region: 'fra1', size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' },
    });
    expect(create.statusCode, create.body).toBe(200);
    const { serverId } = create.json() as { serverId: number };
    expect((await app.inject({ url: '/cloud/digitalocean/servers', headers: OP })).json()).toHaveLength(1);
    on('DELETE', /^\/droplets\/9$/, () => new Response(null, { status: 204 }));
    expect((await app.inject({ method: 'DELETE', url: `/cloud/digitalocean/servers/${serverId}`, headers: OP })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'DELETE', url: '/cloud/digitalocean/token', headers: OP })).json()).toEqual({ configured: false, tokenHint: null });
    await app.close();
  });
});
