import { describe, expect, it, vi } from 'vitest';
import { createDb, domains, eq, nodeAutoscaleTransitions, runMigrations, servers, serviceRuntimeOwners, serviceTargets, services } from '@ninedeploy/db';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';

/**
 * The proxy must render the replica count the last deploy ACHIEVED
 * (services.runtimeReplicas), never the desired one (services.replicas): a
 * replica that failed to start — or the window between saving a higher count
 * and the next deploy — must not become an unresolvable round-robin backend
 * answering 502s for its share of requests.
 */
vi.mock('../../src/config.js', () => ({
  config: { paths: { dataDir: '' }, acmeEmail: null, dnsProvider: '', dnsToken: null },
}));

const makeDb = (domainRows: unknown[], serviceRows: unknown[], targetRows: unknown[] = [], transitions: unknown[] = [], owners: unknown[] = []) => ({
  select: vi.fn(() => ({
    from: vi.fn((t: unknown) => {
      const resolve = async () => {
        if (t === domains) return domainRows;
        if (t === services) return serviceRows;
        if (t === serviceTargets) return targetRows;
        if (t === nodeAutoscaleTransitions) return transitions;
        if (t === serviceRuntimeOwners) return owners;
        return [];
      };
      const pending = Promise.resolve().then(resolve);
      return Object.assign(pending, { where: async () => resolve() });
    }),
  })),
});

const domainRow = { id: 1, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: false, status: 'active' };

