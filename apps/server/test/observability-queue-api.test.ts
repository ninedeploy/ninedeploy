import { afterEach, describe, expect, it, vi } from 'vitest';
import { logDrainBatches, logDrainCursors, logDrains } from '@ninedeploy/db';
import { logDrainRoutes } from '../src/modules/logDrains.js';
import { shipLogsOnce, type ShipperDeps } from '../src/engine/logShipper.js';
import { observabilityDb } from './fixtures/observability.js';
import { asUser, buildTestApp } from './helpers.js';

const fixtures: Awaited<ReturnType<typeof observabilityDb>>[] = [];
afterEach(() => { fixtures.splice(0).forEach((f) => { f.close(); }); vi.restoreAllMocks(); });
async function queued() {
  const f = await observabilityDb(); fixtures.push(f);
  const [drain] = await f.db.insert(logDrains).values({ name: 'logs', url: 'https://logs.example' }).returning();
  let now = new Date('2026-10-22T15:00:00Z');
  const deps: ShipperDeps = {
    readLogs: async () => ['2026-10-22T15:00:01Z private log body'],
    dispatch: async () => ({ ok: false, status: 503 }), now: () => now,
  };
  await shipLogsOnce(f.db, deps); now = new Date('2026-10-22T15:01:00Z'); await shipLogsOnce(f.db, deps);
  const app = await buildTestApp({ db: f.db }); await app.register(logDrainRoutes);
  return { ...f, app, id: drain!.id };
}
describe('operator log queue API', () => {
  it('returns counts and timing without returning log payloads or ciphertext', async () => {
    const f = await queued();
    const r = await f.app.inject({ url: '/' + f.id + '/queue', headers: asUser() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ pendingBatches: 1, pendingEntries: 1, blockedBatches: 0, pausedSources: 0 });
    expect(r.body).not.toContain('private log body'); expect(r.body).not.toContain('payloadEncrypted');
    await f.app.close();
  });
  it.each(['GET', 'POST', 'DELETE'] as const)('refuses non-operator %s queue actions without changing stored logs', async (method) => {
    const f = await queued();
    const url = '/' + f.id + '/queue' + (method === 'POST' ? '/retry' : '');
    expect((await f.app.inject({ method, url })).statusCode).toBe(401);
    expect((await f.app.inject({ method, url, headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(403);
    expect(await f.db.select().from(logDrainBatches)).toHaveLength(1);
    await f.app.close();
  });
  it('schedules retry without dropping its data and permits explicit discard without rewinding capture', async () => {
    const f = await queued();
    const cursor = (await f.db.select().from(logDrainCursors))[0]!;
    const r = await f.app.inject({ method: 'POST', url: '/' + f.id + '/queue/retry', headers: asUser() });
    expect(r.statusCode).toBe(200); expect(r.json().pendingEntries).toBe(1);
    expect((await f.db.select().from(logDrainBatches))[0]!.nextAttemptAt.getTime()).toBeGreaterThan(new Date('2026-10-22T15:00:00Z').getTime());
    const clear = await f.app.inject({ method: 'DELETE', url: '/' + f.id + '/queue', headers: asUser() });
    expect(clear.json()).toEqual({ discardedBatches: 1 });
    expect(await f.db.select().from(logDrainBatches)).toEqual([]);
    expect((await f.db.select().from(logDrainCursors))[0]!.lastTimestamp).toBe(cursor.lastTimestamp);
    await f.app.close();
  });
  it('returns 404 for a missing destination', async () => {
    const f = await queued();
    expect((await f.app.inject({ url: '/999/queue', headers: asUser() })).statusCode).toBe(404);
    await f.app.close();
  });
});
