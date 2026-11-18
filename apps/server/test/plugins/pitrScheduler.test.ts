/**
 * R3: plugins/pitrScheduler.ts — the boot sweep, then one upkeep pass an hour
 * over every database with point-in-time recovery on, one at a time; nothing
 * after close.
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lib = vi.hoisted(() => ({
  swept: 0,
  passes: [] as string[],
  dbs: [{ slug: 'a' }, { slug: 'b' }] as Array<{ slug: string; id?: number }>,
  failSweep: false,
  failList: false,
  remoteTicks: 0,
}));
vi.mock('../../src/lib/pitrRemote.js', () => ({ remotePitrTick: vi.fn(async () => { lib.remoteTicks++; }), drainRemotePitrCheckpoints: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/pitr.js', () => ({
  failInterruptedPitrRecoveries: vi.fn(async () => { if (lib.failSweep) throw new Error('db locked'); lib.swept++; return 0; }),
  pitrDatabases: vi.fn(async () => { if (lib.failList) throw new Error('db gone'); return lib.dbs; }),
  pitrMaintenance: vi.fn(async (_db: unknown, d: { slug: string }) => { lib.passes.push(d.slug); if (d.slug === 'a') throw new Error('one database failing'); }),
}));

import pitrScheduler from '../../src/plugins/pitrScheduler.js';

async function boot() {
  const app = Fastify({ logger: false });
  app.decorate('db', {} as never);
  await app.register(pitrScheduler);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.useFakeTimers();
  lib.swept = 0;
  lib.passes = [];
  lib.failSweep = false;
  lib.failList = false;
  lib.remoteTicks = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('pitrScheduler', () => {
  it('checks remote checkpoint schedules every minute and stops after close', async () => {
    const app = await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lib.remoteTicks).toBe(1);
    await app.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(lib.remoteTicks).toBe(1);
  });
  it('sweeps interrupted recoveries at boot, then passes over every database ten minutes in and hourly', async () => {
    const app = await boot();
    expect(lib.swept).toBe(1);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(lib.passes).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    // One database failing does not stop the pass.
    expect(lib.passes).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(lib.passes).toEqual(['a', 'b', 'a', 'b']);
    await app.close();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(lib.passes).toHaveLength(4);
  });
  it('boots even when the sweep or a pass cannot read the database', async () => {
    lib.failSweep = true;
    lib.failList = true;
    const app = await boot();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(lib.passes).toEqual([]);
    await app.close();
  });
});
