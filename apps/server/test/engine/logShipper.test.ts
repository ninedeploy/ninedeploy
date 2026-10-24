import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { logDrainBatches, logDrainCursors, logDrains, services, servers } from '@ninedeploy/db';
import { shipLogsOnce, pruneLogDrainCursors, parseDockerLogLine, logQueueStatus, logDrainBinding, type ShipperDeps } from '../../src/engine/logShipper.js';
import { formatLogBatch } from '../../src/engine/logDrainManager.js';
import { decrypt, encrypt } from '../../src/lib/crypto.js';
import { observabilityDb } from '../fixtures/observability.js';

const fixtures: Awaited<ReturnType<typeof observabilityDb>>[] = [];
afterEach(() => { fixtures.splice(0).forEach((f) => { f.close(); }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  const f = await observabilityDb(); fixtures.push(f);
  const [drain] = await f.db.insert(logDrains).values({ name: 'receiver', url: 'https://logs.example/ingest' }).returning();
  let now = new Date('2026-10-22T15:00:00Z');
  const readLogs = vi.fn<ShipperDeps['readLogs']>(async () => ['2026-10-22T15:00:01.000000001Z one line']);
  const dispatch = vi.fn<ShipperDeps['dispatch']>(async () => ({ ok: true, status: 204 }));
  const deps = { readLogs, dispatch, now: () => now };
  const tick = () => shipLogsOnce(f.db, deps);
  return { ...f, drain: drain!, deps, tick, readLogs, dispatch, time: (v = '2026-10-22T15:01:00Z') => { now = new Date(v); } };
}

describe('durable log-drain shipper', () => {
  it('prunes retired empty cursors while preserving recent sources and cursors with pending logs', async () => {
    const f = await setup();
    const at = new Date('2026-10-22T15:00:00Z'), old = new Date(at.getTime() - 8 * 86400000);
    const binding = logDrainBinding(f.drain);
    await f.db.insert(logDrainCursors).values(['empty-retired', 'pending-retired', 'recent'].map((runtimeKey) => ({
      drainId: f.drain.id, serviceId: 1, runtimeKey, binding, lastTimestamp: old.toISOString(), updatedAt: runtimeKey === 'recent' ? at : old,
    })));
    await f.db.insert(logDrainBatches).values({ drainId: f.drain.id, serviceId: 1, runtimeKey: 'pending-retired', binding,
      payloadEncrypted: encrypt('[]'), payloadBytes: 64, entryCount: 1, nextAttemptAt: at, createdAt: old });
    await pruneLogDrainCursors(f.db, at);
    expect((await f.db.select().from(logDrainCursors)).map((r) => r.runtimeKey).sort()).toEqual(['pending-retired', 'recent']);
    expect(await f.db.select().from(logDrainBatches)).toHaveLength(1);
  });

  it('starts without backfill and delivers only newer timestamps', async () => {
    const f = await setup();
    await f.tick(); expect(f.readLogs).not.toHaveBeenCalled();
    f.readLogs.mockResolvedValue(['2026-10-22T15:00:00Z old boundary', '2026-10-22T15:00:01.000000001Z new']);
    f.time();
    expect(await f.tick()).toMatchObject({ shipped: 1, failed: 0, queued: 1 });
    expect(f.dispatch.mock.calls[0]![1]).toEqual([expect.objectContaining({ line: 'new', service: 'web' })]);
    await f.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('captures a failed delivery in ciphertext and retries without re-reading its stopped source', async () => {
    const f = await setup(); await f.tick(); f.time();
    f.dispatch.mockResolvedValue({ ok: false, status: 503 });
    await f.tick();
    const [batch] = await f.db.select().from(logDrainBatches);
    expect(batch!.payloadEncrypted).not.toContain('one line');
    expect(JSON.parse(decrypt(batch!.payloadEncrypted))[0].line).toBe('one line');
    expect(batch!.lastError).toBe('http_503');
    await f.db.update(services).set({ status: 'stopped' });
    f.time('2026-10-22T15:02:00Z'); f.dispatch.mockResolvedValue({ ok: true, status: 204 });
    expect(await f.tick()).toMatchObject({ shipped: 1 });
    expect(await f.db.select().from(logDrainBatches)).toEqual([]);
  });
  it('does not resend a successful destination when another destination retries', async () => {
    const f = await setup();
    await f.db.insert(logDrains).values({ name: 'second', url: 'https://other.example/ingest' });
    await f.tick(); f.time();
    f.dispatch.mockImplementation(async (target) => ({ ok: target.url.includes('other'), status: target.url.includes('other') ? 204 : 503 }));
    await f.tick();
    f.dispatch.mockClear(); f.dispatch.mockResolvedValue({ ok: true, status: 204 });
    f.time('2026-10-22T15:02:00Z');
    await f.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch.mock.calls[0]![0].url).toBe(f.drain.url);
  });
  it('binds queued payloads to the destination and credentials under which they were captured', async () => {
    const f = await setup(); await f.tick(); f.time();
    f.dispatch.mockResolvedValue({ ok: false, status: 503 }); await f.tick();
    await f.db.update(logDrains).set({ url: 'https://changed.example' });
    f.dispatch.mockClear(); f.time('2026-10-22T15:02:00Z'); await f.tick();
    expect(f.dispatch).not.toHaveBeenCalled();
    const d = (await f.db.select().from(logDrains))[0]!;
    expect(await logQueueStatus(f.db, d)).toMatchObject({ pendingBatches: 1, pendingEntries: 1, blockedBatches: 1 });
    await f.db.update(logDrains).set({ url: f.drain.url }); await f.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps queues while disabled and resumes after being enabled', async () => {
    const f = await setup(); await f.tick(); f.time();
    f.dispatch.mockResolvedValue({ ok: false, status: 503 }); await f.tick();
    await f.db.update(logDrains).set({ enabled: false }); f.dispatch.mockClear();
    f.time('2026-10-22T15:02:00Z'); await f.tick();
    expect(f.dispatch).not.toHaveBeenCalled(); expect(await f.db.select().from(logDrainBatches)).toHaveLength(1);
    await f.db.update(logDrains).set({ enabled: true }); f.dispatch.mockResolvedValue({ ok: true, status: 204 });
    await f.tick(); expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps distinct host cursors for identically named containers', async () => {
    const f = await setup();
    await f.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.example', tokenEncrypted: encrypt('test') });
    await f.db.insert(services).values({ id: 2, name: 'Node Web', slug: 'node-web', serverId: 4, type: 'docker', status: 'running', runtimeId: 'web-7' });
    const remote = vi.fn(async () => ['2026-10-22T15:00:02Z from node']);
    const deps = { ...f.deps, readRemoteLogs: remote };
    await shipLogsOnce(f.db, deps); f.time(); await shipLogsOnce(f.db, deps);
    expect(remote).toHaveBeenCalledWith(4, 'web-7', '2026-10-22T15:00:00.000Z');
    const rows = await f.db.select().from(logDrainCursors);
    expect(rows.map((r) => r.runtimeKey).sort()).toEqual(['node:4:web-7', 'web-7']);
    expect(f.dispatch.mock.calls.flatMap((c) => c[1]).map((e) => e.line).sort()).toEqual(['from node', 'one line']);
  });
  it('respects per-service drain selection', async () => {
    const f = await setup();
    await f.db.insert(services).values({ id: 99, name: 'Elsewhere', slug: 'elsewhere' });
    await f.db.insert(logDrains).values({ name: 'private', url: 'https://private.example', serviceId: 99 });
    await f.tick(); f.time(); await f.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1); expect(f.dispatch.mock.calls[0]![0].url).toBe(f.drain.url);
  });
  it('preserves lines that share a timestamp across bounded batches', async () => {
    const f = await setup(); await f.tick(); f.time();
    f.readLogs.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => '2026-10-22T15:00:01.123456789Z line-' + i));
    await f.tick(); await f.tick();
    const lines = f.dispatch.mock.calls.flatMap((c) => c[1]).map((e) => e.line);
    expect(lines).toHaveLength(1001); expect(new Set(lines).size).toBe(1001); expect(lines.at(-1)).toBe('line-1000');
  });
  it('rolls a failed capture back without advancing the durable cursor', async () => {
    const f = await setup(); await f.tick(); f.time();
    const original = f.db.transaction.bind(f.db);
    const spy = vi.spyOn(f.db, 'transaction').mockImplementation(async (run) => original(async (tx) => { await run(tx); throw new Error('commit failed'); }));
    await expect(f.tick()).rejects.toThrow('commit failed');
    spy.mockRestore();
    expect(await f.db.select().from(logDrainBatches)).toEqual([]);
    expect((await f.db.select().from(logDrainCursors))[0]!.lastTimestamp).toBe('2026-10-22T15:00:00.000Z');
    await f.tick(); expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('pauses at the encrypted payload limit and retains the unprocessed cursor', async () => {
    const f = await setup(); await f.configure({ logQueueMaxMb: 1 }); await f.tick(); f.time();
    const payloadEncrypted = encrypt(JSON.stringify([{ timestamp: '2026-10-22T15:00:01Z', service: 'web', container: 'web-7', line: 'x'.repeat(200000) }]));
    for (let i = 0; i < 3; i++) await f.db.insert(logDrainBatches).values({
      drainId: f.drain.id, serviceId: 1, runtimeKey: 'web-7', binding: logDrainBinding(f.drain), payloadEncrypted,
      payloadBytes: Buffer.byteLength(payloadEncrypted), entryCount: 1, nextAttemptAt: new Date('2026-10-23'),
    });
    f.readLogs.mockResolvedValue(['2026-10-22T15:00:02Z ' + 'y'.repeat(200000)]);
    expect(await f.tick()).toMatchObject({ paused: 1, queued: 0 });
    const [cursor] = await f.db.select().from(logDrainCursors);
    expect(cursor!.pausedReason).toBe('queue_full'); expect(cursor!.lastTimestamp).toBe('2026-10-22T15:00:00.000Z');
    expect(await logQueueStatus(f.db, f.drain)).toMatchObject({ pendingBatches: 3, pausedSources: 1 });
    await f.db.delete(logDrainBatches); await f.tick();
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('reports oversized lines without dropping or advancing them', async () => {
    const f = await setup(); await f.tick(); f.time();
    f.readLogs.mockResolvedValue(['2026-10-22T15:00:02Z ' + 'x'.repeat(300000)]);
    expect(await f.tick()).toMatchObject({ queued: 0, paused: 1 });
    expect((await f.db.select().from(logDrainCursors))[0]!.pausedReason).toBe('line_too_large');
  });
  it('leaves a stopped or deleted source independent of delivery and cleans foreign keys on deletion', async () => {
    const f = await setup(); await f.tick(); f.time();
    f.dispatch.mockResolvedValue({ ok: false, status: 503 }); await f.tick();
    await f.db.delete(logDrains).where(eq(logDrains.id, f.drain.id));
    expect(await f.db.select().from(logDrainBatches)).toEqual([]);
    expect(await f.db.select().from(logDrainCursors)).toEqual([]);
  });
  it('rotates queued payloads through the normal master-key registry', async () => {
    const f = await setup(); await f.tick(); f.time();
    f.dispatch.mockResolvedValue({ ok: false, status: 503 }); await f.tick();
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', '0:' + 'a'.repeat(64));
    const oldKey = await import('../../src/lib/crypto.js');
    const before = oldKey.encrypt(JSON.stringify([{ line: 'queued across rotation' }]));
    await f.db.update(logDrainBatches).set({ payloadEncrypted: before });
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', '0:' + 'a'.repeat(64) + ',1:' + 'b'.repeat(64));
    const newKey = await import('../../src/lib/crypto.js');
    const rotation = await import('../../src/lib/keyRotation.js');
    await rotation.rotateSecrets(f.db);
    const after = (await f.db.select().from(logDrainBatches))[0]!.payloadEncrypted;
    expect(after.startsWith('v1:')).toBe(true);
    expect(newKey.decrypt(after)).toBe(newKey.decrypt(before));
  });
  it('stops work on cancellation without acknowledging queued entries', async () => {
    const f = await setup(); await f.tick(); f.time();
    const signal = AbortSignal.abort();
    expect(await shipLogsOnce(f.db, { ...f.deps, signal })).toMatchObject({ queued: 0, shipped: 0 });
    expect(f.readLogs).not.toHaveBeenCalled();
  });
  it('retries a failed log read without advancing its cursor', async () => {
    const f = await setup(); await f.tick(); f.time();
    f.readLogs.mockRejectedValueOnce(new Error('runtime restarting'));
    await f.tick(); expect((await f.db.select().from(logDrainCursors))[0]!.lastTimestamp).toBe('2026-10-22T15:00:00.000Z');
    await f.tick(); expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('parses timestamps and rejects malformed timestamps', () => {
    expect(parseDockerLogLine('2026-10-22T15:00:01.123456789Z hello')).toEqual({ ts: '2026-10-22T15:00:01.123456789Z', line: 'hello' });
    expect(parseDockerLogLine('not timestamped')).toBeNull();
    expect(parseDockerLogLine('2026-99-99T99:99:99Z invalid')).toBeNull();
  });
  it('labels Loki streams the way log search queries them', () => {
    const body = JSON.parse(formatLogBatch('loki', 'json', [
      { timestamp: '2026-10-22T15:00:02Z', service: 'web', container: 'web-7', line: 'a' },
    ]).body);
    expect(body.streams[0].stream).toMatchObject({ service: 'web', job: 'ninedeploy' });
  });
});
