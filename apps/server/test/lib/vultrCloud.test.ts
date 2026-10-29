/**
 * G4.3 Vultr instances (`lib/vultrCloud.ts`, `modules/cloud.ts`) against a
 * migrated in-memory SQLite. The Vultr API is a fake router in place of
 * `guardedFetch`; nothing leaves the process. What happens after the VM
 * exists (rekey, sweep) is Hetzner's code, tested in hetznerCloud.test.ts.
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

const lib = await import('../../src/lib/vultrCloud.js');
const hetzner = await import('../../src/lib/hetznerCloud.js');
const { decrypt } = await import('../../src/lib/crypto.js');
const { cloudRoutes } = await import('../../src/modules/cloud.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, json, migratedDb } = await import('./githubAppKit.js');

const TOKEN = `${'A'.repeat(32)}WXYZ`;
const ID = 'cb676a46-66fd-4dfb-b839-443f2e6c0b60';
const KEY = '3b8066a7-b438-455a-9688-44afc9a3597f';

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
    return route ? route.reply(call) : json(404, { error: 'Invalid instance-id.', status: 404 });
  });
  on('GET', /^\/account$/, () => json(200, { account: { name: 'ops' } }));
});
afterEach(() => closeMigratedDb(db));

const saveToken = () => lib.saveVultrToken(db, TOKEN);
const instance = (id: string, ip = '0.0.0.0', os = 'Ubuntu 24.04 LTS x64') => ({ id, status: 'pending', main_ip: ip, os });
const FAST = { addressStepMs: 1, addressTimeoutMs: 200 };

describe('token', () => {
  it('is proven with a read call, stored encrypted and shown back only as a hint', async () => {
    expect(await lib.vultrStatus(db)).toEqual({ configured: false, tokenHint: null });
    expect(await saveToken()).toEqual({ configured: true, tokenHint: '…WXYZ' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/account', auth: `Bearer ${TOKEN}` });
    const row = await db.query.settings.findFirst({ where: eq(settings.key, 'vultr_token_encrypted') });
    expect(String(row?.value)).not.toContain(TOKEN);
    expect(decrypt(String(row?.value))).toBe(TOKEN);
    await lib.deleteVultrToken(db);
    expect((await lib.vultrStatus(db)).configured).toBe(false);
  });

  it('is not stored when Vultr refuses it; an unreachable API is a 502; a non-JSON refusal keeps the status', async () => {
    on('GET', /^\/account$/, () => json(401, { error: 'Invalid API token.', status: 401 }));
    await expect(saveToken()).rejects.toMatchObject({ statusCode: 400, code: 'vultr_api_error', message: expect.stringContaining('Invalid API token') });
    on('GET', /^\/account$/, () => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(saveToken()).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('HTTP 502') });
    h.guardedFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(saveToken()).rejects.toMatchObject({ statusCode: 502, code: 'vultr_unreachable' });
    expect((await lib.vultrStatus(db)).configured).toBe(false);
    await expect(lib.vultrOptions(db)).rejects.toMatchObject({ statusCode: 409, code: 'vultr_not_configured' });
  });
});

describe('options', () => {
  it('lists regions and plans, without GPU or unoffered plans, and only the x64 distributions the bootstrap supports', async () => {
    await saveToken();
    on('GET', /^\/regions$/, () => json(200, { regions: [{ id: 'ams', city: 'Amsterdam', country: 'NL', continent: 'Europe', options: [] }] }));
    on('GET', /^\/plans$/, () =>
      json(200, {
        plans: [
          { id: 'vc2-1c-1gb', vcpu_count: 1, ram: 1024, disk: 25, monthly_cost: 5, type: 'vc2', locations: ['fra', 'ams'] },
          { id: 'vcg-a100-1c', vcpu_count: 12, ram: 122880, disk: 1400, monthly_cost: 1750, type: 'vcg', gpu_vram_gb: 80, locations: ['ams'] },
          { id: 'vc2-sold-out', vcpu_count: 1, ram: 512, disk: 10, monthly_cost: 3.5, type: 'vc2', locations: [] },
        ],
      }),
    );
    on('GET', /^\/os$/, () =>
      json(200, {
        os: [
          { id: 2284, name: 'Ubuntu 24.04 LTS x64', arch: 'x64', family: 'ubuntu' },
          { id: 1869, name: 'Rocky Linux 9 x64', arch: 'x64', family: 'rockylinux' },
          { id: 2105, name: 'Ubuntu 24.04 LTS arm64', arch: 'arm64', family: 'ubuntu' },
          { id: 501, name: 'Windows 2022 Standard x64', arch: 'x64', family: 'windows' },
        ],
      }),
    );
    on('GET', /^\/ssh-keys$/, () => json(200, { ssh_keys: [{ id: KEY, name: 'laptop', ssh_key: 'ssh-ed25519 AAAA', date_created: 'x' }] }));
    expect(await lib.vultrOptions(db)).toEqual({
      regions: [{ id: 'ams', city: 'Amsterdam', country: 'NL' }],
      plans: [{ id: 'vc2-1c-1gb', vcpus: 1, memoryGb: 1, diskGb: 25, priceMonthly: 5, regions: ['ams', 'fra'] }],
      images: [
        { id: 1869, name: 'Rocky Linux 9 x64', family: 'rockylinux' },
        { id: 2284, name: 'Ubuntu 24.04 LTS x64', family: 'ubuntu' },
      ],
      sshKeys: [{ id: KEY, name: 'laptop' }],
    });
  });
});

describe('create', () => {
  const input = { name: 'edge-vultr', region: 'ams', plan: 'vc2-1c-1gb', osId: 2284, sshKeyIds: [KEY] };

  it('creates a tagged instance whose base64 user data starts the agent, waits for its real IPv4, and registers an offline node', async () => {
    await saveToken();
    on('POST', /^\/instances$/, () => json(202, { instance: instance(ID) }));
    let reads = 0;
    on('GET', new RegExp(`^/instances/${ID}$`), () =>
      ++reads < 2 ? json(500, { error: 'try again', status: 500 }) : reads < 3 ? json(200, { instance: instance(ID) }) : json(200, { instance: instance(ID, '203.0.113.9') }),
    );
    const waitForAgent = vi.fn();
    const created = await lib.createVultrServer(db, input, { waitForAgent, ...FAST });
    expect(created).toEqual({ serverId: expect.any(Number), providerServerId: ID, ipv4: '203.0.113.9' });

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      region: 'ams',
      plan: 'vc2-1c-1gb',
      os_id: 2284,
      label: 'edge-vultr',
      hostname: 'edge-vultr',
      sshkey_id: [KEY],
      tags: ['ninedeploy'],
      enable_ipv6: true,
    });
    const node = await db.query.servers.findFirst({ where: eq(servers.id, created.serverId) });
    expect(node).toMatchObject({ name: 'edge-vultr', host: '203.0.113.9', port: 4600, status: 'offline' });
    const agentToken = decrypt(node!.tokenEncrypted);
    // Vultr takes the user data base64 encoded; it carries only the hash of the agent key.
    const userData = Buffer.from(String(post.body!['user_data']), 'base64').toString('utf8');
    expect(userData).toMatch(/^#!\/bin\/sh\n/);
    expect(userData).toContain(createHash('sha256').update(agentToken).digest('hex'));
    expect(userData).not.toContain(agentToken);
    expect(waitForAgent).toHaveBeenCalledWith(created.serverId, '203.0.113.9', 4600, agentToken);
    // Linked like a Hetzner node, so the shared rekey and sweep cover it.
    expect(await hetzner.cloudNodeAwaitingRekey(db, created.serverId)).toBe(true);
    const [link] = await hetzner.readCloudLinks(db);
    expect(link!.link).toMatchObject({ provider: 'vultr', providerServerId: ID, image: 'Ubuntu 24.04 LTS x64' });
  });

  it('deletes the instance again when it gets no public IPv4, or when its address is still another node', async () => {
    await saveToken();
    on('POST', /^\/instances$/, () => json(202, { instance: instance('i-5') }));
    on('GET', /^\/instances\/i-5$/, () => json(200, { instance: instance('i-5') }));
    on('DELETE', /^\/instances\/i-5$/, () => new Response(null, { status: 204 }));
    await expect(lib.createVultrServer(db, input, FAST)).rejects.toMatchObject({ statusCode: 502, code: 'vultr_no_ipv4' });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/instances/i-5')).toBe(true);

    calls = [];
    await db.insert(servers).values({ name: 'old', host: '198.51.100.1', port: 4600, tokenEncrypted: 'x', status: 'online' });
    on('POST', /^\/instances$/, () => json(202, { instance: instance('i-6', '198.51.100.1') }));
    on('DELETE', /^\/instances\/i-6$/, () => new Response(null, { status: 204 }));
    await expect(lib.createVultrServer(db, input, FAST)).rejects.toMatchObject({ statusCode: 409 });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/instances/i-6')).toBe(true);
  });

  it('names the image by its OS id when Vultr does not say', async () => {
    await saveToken();
    on('POST', /^\/instances$/, () => json(202, { instance: { id: 'i-7', status: 'pending', main_ip: '203.0.113.7' } }));
    const { serverId } = await lib.createVultrServer(db, input, FAST);
    expect((await hetzner.cloudLink(db, serverId, 'vultr', 'Vultr')).image).toBe('os 2284');
  });
});

describe('list and delete', () => {
  async function created() {
    await saveToken();
    on('POST', /^\/instances$/, () => json(202, { instance: instance(ID, '203.0.113.20') }));
    return lib.createVultrServer(db, { name: 'v1', region: 'ams', plan: 'vc2-1c-1gb', osId: 2284 }, FAST);
  }

  it('lists our instances with Vultr’s status, and only Vultr’s nodes', async () => {
    expect(await lib.listVultrServers(db)).toEqual([]);
    const { serverId } = await created();
    on('GET', /^\/instances$/, (c) => (c.search.includes('tag=ninedeploy') ? json(200, { instances: [{ id: ID, status: 'active' }] }) : json(400, {})));
    const [row] = await lib.listVultrServers(db);
    expect(row).toMatchObject({ serverId, provider: 'vultr', providerServerId: ID, location: 'ams', serverType: 'vc2-1c-1gb', providerStatus: 'active', nodeStatus: 'offline' });
    expect(await hetzner.listHetznerServers(db)).toEqual([]);
    // Vultr unreadable: the row stays, with no provider status.
    on('GET', /^\/instances$/, () => json(500, { error: 'x', status: 500 }));
    expect((await lib.listVultrServers(db))[0]!.providerStatus).toBeNull();
    // No key any more: the row stays too.
    await lib.deleteVultrToken(db);
    expect((await lib.listVultrServers(db))[0]!.providerStatus).toBeNull();
  });

  it('deletes the instance and the node, refuses while the node hosts a service, and finishes when the instance is already gone', async () => {
    const { serverId } = await created();
    const [svc] = await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', serverId } as never).returning();
    await expect(lib.deleteVultrServer(db, serverId)).rejects.toMatchObject({ statusCode: 409, code: 'server_hosts_services' });
    await db.delete(services).where(eq(services.id, svc!.id));

    // 404 from Vultr: already gone, the panel side is still cleaned up.
    expect(await lib.deleteVultrServer(db, serverId)).toEqual({ providerServerId: ID, name: 'v1' });
    expect(await db.query.servers.findFirst({ where: eq(servers.id, serverId) })).toBeUndefined();
    expect(await hetzner.readCloudLinks(db)).toEqual([]);
    await expect(lib.deleteVultrServer(db, serverId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a Vultr refusal other than 404 keeps the node; another provider’s node is not Vultr’s to delete', async () => {
    const { serverId } = await created();
    on('DELETE', new RegExp(`^/instances/${ID}$`), () => json(403, { error: 'no', status: 403 }));
    await expect(lib.deleteVultrServer(db, serverId)).rejects.toMatchObject({ code: 'vultr_api_error' });
    expect(await db.query.servers.findFirst({ where: eq(servers.id, serverId) })).toBeDefined();
    await expect(hetzner.deleteHetznerServer(db, serverId)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('routes', () => {
  it('are operator only, validate the body, and audit the token and the server', async () => {
    const app = await buildTestApp({ db });
    await app.register(cloudRoutes, { prefix: '/cloud' });
    const OP = asUser({ id: 1, isOperator: true });
    const MEMBER = asUser({ id: 2, isOperator: false });
    expect((await app.inject({ url: '/cloud/vultr', headers: MEMBER })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/cloud/vultr/token', headers: OP, payload: { token: 'short' } })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: '/cloud/vultr/token', headers: OP, payload: { token: TOKEN } });
    expect(put.json()).toEqual({ configured: true, tokenHint: '…WXYZ' });
    expect((await app.inject({ url: '/cloud/vultr', headers: OP })).json()).toEqual({ configured: true, tokenHint: '…WXYZ' });
    on('GET', /^\/regions$/, () => json(200, { regions: [] }));
    on('GET', /^\/plans$/, () => json(200, { plans: [] }));
    on('GET', /^\/os$/, () => json(200, { os: [] }));
    on('GET', /^\/ssh-keys$/, () => json(200, { ssh_keys: [] }));
    expect((await app.inject({ url: '/cloud/vultr/options', headers: OP })).json()).toEqual({ regions: [], plans: [], images: [], sshKeys: [] });

    expect((await app.inject({ method: 'POST', url: '/cloud/vultr/servers', headers: OP, payload: { name: 'x', region: 'ams', plan: 'vc2-1c-1gb', osId: 'ubuntu' } })).statusCode).toBe(400);
    on('POST', /^\/instances$/, () => json(202, { instance: instance('i-9', '203.0.113.30') }));
    const create = await app.inject({ method: 'POST', url: '/cloud/vultr/servers', headers: OP, payload: { name: 'route-v', region: 'ams', plan: 'vc2-1c-1gb', osId: 2284 } });
    expect(create.statusCode, create.body).toBe(200);
    const { serverId } = create.json() as { serverId: number };
    expect((await app.inject({ url: '/cloud/vultr/servers', headers: OP })).json()).toHaveLength(1);
    on('DELETE', /^\/instances\/i-9$/, () => new Response(null, { status: 204 }));
    expect((await app.inject({ method: 'DELETE', url: `/cloud/vultr/servers/${serverId}`, headers: OP })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'DELETE', url: '/cloud/vultr/token', headers: OP })).json()).toEqual({ configured: false, tokenHint: null });
    await app.close();
  });
});
