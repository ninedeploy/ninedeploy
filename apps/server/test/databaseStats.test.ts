import { afterEach, describe, expect, it, vi } from 'vitest';
import { statsRoutes } from '../src/modules/stats.js';
import { asUser, buildTestApp, createFakeDb, dbRow } from './helpers.js';
const now = Date.now(), MB = 1024 ** 2;
const nodeDatabase = dbRow({ id: 13, name: 'orders', slug: 'orders', ownerUserId: 7, status: 'running', serverId: 8, containerName: null, nodeContainerName: 'nd-db-orders' });
const stat = (cpuPct: number) => ({ name: 'nd-db-orders', cpuPct, memBytes: 4 * MB, memLimitBytes: 16 * MB });
async function fixture(options: { row?: typeof nodeDatabase; timestamp?: number | null; error?: boolean; missing?: boolean; invalidMetric?: boolean } = {}) {
  const row = options.row ?? nodeDatabase;
  const db = createFakeDb({ findFirst: { databases: row }, select: { databases: [row] } });
  const app = await buildTestApp({ db });
  app.stats.raw = () => ({ containers: new Map([['nd-db-orders', stat(99)]]), sampledAt: now, host: { cpuCores: 8 },
    nodeContainers: new Map([[8, new Map(options.missing ? [] : [['nd-db-orders', stat(options.invalidMetric ? Number.NaN : 12.5)]])], [9, new Map([['nd-db-orders', stat(77)]])]]),
    nodeSamples: new Map([[8, { sampledAt: options.timestamp === undefined ? now : options.timestamp, error: options.error ?? false }]]) } as never);
  await app.register(statsRoutes);
  return app;
}
afterEach(() => vi.useRealTimers());
describe('database-scoped resource snapshots', () => {
  it('reads only the database recorded node and exposes no host or other-node samples', async () => {
    const app = await fixture();
    try {
      const result = await app.inject({ url: '/?databaseId=13', headers: asUser({ id: 7, isOperator: false }) });
      expect(result.statusCode).toBe(200); expect(result.json().host).toBeNull();
      expect(result.json().containers).toEqual([expect.objectContaining({ refId: 13, cpuPct: 12.5, memMb: 4 })]);
      expect(result.json().resource).toMatchObject({ kind: 'database', id: 13, serverId: 8, state: 'live', sampledAt: now });
    } finally { await app.close(); }
  });
  it('does not expose an unreadable database even when its container is cached', async () => {
    const app = await fixture({ row: { ...nodeDatabase, ownerUserId: 9 } });
    try { expect((await app.inject({ url: '/?databaseId=13', headers: asUser({ id: 7, isOperator: false }) })).statusCode).toBe(404); }
    finally { await app.close(); }
  });
  it.each([
    [{ timestamp: now - 90_001 }, 'stale'], [{ timestamp: null }, 'pending'], [{ error: true, timestamp: null }, 'unavailable'], [{ missing: true }, 'unavailable'],
    [{ row: { ...nodeDatabase, status: 'stopped' } }, 'stopped'],
    [{ timestamp: now + 1 }, 'stale'], [{ invalidMetric: true }, 'unavailable'],
  ] as const)('never presents missing/stale/stopped data as a live zero: %j', async (options, state) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    const app = await fixture(options as never);
    try {
      const response = (await app.inject({ url: '/?databaseId=13', headers: asUser() })).json();
      expect(response.containers).toEqual([]); expect(response.resource.state).toBe(state);
    } finally { await app.close(); }
  });
  it('uses local samples only for a local database', async () => {
    const app = await fixture({ row: { ...nodeDatabase, serverId: null, containerName: 'nd-db-orders', nodeContainerName: null } });
    try {
      const result = (await app.inject({ url: '/?databaseId=13', headers: asUser() })).json();
      expect(result.host).toBeNull(); expect(result.containers).toHaveLength(1); expect(result.containers[0].cpuPct).toBe(99);
      expect(result.resource).toMatchObject({ serverId: null, state: 'live' });
    } finally { await app.close(); }
  });
  it.each(['0', '-1', '1.2', '9007199254740992', 'nope'])('rejects malformed database id %s', async id => {
    const app = await fixture();
    try { expect((await app.inject({ url: '/?databaseId=' + id, headers: asUser() })).statusCode).toBe(400); }
    finally { await app.close(); }
  });
});
