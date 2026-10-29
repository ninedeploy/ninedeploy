/**
 * G3.1 move a service with its data: the preconditions, the host change
 * through the plain PATCH, the volume copy from source to target and the
 * deploy on the target. The volume helpers and the PATCH are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceVolumeAttachments, services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
const enqueue = vi.hoisted(() => vi.fn(async () => 77));
vi.mock('../src/lib/deployQueue.js', () => ({ enqueueUserDeploy: enqueue }));

const { serviceMoveRoutes, copyVolume } = await import('../src/modules/serviceMoveWithData.js');
const { buildTestApp, asUser } = await import('./helpers.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

let db: DB;
beforeEach(async () => {
  enqueue.mockClear();
  db = await migratedDb();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.27', volumeMount: '/data', status: 'stopped' },
    { id: 6, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.27', volumeMount: '/data', status: 'running' },
    { id: 7, name: 'tmp', slug: 'tmp', type: 'docker', branch: 'main', ownerUserId: 1, image: 'nginx:1.27', status: 'stopped' },
    { id: 8, name: 'shop', slug: 'shop', type: 'compose', branch: 'main', ownerUserId: 1, status: 'stopped' },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

function fakeDeps(volumes: Set<string>, calls: string[]) {
  return {
    backupLocal: vi.fn(async (name: string) => void calls.push(`backup local ${name}`)),
    restoreLocal: vi.fn(async (name: string) => void calls.push(`restore local ${name}`)),
    localExists: vi.fn(async (name: string) => volumes.has(`local:${name}`)),
    createLocal: vi.fn(async (name: string) => void calls.push(`create local ${name}`)),
    backupNode: vi.fn(async (_db: DB, node: number, name: string) => void calls.push(`backup ${node} ${name}`)),
    restoreNode: vi.fn(async (_db: DB, node: number, name: string) => void calls.push(`restore ${node} ${name}`)),
    nodeExists: vi.fn(async (_db: DB, node: number, name: string) => volumes.has(`${node}:${name}`)),
    createNode: vi.fn(async (_db: DB, node: number, name: string) => void calls.push(`create ${node} ${name}`)),
    composeVolumes: vi.fn(async (_db: DB, host: number | null, slug: string) =>
      [...volumes]
        .filter((v) => v.startsWith(`${host ?? 'local'}:`) && v.includes(`ndcmp-${slug}_`) || v.startsWith(`${host ?? 'local'}:fixed:`))
        .map((v) => {
          const name = v.split(':').at(-1)!;
          return { name, key: name.split('_').at(-1)!, fixed: v.includes(':fixed:') };
        }),
    ),
    createCompose: vi.fn(async (_db: DB, host: number | null, name: string) => void calls.push(`create compose ${host ?? 'local'} ${name}`)),
  } as never;
}

async function app(deps: never, patched: unknown[]) {
  const a = await buildTestApp({ db });
  // The plain host change, recorded.
  a.patch('/v1/services/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const { serverId } = req.body as { serverId: number | null };
    patched.push({ id, serverId });
    return {};
  });
  await a.register(serviceMoveRoutes(deps), { prefix: '/services' });
  return a;
}

async function settle(a: Awaited<ReturnType<typeof app>>, id: number) {
  for (let i = 0; i < 50; i++) {
    const view = (await a.inject({ method: 'GET', url: `/services/${id}/move`, headers: asUser(1) })).json();
    if (view.state !== 'running') return view;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the move did not finish');
}

describe('move with data', () => {
  it('moves the stopped service from the panel host to a node, copies its volume and deploys it there', async () => {
    const calls: string[] = [];
    const patched: unknown[] = [];
    const a = await app(fakeDeps(new Set(['local:nd-svc-api-data']), calls), patched);
    expect((await a.inject({ method: 'GET', url: '/services/5/move', headers: asUser(1) })).json().state).toBe('none');
    const res = await a.inject({ method: 'POST', url: '/services/5/move', headers: asUser(1), payload: { serverId: 3 } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ state: 'running', from: null, to: 3, step: 'copying' });
    expect(patched).toEqual([{ id: 5, serverId: 3 }]);
    const done = await settle(a, 5);
    expect(done).toMatchObject({ state: 'done', from: null, to: 3, deploymentId: 77, error: null });
    expect(calls).toEqual(['backup local nd-svc-api-data', 'create 3 nd-svc-api-data', 'restore 3 nd-svc-api-data']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    await a.close();
  });

  it('refuses a running service, one without a volume, the same host, a missing volume and extra attachments', async () => {
    const patched: unknown[] = [];
    const a = await app(fakeDeps(new Set(), []), patched);
    const move = (id: number, serverId: number | null) => a.inject({ method: 'POST', url: `/services/${id}/move`, headers: asUser(1), payload: { serverId } });
    expect((await move(6, 3)).json().error.code).toBe('move_stop_first');
    expect((await move(7, 3)).json().error.code).toBe('move_no_volume');
    expect((await move(5, null)).json().error.code).toBe('move_same_host');
    // The volume is not on the panel host.
    expect((await move(5, 3)).json().error.code).toBe('move_no_volume');
    await db.insert(serviceVolumeAttachments).values({ serviceId: 5, volumeName: 'shared', containerPath: '/extra' } as never);
    expect((await move(5, 3)).json().error.code).toBe('move_extra_volumes');
    expect(patched).toEqual([]);
    // Members cannot move services between hosts.
    expect((await a.inject({ method: 'POST', url: '/services/5/move', headers: asUser({ id: 1, isOperator: false }), payload: { serverId: 3 } })).statusCode).toBe(403);
    await a.close();
  });

  it('records a failed copy and leaves the service undeployed on the target', async () => {
    const deps = fakeDeps(new Set(['local:nd-svc-api-data']), []) as unknown as { restoreNode: ReturnType<typeof vi.fn> };
    deps.restoreNode.mockRejectedValueOnce(new Error('checksum mismatch'));
    const a = await app(deps as never, []);
    expect((await a.inject({ method: 'POST', url: '/services/5/move', headers: asUser(1), payload: { serverId: 3 } })).statusCode).toBe(202);
    expect(await settle(a, 5)).toMatchObject({ state: 'failed', error: 'checksum mismatch', deploymentId: null });
    expect(enqueue).not.toHaveBeenCalled();
    await a.close();
  });

  it('copies node to node and creates the volume on the panel host when it is missing', async () => {
    const calls: string[] = [];
    await copyVolume(db, 'nd-svc-x-data', 2, 3, () => undefined, fakeDeps(new Set(['3:nd-svc-x-data']), calls));
    expect(calls).toEqual(['backup 2 nd-svc-x-data', 'restore 3 nd-svc-x-data']);
    calls.length = 0;
    await copyVolume(db, 'nd-svc-x-data', 2, null, () => undefined, fakeDeps(new Set(), calls));
    expect(calls).toEqual(['backup 2 nd-svc-x-data', 'create local nd-svc-x-data', 'restore local nd-svc-x-data']);
  });

  it('moves a compose stack with every named volume compose made for it', async () => {
    const calls: string[] = [];
    const patched: unknown[] = [];
    const a = await app(fakeDeps(new Set(['local:ndcmp-shop_db', 'local:ndcmp-shop_uploads']), calls), patched);
    const res = await a.inject({ method: 'POST', url: '/services/8/move', headers: asUser(1), payload: { serverId: 3 } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ state: 'running', volumes: ['ndcmp-shop_db', 'ndcmp-shop_uploads'], copied: 0 });
    expect(await settle(a, 8)).toMatchObject({ state: 'done', copied: 2, deploymentId: 77 });
    expect(calls).toEqual([
      'backup local ndcmp-shop_db', 'create compose 3 ndcmp-shop_db', 'restore 3 ndcmp-shop_db',
      'backup local ndcmp-shop_uploads', 'create compose 3 ndcmp-shop_uploads', 'restore 3 ndcmp-shop_uploads',
    ]);
    expect(patched).toEqual([{ id: 8, serverId: 3 }]);
    await a.close();
  });

  it('refuses a compose stack with a fixed-name volume or none at all, before anything moves', async () => {
    const patched: unknown[] = [];
    let a = await app(fakeDeps(new Set(['local:ndcmp-shop_db', 'local:fixed:pgdata']), []), patched);
    const fixed = await a.inject({ method: 'POST', url: '/services/8/move', headers: asUser(1), payload: { serverId: 3 } });
    expect(fixed.json().error).toMatchObject({ code: 'move_fixed_volume_names', message: expect.stringContaining('pgdata') });
    await a.close();
    a = await app(fakeDeps(new Set(), []), patched);
    expect((await a.inject({ method: 'POST', url: '/services/8/move', headers: asUser(1), payload: { serverId: 3 } })).json().error.code).toBe('move_no_volume');
    expect(patched).toEqual([]);
    await a.close();
  });
});
