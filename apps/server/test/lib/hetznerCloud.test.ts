/**
 * G4.3 Hetzner Cloud servers (`lib/hetznerCloud.ts`, `modules/cloud.ts`)
 * against a migrated in-memory SQLite. The Hetzner API is a fake router in
 * place of `guardedFetch`; nothing leaves the process.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { databases, servers, services, settings, type DB } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
  return { guardedFetch: vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>() };
});
vi.mock('../../src/lib/egressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/egressGuard.js')>();
  return { ...actual, guardedFetch: h.guardedFetch };
});

const lib = await import('../../src/lib/hetznerCloud.js');
const { decrypt } = await import('../../src/lib/crypto.js');
const { NODE_DOCKER_INSTALL_SCRIPT } = await import('../../src/engine/serverProvisioner.js');
const { cloudRoutes } = await import('../../src/modules/cloud.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, json, migratedDb } = await import('./githubAppKit.js');

const TOKEN = 'A'.repeat(60) + 'wxyz';
const log = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;

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
      path: u.pathname.replace(/^\/v1/, ''),
      search: u.search,
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const route = routes.find((r) => r.method === call.method && r.path.test(call.path));
    return route ? route.reply(call) : json(404, { error: { code: 'not_found', message: 'not found' } });
  });
  on('GET', /^\/locations$/, () => json(200, { locations: [{ name: 'fsn1', city: 'Falkenstein', country: 'DE' }] }));
});
afterEach(() => closeMigratedDb(db));

const saveToken = () => lib.saveHetznerToken(db, TOKEN);

describe('token', () => {
  it('is proven with a read call, stored encrypted and shown back only as a hint', async () => {
    expect(await lib.hetznerStatus(db)).toEqual({ configured: false, tokenHint: null });
    expect(await saveToken()).toEqual({ configured: true, tokenHint: '…wxyz' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/locations', auth: `Bearer ${TOKEN}` });
    const row = await db.query.settings.findFirst({ where: eq(settings.key, 'hetzner_cloud_token_encrypted') });
    expect(String(row?.value)).not.toContain(TOKEN);
    expect(decrypt(String(row?.value))).toBe(TOKEN);
  });

  it('is not stored when Hetzner refuses it', async () => {
    on('GET', /^\/locations$/, () => json(401, { error: { code: 'unauthorized', message: 'unable to authenticate' } }));
    await expect(saveToken()).rejects.toMatchObject({ statusCode: 400, code: 'hetzner_api_error' });
    expect((await lib.hetznerStatus(db)).configured).toBe(false);
  });
});

describe('options', () => {
  it('lists current server types and only the images the bootstrap supports', async () => {
    await saveToken();
    on('GET', /^\/server_types$/, () =>
      json(200, {
        server_types: [
          { name: 'cx22', description: 'CX22', cores: 2, memory: 4, disk: 40, architecture: 'x86', locations: [{ name: 'nbg1' }, { name: 'fsn1' }] },
          { name: 'cx11', description: 'old', cores: 1, memory: 2, disk: 20, architecture: 'x86', deprecation: { announced: '2024-01-01' } },
        ],
      }),
    );
    on('GET', /^\/images$/, () =>
      json(200, {
        images: [
          { name: 'ubuntu-24.04', description: 'Ubuntu 24.04', os_flavor: 'ubuntu', architecture: 'x86', deprecated: null },
          { name: 'rocky-9', description: 'Rocky Linux 9', os_flavor: 'rocky', architecture: 'x86', deprecated: null },
          { name: 'opensuse-15', description: 'openSUSE', os_flavor: 'opensuse', architecture: 'x86', deprecated: null },
        ],
      }),
    );
    on('GET', /^\/ssh_keys$/, () => json(200, { ssh_keys: [{ id: 7, name: 'laptop', fingerprint: 'aa:bb' }] }));
    const opts = await lib.hetznerOptions(db);
    expect(opts.serverTypes.map((t) => t.name)).toEqual(['cx22']);
    expect(opts.serverTypes[0]!.locations).toEqual(['fsn1', 'nbg1']);
    expect(opts.images.map((i) => i.name)).toEqual(['rocky-9', 'ubuntu-24.04']);
    expect(opts.sshKeys).toEqual([{ id: 7, name: 'laptop', fingerprint: 'aa:bb' }]);
    expect(calls.find((c) => c.path === '/images')?.search).toContain('type=system');
  });

  it('asks for a token first', async () => {
    await expect(lib.hetznerOptions(db)).rejects.toMatchObject({ statusCode: 409, code: 'hetzner_not_configured' });
  });
});

describe('create', () => {
  const input = { name: 'edge-1', location: 'fsn1', serverType: 'cx22', image: 'rocky-9', sshKeyIds: [7] };
  const created = (ip: string | null = '203.0.113.9') =>
    on('POST', /^\/servers$/, () => json(201, { server: { id: 4242, status: 'initializing', public_net: { ipv4: ip ? { ip } : null } } }));

  it('creates a VM whose user data installs Docker and starts the agent, and registers the node offline', async () => {
    await saveToken();
    created();
    const wait = vi.fn();
    const res = await lib.createHetznerServer(db, input, { waitForAgent: wait });
    expect(res).toMatchObject({ providerServerId: 4242, ipv4: '203.0.113.9' });

    const post = calls.find((c) => c.method === 'POST' && c.path === '/servers')!;
    expect(post.body).toMatchObject({ name: 'edge-1', server_type: 'cx22', location: 'fsn1', image: 'rocky-9', ssh_keys: [7], labels: { 'managed-by': 'ninedeploy' } });
    const userData = String(post.body!['user_data']);
    expect(userData.startsWith('#!/bin/sh\n')).toBe(true);
    expect(userData).toContain(NODE_DOCKER_INSTALL_SCRIPT.trim());

    const node = await db.query.servers.findFirst({ where: eq(servers.id, res.serverId) });
    expect(node).toMatchObject({ name: 'edge-1', host: '203.0.113.9', port: 4600, status: 'offline' });
    // The agent gets the hash of exactly the token the panel stored, never the token itself.
    const token = decrypt(node!.tokenEncrypted);
    expect(userData).toContain(`NINEDEPLOY_AGENT_TOKEN=${createHash('sha256').update(token).digest('hex')}`);
    expect(userData).not.toContain(token);
    expect(wait).toHaveBeenCalledWith(res.serverId, '203.0.113.9', 4600, token);

    on('GET', /^\/servers$/, (c) => {
      expect(c.search).toContain('label_selector=managed-by%3Dninedeploy');
      return json(200, { servers: [{ id: 4242, status: 'running' }] });
    });
    expect(await lib.listHetznerServers(db)).toEqual([
      expect.objectContaining({ serverId: res.serverId, providerServerId: 4242, providerStatus: 'running', nodeStatus: 'offline' }),
    ]);
    // Gone from Hetzner: shown as deleted, not hidden.
    on('GET', /^\/servers$/, () => json(200, { servers: [] }));
    expect((await lib.listHetznerServers(db))[0]!.providerStatus).toBe('deleted');
  });

  it('deletes the VM again when it got no IPv4 or the IP is still another node', async () => {
    await saveToken();
    on('DELETE', /^\/servers\/4242$/, () => json(200, { action: {} }));
    created(null);
    await expect(lib.createHetznerServer(db, input)).rejects.toMatchObject({ code: 'hetzner_no_ipv4' });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);

    await db.insert(servers).values({ name: 'old', host: '203.0.113.9', port: 4600, tokenEncrypted: 'x', status: 'offline' });
    created();
    await expect(lib.createHetznerServer(db, input)).rejects.toMatchObject({ statusCode: 409 });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(await lib.listHetznerServers(db)).toEqual([]);
  });

  it('rekeys the node once its agent first answers', async () => {
    const [row] = await db.insert(servers).values({ name: 'n', host: '203.0.113.5', port: 4600, tokenEncrypted: 'x', status: 'offline' }).returning();
    const ping = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(undefined);
    const rekey = vi.fn(async () => true);
    lib.waitForAgentInBackground(db, log, { intervalMs: 5, ping, rekey })(row!.id, '203.0.113.5', 4600, 'tok');
    await vi.waitFor(() => expect(rekey).toHaveBeenCalledWith(row!.id));
    expect(ping).toHaveBeenCalledTimes(2);
  });
});

describe('rekey (security review: the first key is readable from the metadata service)', () => {
  async function cloudNode() {
    await saveToken();
    on('POST', /^\/servers$/, () => json(201, { server: { id: 4242, public_net: { ipv4: { ip: '203.0.113.9' } } } }));
    const created = await lib.createHetznerServer(db, { name: 'edge-1', location: 'fsn1', serverType: 'cx22', image: 'ubuntu-24.04' });
    const node = await db.query.servers.findFirst({ where: eq(servers.id, created.serverId) });
    return { serverId: created.serverId, firstToken: decrypt(node!.tokenEncrypted) };
  }
  const tokenOf = async (id: number) => decrypt((await db.query.servers.findFirst({ where: eq(servers.id, id) }))!.tokenEncrypted);
  const pendingOf = async (id: number) => (await db.query.settings.findFirst({ where: eq(settings.key, `cloud_rekey:${id}`) }))?.value;

  it('sends only the new hash, stores the new token first, and switches when the agent answers with it', async () => {
    const { serverId, firstToken } = await cloudNode();
    let sentHash = '';
    const op = vi.fn(async (_db: unknown, _id: number, name: string, params: Record<string, unknown>) => {
      expect(name).toBe('agent.rekey');
      sentHash = String(params['tokenSha256']);
      // The new token is already stored, encrypted, before the agent hears of it.
      const pending = await pendingOf(serverId);
      expect(typeof pending).toBe('string');
      expect(createHash('sha256').update(decrypt(String(pending))).digest('hex')).toBe(sentHash);
      return { exitCode: 0, lines: ['ND-REKEY ok'] };
    });
    const ping = vi.fn(async (_h: string, _p: number, token: string) => {
      if (createHash('sha256').update(token).digest('hex') !== sentHash) throw new Error('401');
    });
    expect(await lib.rekeyCloudNode(db, serverId, { op: op as never, ping, settleMs: 1000, stepMs: 1 })).toBe(true);
    const now = await tokenOf(serverId);
    expect(now).not.toBe(firstToken);
    expect(createHash('sha256').update(now).digest('hex')).toBe(sentHash);
    expect((await db.query.servers.findFirst({ where: eq(servers.id, serverId) }))?.status).toBe('online');
    expect(await pendingOf(serverId)).toBeUndefined();
    expect((await lib.listHetznerServers(db))[0]!.nodeStatus).toBe('online');
  });

  it('keeps the old key and the pending one when the agent has not come back, and the sweep finishes later', async () => {
    const { serverId, firstToken } = await cloudNode();
    let agentKey = firstToken;
    let sentHash = '';
    const op = vi.fn(async (_db: unknown, _id: number, _n: string, params: Record<string, unknown>) => {
      sentHash = String(params['tokenSha256']);
      return { exitCode: 0, lines: [] };
    });
    // The agent is still restarting: nothing answers.
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await lib.rekeyCloudNode(db, serverId, { op: op as never, ping: down, settleMs: 5, stepMs: 1 })).toBe(false);
    expect(await tokenOf(serverId)).toBe(firstToken);
    expect(await pendingOf(serverId)).toBeDefined();
    // A manual Test marked it online meanwhile: shown as still rekeying.
    await db.update(servers).set({ status: 'online' }).where(eq(servers.id, serverId));
    expect((await lib.listHetznerServers(db))[0]!.nodeStatus).toBe('rekeying');

    // Back up with the new key: the sweep finishes without a second rekey.
    const pending = decrypt(String(await pendingOf(serverId)));
    expect(createHash('sha256').update(pending).digest('hex')).toBe(sentHash);
    agentKey = pending;
    const up = vi.fn(async (_h: string, _p: number, token: string) => {
      if (token !== agentKey) throw new Error('401');
    });
    await lib.sweepCloudNodes(db, log, { op: op as never, ping: up, settleMs: 5, stepMs: 1 });
    expect(op).toHaveBeenCalledTimes(1);
    expect(await tokenOf(serverId)).toBe(pending);
    expect(await pendingOf(serverId)).toBeUndefined();

    // A rekeyed node is left alone.
    await lib.sweepCloudNodes(db, log, { op: op as never, ping: up, settleMs: 5, stepMs: 1 });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('leaves a node whose agent is not up yet for a later sweep', async () => {
    const { serverId } = await cloudNode();
    const op = vi.fn();
    await lib.sweepCloudNodes(db, log, { op: op as never, ping: async () => { throw new Error('down'); } });
    expect(op).not.toHaveBeenCalled();
    expect(await pendingOf(serverId)).toBeUndefined();
  });
});

describe('delete', () => {
  async function createOne() {
    await saveToken();
    on('POST', /^\/servers$/, () => json(201, { server: { id: 4242, public_net: { ipv4: { ip: '203.0.113.9' } } } }));
    return lib.createHetznerServer(db, { name: 'edge-1', location: 'fsn1', serverType: 'cx22', image: 'ubuntu-24.04' });
  }

  it('is refused while the node hosts a service or a database', async () => {
    const { serverId } = await createOne();
    const [svc] = await db.insert(services).values({ name: 'api', slug: 'api', type: 'docker', serverId }).returning();
    await expect(lib.deleteHetznerServer(db, serverId)).rejects.toMatchObject({ statusCode: 409, code: 'server_hosts_services' });
    await db.delete(services).where(eq(services.id, svc!.id));
    await db.insert(databases).values({ name: 'pg', slug: 'pg', engine: 'postgres', passwordEncrypted: 'v1:x', serverId });
    await expect(lib.deleteHetznerServer(db, serverId)).rejects.toMatchObject({ statusCode: 409, code: 'server_hosts_databases' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('deletes the VM, the node and the link; a VM already gone on Hetzner still cleans up', async () => {
    const { serverId } = await createOne();
    on('DELETE', /^\/servers\/4242$/, () => json(404, { error: { code: 'not_found', message: 'server not found' } }));
    expect(await lib.deleteHetznerServer(db, serverId)).toEqual({ providerServerId: 4242, name: 'edge-1' });
    expect(await db.query.servers.findFirst({ where: eq(servers.id, serverId) })).toBeUndefined();
    expect(await lib.listHetznerServers(db)).toEqual([]);
    await expect(lib.deleteHetznerServer(db, serverId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps the node when Hetzner refuses the delete', async () => {
    const { serverId } = await createOne();
    on('DELETE', /^\/servers\/4242$/, () => json(423, { error: { code: 'locked', message: 'server is locked' } }));
    await expect(lib.deleteHetznerServer(db, serverId)).rejects.toMatchObject({ code: 'hetzner_api_error' });
    expect(await db.query.servers.findFirst({ where: eq(servers.id, serverId) })).toBeDefined();
  });
});

describe('routes', () => {
  it('never returns the token, audits changes and refuses members', async () => {
    const app = await buildTestApp({ db });
    await app.register(cloudRoutes, { prefix: '/cloud' });
    const put = await app.inject({ method: 'PUT', url: '/cloud/hetzner/token', headers: asUser(1), payload: { token: TOKEN } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(TOKEN.slice(0, 20));
    expect((await app.inject({ method: 'PUT', url: '/cloud/hetzner/token', headers: asUser(1), payload: { token: 'short' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/cloud/hetzner', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/cloud/hetzner/token', headers: asUser(1) });
    expect(del.json()).toEqual({ configured: false, tokenHint: null });
  });
});
