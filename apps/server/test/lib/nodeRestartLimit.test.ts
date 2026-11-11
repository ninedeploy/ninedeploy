/** P2: the restart-loop limit for a docker service on a node (`lib/nodeRestartLimit.ts` + the sweep in `lib/restartLimit.ts`). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { deployments, nodeLifecycleIntents, servers, services, serviceTargets, users, type DB, type Service } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

const lib = await import('../../src/lib/restartLimit.js');
const node = await import('../../src/lib/nodeRestartLimit.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

let db: DB;
let serverId: number;
const MIN = 60_000;
const limit = { maxRestarts: 3, windowMinutes: 10 };
const ID = (c: string) => c.repeat(64);

beforeEach(async () => {
  db = await migratedDb();
  lib.resetRestartHistory();
  await db.insert(users).values({ id: 1, email: 'a@example.com', passwordHash: 'x' });
  serverId = (await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: 'x', status: 'online' }).returning())[0]!.id;
  await db.insert(services).values([
    { id: 9, name: 'api', slug: 'api', type: 'docker', branch: 'main', ownerUserId: 1, runtimeId: 'api-4', status: 'running', serverId, runtimeReplicas: 2 },
    { id: 12, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 1, runtimeId: 'web-1', status: 'running', serverId: null },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

const svc = async (id: number) => (await db.query.services.findFirst({ where: eq(services.id, id) })) as Service;

/** An agent that owns `api-4` and `api-4-r2` (deployment 4 of service 9) with the given restart counts. */
function agent(counts: Record<string, number>, override: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const call = vi.fn(async (_server: number, op: string, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'docker.identity') {
      const name = String(params['name']);
      if (!(name in counts)) return { exitCode: 0, lines: ['ND-CONTAINER null'] };
      const found = { id: ID(name.endsWith('r2') ? 'b' : 'a'), name, managed: 'service', serviceId: '9', deploymentId: '4', ...(override[name] as object) };
      return { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify(found)}`] };
    }
    if (op === 'docker.readiness') {
      const targets = params['targets'] as Array<{ id: string; name: string }>;
      const reply = {
        requestId: override['requestId'] ?? params['requestId'], complete: true,
        items: targets.map((t) => ({ ...t, status: 'restarting', health: 'none', failingStreak: 0, restarts: counts[t.name]!, ready: false })),
      };
      return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify(reply)}`] };
    }
    throw new Error(`unexpected op ${op}`);
  });
  return { call, calls };
}

describe('sampleNodeRestarts', () => {
  it('reads each replica it owns by id, in running mode with no probe, whatever its state', async () => {
    const { call, calls } = agent({ 'api-4': 2, 'api-4-r2': 7 });
    const sample = await node.sampleNodeRestarts(db, await svc(9), ['api-4', 'api-4-r2'], call);
    expect(sample).toEqual(new Map([[ID('a'), 2], [ID('b'), 7]]));
    const readiness = calls.find((c) => c.op === 'docker.readiness')!.params;
    expect(readiness).toMatchObject({ mode: 'running', port: null, targets: [{ id: ID('a'), name: 'api-4' }, { id: ID('b'), name: 'api-4-r2' }] });
  });

  it('skips a replica that is not there, and trusts nothing under the name that is not this generation of this service', async () => {
    expect(await node.sampleNodeRestarts(db, await svc(9), ['api-4', 'api-4-r2'], agent({ 'api-4': 1 }).call)).toEqual(new Map([[ID('a'), 1]]));
    for (const wrong of [{ serviceId: '10' }, { deploymentId: '3' }, { managed: null }, { name: 'other' }]) {
      expect(await node.sampleNodeRestarts(db, await svc(9), ['api-4'], agent({ 'api-4': 1 }, { 'api-4': wrong }).call)).toBeNull();
    }
    expect(await node.sampleNodeRestarts(db, await svc(9), ['api-4'], agent({}).call)).toBeNull();
    expect(await node.sampleNodeRestarts(db, await svc(9), ['api-4'], agent({ 'api-4': 1 }, { requestId: 'f'.repeat(32) }).call)).toBeNull();
  });

  it('throws when the node does not answer', async () => {
    const call = vi.fn(async () => ({ exitCode: 1, lines: [] }));
    await expect(node.sampleNodeRestarts(db, await svc(9), ['api-4'], call)).rejects.toThrow(/identity unavailable/);
  });
});

