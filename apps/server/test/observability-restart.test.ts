import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, services, logDrains } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { shipLogsOnce, type ShipperDeps } from '../src/engine/logShipper.js';

const closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).forEach((close) => { close(); }); vi.restoreAllMocks(); });

describe('durable log delivery', () => {
  it('delivers a captured failed batch after a restart even when its source container has stopped', async () => {
    const conn = createDb({ url: 'file::memory:' });
    await conn.ready;
    closers.push(() => conn.client!.close());
    await runMigrations(conn.db);
    const [svc] = await conn.db.insert(services).values({
      name: 'Web', slug: 'web', type: 'docker', status: 'running', runtimeId: 'web-7', replicas: 1,
    }).returning();
    await conn.db.insert(logDrains).values({ name: 'receiver', url: 'https://logs.example/ingest' });
    let now = new Date('2026-10-22T15:00:00Z');
    const readLogs = vi.fn(async () => ['2026-10-22T15:00:01.000000001Z captured before restart']);
    const dispatch = vi.fn<ShipperDeps['dispatch']>(async () => ({ ok: false, status: 503 }));
    const deps = { readLogs, dispatch, now: () => now };
    await shipLogsOnce(conn.db, deps);
    now = new Date('2026-10-22T15:00:02Z');
    await shipLogsOnce(conn.db, deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await conn.db.update(services).set({ status: 'stopped' }).where(eq(services.id, svc!.id));
    dispatch.mockClear();
    dispatch.mockResolvedValue({ ok: true, status: 204 });
    now = new Date('2026-10-22T15:01:00Z');
    await shipLogsOnce(conn.db, deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ line: 'captured before restart' }),
    ]);
  });
});
