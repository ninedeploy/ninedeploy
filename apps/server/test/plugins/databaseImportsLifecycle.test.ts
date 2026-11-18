import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const jobs = vi.hoisted(() => ({
  expireStaleImports: vi.fn(), pruneFinishedImports: vi.fn(), pruneOrphanStaging: vi.fn(), recoverInterruptedImports: vi.fn(),
  expireStaleVolumeImports: vi.fn(), pruneFinishedVolumeImports: vi.fn(), pruneOrphanVolumeStaging: vi.fn(), recoverInterruptedVolumeImports: vi.fn(),
  pruneFinishedUpgrades: vi.fn(), recoverInterruptedUpgrades: vi.fn(), pinUnversionedDatabases: vi.fn(),
}));
vi.mock('../../src/lib/databaseImport.js', () => jobs);
vi.mock('../../src/lib/volumeImport.js', () => jobs);
vi.mock('../../src/lib/databaseUpgrade.js', () => jobs);
vi.mock('../../src/lib/databaseVersionPin.js', () => jobs);
const plugin = (await import('../../src/plugins/databaseImports.js')).default;
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
let app: FastifyInstance | undefined;

beforeEach(() => {
  for (const job of Object.values(jobs)) job.mockReset().mockResolvedValue([]);
  jobs.pinUnversionedDatabases.mockResolvedValue({ pinned: 0, left: 0 });
});
afterEach(async () => {
  await app?.close();
  vi.useRealTimers();
});

async function boot() {
  app = Fastify({ logger: false });
  app.decorate('db', {} as never);
  await app.register(plugin, { intervalMs: 1000 });
  await app.ready();
  return app;
}

it.each([false, true])('%s closed owner after a gated version pin', async closed => {
  const pin = Promise.withResolvers<{ pinned: number; left: number }>();
  jobs.pinUnversionedDatabases.mockReturnValue(pin.promise);
  try {
    const server = await boot();
    expect(jobs.pinUnversionedDatabases).toHaveBeenCalledOnce();
    expect(jobs.expireStaleImports).toHaveBeenCalledOnce();
    if (closed) await server.close();
    pin.resolve({ pinned: 0, left: 0 });
    await checkpoint();
    const actual = jobs.recoverInterruptedUpgrades.mock.calls.length;
    console.log(`CONTROL: boot expiry sweep ran = ${jobs.expireStaleImports.mock.calls.length === 1}`);
    console.log(`EXPECTED: upgrade recovery calls=${closed ? 0 : 1} | ACTUAL: ${actual}`);
    console.log(actual === (closed ? 0 : 1) ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(actual).toBe(closed ? 0 : 1);
  } finally { pin.resolve({ pinned: 0, left: 0 }); await checkpoint(); }
});

it('starts no upgrade recovery when version pinning fails after close', async () => {
  const pin = Promise.withResolvers<{ pinned: number; left: number }>();
  jobs.pinUnversionedDatabases.mockReturnValue(pin.promise);
  try {
    await boot();
    await app!.close();
    pin.reject(new Error('controlled Docker inspection failure'));
    await checkpoint();
    expect(jobs.recoverInterruptedUpgrades).not.toHaveBeenCalled();
  } finally { pin.resolve({ pinned: 0, left: 0 }); await checkpoint(); }
});

it('still recovers upgrades after a failed version pin on a live owner', async () => {
  jobs.pinUnversionedDatabases.mockRejectedValue(new Error('controlled Docker inspection failure'));
  await boot();
  await checkpoint();
  expect(jobs.recoverInterruptedUpgrades).toHaveBeenCalledOnce();
});

it('starts no further sweep steps when its in-flight expiry finishes after close', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await boot();
  await checkpoint();
  const expiry = Promise.withResolvers<number[]>();
  const entered = Promise.withResolvers<void>();
  jobs.expireStaleImports.mockImplementationOnce(() => { entered.resolve(); return expiry.promise; });
  try {
    await vi.advanceTimersByTimeAsync(1000);
    await entered.promise;
    await app!.close();
    expiry.resolve([]);
    await checkpoint();
    // Only the startup sweep may have reached these steps.
    for (const job of [jobs.pruneOrphanStaging, jobs.pruneFinishedImports, jobs.expireStaleVolumeImports,
      jobs.pruneOrphanVolumeStaging, jobs.pruneFinishedVolumeImports, jobs.pruneFinishedUpgrades]) {
      expect(job).toHaveBeenCalledOnce();
    }
    expect(vi.getTimerCount()).toBe(0);
  } finally { expiry.resolve([]); await checkpoint(); }
});