describe('enforceRestartLimits on a node', () => {
  it('requests the Stop button’s own node Stop, records the trip and reports it as requested', async () => {
    await lib.setRestartLimit(db, 9, limit);
    let count = 0;
    const sampleNode = vi.fn(async (_s: Service, names: string[]) => {
      expect(names).toEqual(['api-4', 'api-4-r2']);
      return new Map([[ID('a'), count]]);
    });
    const onTripped = vi.fn();
    expect(await lib.enforceRestartLimits(db, { sampleNode, onTripped }, 0)).toEqual([]);
    count = 3;
    expect(await lib.enforceRestartLimits(db, { sampleNode, onTripped }, 1 * MIN)).toEqual([9]);
    expect(onTripped).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), limit, 3, { stopRequested: true });
    expect((await svc(9)).status).toBe('stopped');
    const intent = await db.query.nodeLifecycleIntents.findFirst({ where: eq(nodeLifecycleIntents.serviceId, 9) });
    expect(intent).toMatchObject({ action: 'stop', serverId, runtimeId: 'api-4', phase: 'fencing' });
    expect((await lib.getRestartLimit(db, 9))?.trippedAt).toBe(new Date(1 * MIN).toISOString());
    // Stopped: the next pass leaves it alone.
    expect(await lib.enforceRestartLimits(db, { sampleNode, onTripped }, 2 * MIN)).toEqual([]);
    expect(onTripped).toHaveBeenCalledTimes(1);
  });

  it('never cancels a deploy, even one waiting for CI or an approval: the service is not even sampled', async () => {
    await lib.setRestartLimit(db, 9, limit);
    for (const status of ['awaiting_ci', 'awaiting_approval'] as const) {
      const [d] = await db.insert(deployments).values({ serviceId: 9, status, trigger: 'user' }).returning();
      const sampleNode = vi.fn(async () => new Map([[ID('a'), 100]]));
      expect(await lib.enforceRestartLimits(db, { sampleNode }, 0)).toEqual([]);
      expect(sampleNode).not.toHaveBeenCalled();
      expect((await db.query.deployments.findFirst({ where: eq(deployments.id, d!.id) }))?.status).toBe(status);
      await db.delete(deployments).where(eq(deployments.id, d!.id));
    }
  });

  it('leaves a fan-out service and a pending Start alone', async () => {
    await lib.setRestartLimit(db, 9, limit);
    const other = (await db.insert(servers).values({ name: 'edge-2', host: '10.0.0.6', port: 4600, tokenEncrypted: 'x', status: 'online' }).returning())[0]!.id;
    await db.insert(serviceTargets).values({ serviceId: 9, serverId: other, runtimeId: 'api-t2-4', status: 'running' });
    expect(await node.nodeRestartStopBlocked(db, await svc(9))).toBe('fan-out');
    await db.delete(serviceTargets);
    expect(await node.nodeRestartStopBlocked(db, await svc(9))).toBeNull();
    await db.insert(nodeLifecycleIntents).values({ serviceId: 9, serverId, runtimeId: 'api-4', deploymentId: 4, action: 'start', requestId: 'c'.repeat(32), phase: 'preparing', snapshot: {} } as never);
    expect(await node.nodeRestartStopBlocked(db, await svc(9))).toMatch(/pending/);
  });

  it('keeps the history when a sample fails or cannot be trusted, so a flaky node still trips', async () => {
    await lib.setRestartLimit(db, 9, limit);
    const answers: Array<Map<string, number> | null | Error> = [new Map([[ID('a'), 0]]), new Error('unreachable'), null, new Map([[ID('a'), 3]])];
    const sampleNode = vi.fn(async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const stopNode = vi.fn(async () => true);
    const nodeBlocked = vi.fn(async () => null);
    const deps = { sampleNode, stopNode, nodeBlocked };
    expect(await lib.enforceRestartLimits(db, deps, 0)).toEqual([]);
    expect(await lib.enforceRestartLimits(db, deps, 1 * MIN)).toEqual([]);
    expect(await lib.enforceRestartLimits(db, deps, 2 * MIN)).toEqual([]);
    // Counted from the first baseline: 3 restarts. Had a failed pass wiped it, 3 would be a new baseline.
    expect(await lib.enforceRestartLimits(db, deps, 3 * MIN)).toEqual([9]);
    expect(stopNode).toHaveBeenCalledTimes(1);
  });

  it('samples panel-host services first, and asks a node that failed no more in the same pass', async () => {
    await db.insert(services).values({ id: 10, name: 'api2', slug: 'api2', type: 'docker', branch: 'main', ownerUserId: 1, runtimeId: 'api2-5', status: 'running', serverId } as never);
    for (const id of [9, 10, 12]) await lib.setRestartLimit(db, id, limit);
    const order: number[] = [];
    const sample = vi.fn(async () => { order.push(12); return new Map([['local', 0]]); });
    const sampleNode = vi.fn(async (s: Service) => { order.push(s.id); throw new Error('unreachable'); });
    await lib.enforceRestartLimits(db, { sample, sampleNode, nodeBlocked: async () => null, stopNode: async () => true }, 0);
    expect(order).toEqual([12, 9]);
  });

  it('a requested Stop that the service no longer allows is not reported', async () => {
    await lib.setRestartLimit(db, 9, limit);
    let count = 0;
    const sampleNode = vi.fn(async () => new Map([[ID('a'), count]]));
    const onTripped = vi.fn();
    const stopNode = vi.fn(async () => false);
    await lib.enforceRestartLimits(db, { sampleNode, stopNode, nodeBlocked: async () => null, onTripped }, 0);
    count = 5;
    expect(await lib.enforceRestartLimits(db, { sampleNode, stopNode, nodeBlocked: async () => null, onTripped }, 1 * MIN)).toEqual([]);
    expect(onTripped).not.toHaveBeenCalled();
    expect((await lib.getRestartLimit(db, 9))?.trippedAt).toBeNull();
  });
});