describe('renderDynamicConfig replica backends', () => {
  it('renders only what runs: a desired-but-not-yet-achieved count stays one backend', async () => {
    // The user saved replicas=3 in the Scaling card ("applied on next
    // deploy") — or a replica failed to start. Either way only the primary
    // exists; listing web-1-r2/-r3 would blackhole 2/3 of the traffic.
    const db = makeDb(
      [domainRow],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1', type: 'docker', replicas: 3, runtimeReplicas: 1 }],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(yaml).toContain('url: "http://web-1:3000"');
    expect(yaml).not.toContain('-r2');
    expect(yaml).not.toContain('healthCheck:');
  });

  it('renders every achieved replica plus the health check once the deploy recorded them', async () => {
    const db = makeDb(
      [domainRow],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1', type: 'docker', replicas: 3, runtimeReplicas: 3 }],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(yaml).toContain('url: "http://web-1:3000"');
    expect(yaml).toContain('url: "http://web-1-r2:3000"');
    expect(yaml).toContain('url: "http://web-1-r3:3000"');
    expect(yaml).toContain('healthCheck:');
  });

  it('a partial achievement renders exactly the live replicas', async () => {
    // The deploy wanted 3, one replica failed to start and the builder
    // reported 2 — the config must not list the dead third.
    const db = makeDb(
      [domainRow],
      [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-1', type: 'docker', replicas: 3, runtimeReplicas: 2 }],
    );
    const yaml = await renderDynamicConfig(db as never, { serverId: null });
    expect(yaml).toContain('url: "http://web-1-r2:3000"');
    expect(yaml).not.toContain('web-1-r3');
  });
});


describe('fan-out replica placement', () => {
  it('keeps a pending scale-up off ordinary node refreshes until routing is explicitly promoted', async () => {
    const db = makeDb([domainRow], [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-9', serverId: 4, type: 'docker', replicas: 3, runtimeReplicas: 2 }], [],
      [{ serviceId: 1, serverId: 4, runtimeId: 'web-9', fromReplicas: 1, toReplicas: 2, phase: 'routing', ownerEpoch: 1, requestId: 'a'.repeat(32) }],
      [{ serviceId: 1, epoch: 1, requestId: 'a'.repeat(32), kind: 'scale' }]);
    const yaml = await renderDynamicConfig(db as never, { serverId: 4 });
    expect(yaml).toContain('url: "http://web-9:3000"');
    expect(yaml).not.toContain('web-9-r2');
  });
  it('keeps the last confirmed route when a scale-up transition is held', async () => {
    const workerToken = 'b'.repeat(32), requestId = 'a'.repeat(32);
    const db = makeDb([domainRow], [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-9', serverId: 4, type: 'docker', runtimeReplicas: 2 }], [],
      [{ serviceId: 1, serverId: 4, runtimeId: 'web-9', fromReplicas: 1, toReplicas: 2, phase: 'held', ownerEpoch: 1, requestId, workerToken, leaseUntil: new Date(Date.now() + 60_000) }],
      [{ serviceId: 1, epoch: 1, requestId, kind: 'scale' }]);
    expect(await renderDynamicConfig(db as never, { serverId: 4 })).not.toContain('web-9-r2');
    await expect(renderDynamicConfig(db as never, { serverId: 4, autoscalePromotion: { serviceId: 1, ownerEpoch: 1, requestId, workerToken } })).rejects.toThrow(/ownership/);
  });
  it('only promotes the new route for the unexpired worker and runtime owner', async () => {
    const requestId = 'a'.repeat(32), workerToken = 'b'.repeat(32);
    const db = makeDb([domainRow], [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-9', serverId: 4, type: 'docker', runtimeReplicas: 2 }], [],
      [{ serviceId: 1, serverId: 4, runtimeId: 'web-9', fromReplicas: 1, toReplicas: 2, phase: 'routing', ownerEpoch: 1, requestId, workerToken, leaseUntil: new Date(Date.now() + 60_000) }],
      [{ serviceId: 1, epoch: 1, requestId, kind: 'scale' }]);
    const promotion = { serviceId: 1, ownerEpoch: 1, requestId, workerToken };
    expect(await renderDynamicConfig(db as never, { serverId: 4, autoscalePromotion: promotion })).toContain('web-9-r2');
    await expect(renderDynamicConfig(db as never, { serverId: 4, autoscalePromotion: { ...promotion, workerToken: 'c'.repeat(32) } })).rejects.toThrow(/ownership/);
  });
  it('uses persisted SQLite ownership and holds ordinary refresh after the worker lease expires', async () => {
    const c = createDb({ url: 'file::memory:' });
    try {
      await c.ready; await runMigrations(c.db);
      await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
      await c.db.insert(services).values({ id: 1, name: 'Web', slug: 'web', port: 3000, runtimeId: 'web-9', serverId: 4, type: 'docker', status: 'running', runtimeReplicas: 2 });
      await c.db.insert(domains).values({ serviceId: 1, hostname: 'app.example.com', ssl: false, status: 'active' });
      const owner = await reserveServiceRuntimeOwner(c.db, 1, 'scale', null, 'a'.repeat(32));
      await c.db.insert(nodeAutoscaleTransitions).values({ serviceId: 1, ownerEpoch: owner.epoch, requestId: owner.requestId!, serverId: 4, runtimeId: 'web-9',
        fromReplicas: 1, toReplicas: 2, watermark: 9, targets: [], phase: 'routing', workerToken: 'b'.repeat(32), leaseUntil: new Date(Date.now() + 60_000) });
      const promotion = { serviceId: 1, ownerEpoch: owner.epoch, requestId: owner.requestId!, workerToken: 'b'.repeat(32) };
      expect(await renderDynamicConfig(c.db, { serverId: 4 })).not.toContain('web-9-r2');
      expect(await renderDynamicConfig(c.db, { serverId: 4, autoscalePromotion: promotion })).toContain('web-9-r2');
      await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(0) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
      expect(await renderDynamicConfig(c.db, { serverId: 4 })).not.toContain('web-9-r2');
      await expect(renderDynamicConfig(c.db, { serverId: 4, autoscalePromotion: promotion })).rejects.toThrow(/ownership/);
      await c.db.update(nodeAutoscaleTransitions).set({ leaseUntil: new Date(Date.now() + 60_000) }).where(eq(nodeAutoscaleTransitions.serviceId, 1));
      await reserveServiceRuntimeOwner(c.db, 1, 'deploy', owner, 'c'.repeat(32));
      expect(await renderDynamicConfig(c.db, { serverId: 4 })).not.toContain('web-9-r2');
      await expect(renderDynamicConfig(c.db, { serverId: 4, autoscalePromotion: promotion })).rejects.toThrow(/ownership/);
      await c.db.update(services).set({ runtimeId: 'web-10' }).where(eq(services.id, 1));
      expect(await renderDynamicConfig(c.db, { serverId: 4 })).toContain('web-10-r2');
    } finally { c.client?.close(); }
  });
  it.each([2, 10, null])('routes only the one container created on a target when primary runtimeReplicas=%s', async runtimeReplicas => {
    const db = makeDb([domainRow], [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-9', serverId: 4, type: 'docker', replicas: 3, runtimeReplicas }],
      [{ id: 42, serviceId: 1, serverId: 5, runtimeId: 'web-t5-7', status: 'running' }]);
    const yaml = await renderDynamicConfig(db as never, { serverId: 5 });
    expect(yaml).toContain('url: "http://web-t5-7:3000"');
    expect(yaml).not.toContain('web-t5-7-r2');
    expect(yaml.match(/- url:/g)).toHaveLength(1);
    expect(yaml).not.toContain('web-9');
  });

  it('keeps every achieved primary-node replica when the service also has other placements', async () => {
    const db = makeDb([domainRow], [{ id: 1, slug: 'web', port: 3000, runtimeId: 'web-9', serverId: 4, type: 'docker', replicas: 3, runtimeReplicas: 2 }]);
    const yaml = await renderDynamicConfig(db as never, { serverId: 4 });
    expect(yaml).toContain('url: "http://web-9:3000"');
    expect(yaml).toContain('url: "http://web-9-r2:3000"');
    expect(yaml).not.toContain('web-9-r3');
  });
});
