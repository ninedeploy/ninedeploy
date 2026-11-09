import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services, type DB } from '@ninedeploy/db';
import { migratedDb, closeMigratedDb } from '../lib/githubAppKit.js';
const state = vi.hoisted(() => ({ tasks: [] as Promise<unknown>[], probe: vi.fn() }));
vi.mock('../../src/lib/imageWatch.js', () => ({ fetchImageDigest: state.probe }));
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('../../src/lib/autoUpdate.js', async original => {
 const actual = await original<typeof import('../../src/lib/autoUpdate.js')>();
 return { ...actual, sweepAutoUpdates: (...args: Parameters<typeof actual.sweepAutoUpdates>) => { const task = actual.sweepAutoUpdates(...args); state.tasks.push(task); return task; } };
});
const plugin = (await import('../../src/plugins/autoUpdateScheduler.js')).default;
let db: DB;
const minute = 60000;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function boot() { const app = Fastify({ logger: false }); app.decorate('db', db); await app.register(plugin); await app.ready(); return app; }
beforeEach(async () => {
 db = await migratedDb(); state.tasks = []; state.probe.mockReset().mockResolvedValue('sha256:old');
 await db.insert(services).values({ id: 5, name: 'watched', slug: 'watched', type: 'docker', image: 'nginx:latest', status: 'running', autoUpdate: true, autoUpdateDigest: 'sha256:old' });
 vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); closeMigratedDb(db); });
it('control: sequential changed-image sweep enqueues once across later ticks', async () => {
 const app = await boot(); try {
  await vi.advanceTimersByTimeAsync(5 * minute); await state.tasks[0]; state.probe.mockResolvedValue('sha256:new');
  await vi.advanceTimersByTimeAsync(30 * minute); await state.tasks[1]; await vi.advanceTimersByTimeAsync(30 * minute); await state.tasks[2];
  expect(await db.query.deployments.findMany()).toHaveLength(1);
 } finally { await app.close(); await Promise.all(state.tasks); }
});
it('a pending interval sweep excludes the next interval and queues only one deployment', async () => {
 const app = await boot(); const entered = gate(); const blocked = gate(); let used = false;
 try {
  await vi.advanceTimersByTimeAsync(5 * minute); await state.tasks[0]; state.probe.mockResolvedValue('sha256:new');
  const original = db.$client.execute.bind(db.$client);
  vi.spyOn(db.$client, 'execute').mockImplementation((async (...args: Parameters<typeof original>) => {
   const s = args[0]; const sql = typeof s === 'string' ? s : s.sql; const result = await original(...args);
   if (!used && /select .* from "deployments"/i.test(sql)) { used = true; entered.release(); await blocked.promise; }
   return result;
  }) as typeof original);
  await vi.advanceTimersByTimeAsync(30 * minute); await entered.promise;
  await vi.advanceTimersByTimeAsync(30 * minute); if (state.tasks.length === 3) await state.tasks[2];
  const admitted = state.tasks.length - 1; blocked.release(); await Promise.all(state.tasks);
  const count = (await db.query.deployments.findMany()).length;
  console.log('EXPECTED: 1 admitted interval sweep / 1 deployment; ACTUAL:', admitted, count);
  console.log(admitted === 1 && count === 1 ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
  expect({ admitted, deployments: count }).toEqual({ admitted: 1, deployments: 1 });
 } finally { blocked.release(); await Promise.all(state.tasks); await app.close(); }
});
