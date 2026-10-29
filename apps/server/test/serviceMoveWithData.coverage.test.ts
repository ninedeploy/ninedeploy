/**
 * G3.1 move with data (`modules/serviceMoveWithData.ts`), the paths the main
 * suite leaves: the default local volume create (docker argv), refusals for
 * Swarm and PM2 services, a move already running, a running deployment, the
 * host change refused by the plain PATCH, compose stacks moving to and from
 * nodes, a copy failing with a non-Error, and a service deleted mid-move.
 * Volume helpers, docker and the PATCH are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { deployments, services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
const m = vi.hoisted(() => ({
  audit: vi.fn(async (..._a: unknown[]) => undefined),
  enqueue: vi.fn(async (..._a: unknown[]) => 77),
  capture: vi.fn<(cmd: string, args: string[], opts?: unknown) => Promise<string>>(),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: m.audit }));
vi.mock('../src/lib/deployQueue.js', () => ({ enqueueUserDeploy: m.enqueue }));
vi.mock('../src/lib/exec.js', async (orig) => ({ ...(await orig<object>()), capture: m.capture }));

const { serviceMoveRoutes, copyVolume, defaultMoveDeps } = await import('../src/modules/serviceMoveWithData.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  m.audit.mockClear();
  m.enqueue.mockClear();
  m.capture.mockReset().mockResolvedValue('');
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.27', volumeMount: '/data', status: 'stopped' },
    { id: 8, name: 'shop', slug: 'shop', type: 'compose', branch: 'main', ownerUserId: 1, status: 'stopped' },
    { id: 9, name: 'edge', slug: 'edge', type: 'docker', branch: 'main', ownerUserId: 1, volumeMount: '/data', status: 'stopped', orchestrator: 'swarm' },
    { id: 10, name: 'pm', slug: 'pm', type: 'pm2', branch: 'main', ownerUserId: 1, volumeMount: '/data', status: 'stopped' },
    { id: 11, name: 'far', slug: 'far', type: 'docker', branch: 'main', ownerUserId: 1, volumeMount: '/data', status: 'stopped' },
    { id: 12, name: 'farstack', slug: 'farstack', type: 'compose', branch: 'main', ownerUserId: 1, status: 'stopped' },
  ] as never);
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`UPDATE services SET server_id = 4 WHERE id IN (11, 12)`);
});
afterEach(() => closeMigratedDb(db));

function deps(calls: string[], over: Record<string, unknown> = {}) {
  return {
    backupLocal: vi.fn(async (name: string) => void calls.push(`backup local ${name}`)),
    restoreLocal: vi.fn(async (name: string) => void calls.push(`restore local ${name}`)),
    localExists: vi.fn(async () => true),
    createLocal: vi.fn(async (name: string) => void calls.push(`create local ${name}`)),
    backupNode: vi.fn(async (_db: DB, node: number, name: string) => void calls.push(`backup ${node} ${name}`)),
    restoreNode: vi.fn(async (_db: DB, node: number, name: string) => void calls.push(`restore ${node} ${name}`)),
    nodeExists: vi.fn(async () => true),
    createNode: vi.fn(async (_db: DB, node: number, name: string) => void calls.push(`create ${node} ${name}`)),
    composeVolumes: vi.fn(async (_db: DB, host: number | null, slug: string) => {
      calls.push(`list ${host ?? 'local'} ${slug}`);
      return host === null ? [{ name: `ndcmp-${slug}_db`, key: 'db', fixed: false }] : host === 4 ? [{ name: `ndcmp-${slug}_data`, key: 'data', fixed: false }] : [];
    }),
    createCompose: vi.fn(async (_db: DB, host: number | null, name: string) => void calls.push(`create compose ${host ?? 'local'} ${name}`)),
    ...over,
  };
}

type PatchReply = { code: number; body: unknown } | null;
async function app(d: ReturnType<typeof deps>, patched: unknown[], patchReply: PatchReply = null) {
  const a = await buildTestApp({ db });
  a.patch('/v1/services/:id', async (req, reply) => {
    patched.push({ id: Number((req.params as { id: string }).id), body: req.body, auth: req.headers['authorization'] ?? null, cookie: req.headers['cookie'] ?? null });
    if (patchReply) return reply.code(patchReply.code).send(patchReply.body);
    return {};
  });
  await a.register(serviceMoveRoutes(d as never), { prefix: '/services' });
  return a;
}
const move = (a: Awaited<ReturnType<typeof app>>, id: number, serverId: number | null) =>
  a.inject({ method: 'POST', url: `/services/${id}/move`, headers: asUser(1), payload: { serverId } });
async function settle(a: Awaited<ReturnType<typeof app>>, id: number) {
  for (let i = 0; i < 100; i++) {
    const view = (await a.inject({ method: 'GET', url: `/services/${id}/move`, headers: asUser(1) })).json();
    if (view.state !== 'running') return view;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the move did not finish');
}

describe('the default local volume create', () => {
  it('creates a plain docker volume on the panel host', async () => {
    await defaultMoveDeps.createLocal('nd-svc-api-data');
    expect(m.capture).toHaveBeenCalledWith('docker', ['volume', 'create', 'nd-svc-api-data'], { timeoutMs: 60_000 });
  });
});

describe('copyVolume', () => {
  it('restores a compose volume on the panel host after creating it with compose labels', async () => {
    const calls: string[] = [];
    await copyVolume(db, 'ndcmp-shop_db', 4, null, () => undefined, deps(calls) as never, true);
    expect(calls).toEqual(['backup 4 ndcmp-shop_db', 'create compose local ndcmp-shop_db', 'restore local ndcmp-shop_db']);
  });

  it('reuses an existing volume on either side and passes failures through', async () => {
    const calls: string[] = [];
    await copyVolume(db, 'nd-svc-x-data', null, null, () => undefined, deps(calls) as never);
    await copyVolume(db, 'nd-svc-x-data', null, 3, () => undefined, deps(calls) as never);
    expect(calls).toEqual(['backup local nd-svc-x-data', 'restore local nd-svc-x-data', 'backup local nd-svc-x-data', 'restore 3 nd-svc-x-data']);
    const failing = deps([], { backupLocal: vi.fn(async () => Promise.reject(new Error('disk full'))) });
    await expect(copyVolume(db, 'nd-svc-x-data', null, 3, () => undefined, failing as never)).rejects.toThrow('disk full');
    expect(failing.restoreNode).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('refuses Swarm and PM2 services', async () => {
    const a = await app(deps([]), []);
    for (const id of [9, 10]) {
      const res = await move(a, id, 3);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('move_unsupported');
    }
    await a.close();
  });

  it('refuses while a deployment of the service runs', async () => {
    await db.insert(deployments).values({ serviceId: 5, status: 'building' } as never);
    const patched: unknown[] = [];
    const a = await app(deps([]), patched);
    const res = await move(a, 5, 3);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('move_deploying');
    expect(patched).toEqual([]);
    await a.close();
  });

  it('refuses a second move while one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const a = await app(deps(calls, { backupLocal: vi.fn(async () => gate) }), []);
    expect((await move(a, 5, 3)).statusCode).toBe(202);
    const again = await move(a, 5, 3);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('move_running');
    release();
    expect(await settle(a, 5)).toMatchObject({ state: 'done', deploymentId: 77 });
    await a.close();
  });

  it('passes on the refusal of the plain host change, with its code or a generic one', async () => {
    const patched: unknown[] = [];
    let a = await app(deps([]), patched, { code: 409, body: { error: { code: 'server_volume_taken', message: 'A volume of that name is on the target' } } });
    // The caller's own credentials go with the host change.
    const res = await a.inject({
      method: 'POST',
      url: '/services/5/move',
      headers: { ...asUser(1), authorization: 'Bearer nd_tok', cookie: 'nd_session=abc' },
      payload: { serverId: 3 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'server_volume_taken', message: 'A volume of that name is on the target' });
    expect(patched).toEqual([{ id: 5, body: { serverId: 3 }, auth: 'Bearer nd_tok', cookie: 'nd_session=abc' }]);
    patched.length = 0;
    await a.close();

    a = await app(deps([]), patched, { code: 422, body: {} });
    const generic = await move(a, 5, 3);
    expect(generic.statusCode).toBe(422);
    expect(generic.json().error).toMatchObject({ code: 'move_refused', message: 'The move was refused' });
    // Nothing started.
    expect((await a.inject({ method: 'GET', url: '/services/5/move', headers: asUser(1) })).json().state).toBe('none');
    expect(m.audit).not.toHaveBeenCalled();
    await a.close();
  });

  it('refuses a node service whose volume is not on its node', async () => {
    const d = deps([], { nodeExists: vi.fn(async () => false) });
    const a = await app(d, []);
    const res = await move(a, 11, null);
    expect(res.json().error).toMatchObject({ code: 'move_no_volume', message: expect.stringContaining('nd-svc-far-data') });
    expect(d.nodeExists).toHaveBeenCalledWith(db, 4, 'nd-svc-far-data');
    await a.close();
  });
});

describe('moves', () => {
  it('moves a docker service from a node to the panel host and audits it', async () => {
    const calls: string[] = [];
    const a = await app(deps(calls, { localExists: vi.fn(async () => false) }), []);
    const res = await move(a, 11, null);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ state: 'running', from: 4, to: null, volumes: ['nd-svc-far-data'] });
    expect(await settle(a, 11)).toMatchObject({ state: 'done', copied: 1, deploymentId: 77 });
    expect(calls).toEqual(['backup 4 nd-svc-far-data', 'create local nd-svc-far-data', 'restore local nd-svc-far-data']);
    expect(m.audit).toHaveBeenCalledWith(db, 1, 'service.move_with_data', 'far: 4 → panel host', { serviceId: 11, from: 4, to: null, volumes: ['nd-svc-far-data'] });
    await a.close();
  });

  it('checks the target node can take compose volumes before a stack moves there', async () => {
    const calls: string[] = [];
    const a = await app(deps(calls), []);
    expect((await move(a, 8, 5)).statusCode).toBe(202);
    expect(calls.slice(0, 2)).toEqual(['list local shop', 'list 5 shop']);
    expect(await settle(a, 8)).toMatchObject({ state: 'done', copied: 1, volumes: ['ndcmp-shop_db'] });
    expect(calls.slice(2)).toEqual(['backup local ndcmp-shop_db', 'create compose 5 ndcmp-shop_db', 'restore 5 ndcmp-shop_db']);
    await a.close();
  });

  it('moves a stack from a node to the panel host without listing the panel host first', async () => {
    const calls: string[] = [];
    const a = await app(deps(calls), []);
    expect((await move(a, 12, null)).statusCode).toBe(202);
    expect(await settle(a, 12)).toMatchObject({ state: 'done', from: 4, to: null });
    expect(calls).toEqual(['list 4 farstack', 'backup 4 ndcmp-farstack_data', 'create compose local ndcmp-farstack_data', 'restore local ndcmp-farstack_data']);
    await a.close();
  });

  it('refuses a stack the target node cannot take, before the host changes', async () => {
    const patched: unknown[] = [];
    const d = deps([], {
      composeVolumes: vi.fn(async (_db: DB, host: number | null) => {
        if (host !== null) throw Object.assign(new Error('The agent cannot move compose volumes'), { statusCode: 422, code: 'node_capability_missing' });
        return [{ name: 'ndcmp-shop_db', key: 'db', fixed: false }];
      }),
    });
    const a = await app(d, patched);
    const res = await move(a, 8, 5);
    expect(res.statusCode).toBe(422);
    expect(patched).toEqual([]);
    await a.close();
  });

  it('records a copy failure that is not an Error and audits it', async () => {
    const a = await app(deps([], { restoreNode: vi.fn(async () => Promise.reject('stream reset')) }), []);
    expect((await move(a, 5, 3)).statusCode).toBe(202);
    const view = await settle(a, 5);
    expect(view).toMatchObject({ state: 'failed', error: 'stream reset', copied: 0, deploymentId: null });
    expect(view.finishedAt).toEqual(expect.any(String));
    expect(m.enqueue).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(m.audit).toHaveBeenCalledWith(db, 1, 'service.move_with_data_failed', 'api: stream reset', { serviceId: 5 }));
    await a.close();
  });

  it('finishes without a deployment when the service was deleted during the copy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = await app(deps([], { backupLocal: vi.fn(async () => gate) }), []);
    expect((await move(a, 5, 3)).statusCode).toBe(202);
    await db.run(sql`DELETE FROM services WHERE id = 5`);
    release();
    // The service is gone, so its move view is read from the settings row directly.
    const { getSettingJson } = await import('../src/lib/settings.js');
    await vi.waitFor(async () => expect(await getSettingJson(db, 'service_move:5', null)).toMatchObject({ state: 'done', deploymentId: null }));
    expect(m.enqueue).not.toHaveBeenCalled();
    await a.close();
  });
});
