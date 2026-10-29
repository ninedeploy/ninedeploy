import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services, users, type DB } from '@ninedeploy/db';
import { sql } from 'drizzle-orm';

vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
const mocks = vi.hoisted(() => ({ capability: vi.fn(), scan: vi.fn() }));
vi.mock('../../src/lib/agentCapabilities.js', async original => ({ ...await original<typeof import('../../src/lib/agentCapabilities.js')>(), assertNodeCapability: mocks.capability }));
vi.mock('../../src/lib/imageScan.js', async original => ({ ...await original<typeof import('../../src/lib/imageScan.js')>(), scanNodeServiceImage: mocks.scan }));
const { setImageScanPolicy } = await import('../../src/lib/imageScan.js');
const { serviceImageScanRoutes } = await import('../../src/modules/imageScans.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let db: DB;
beforeEach(async () => {
  mocks.capability.mockReset(); mocks.scan.mockReset();
  db = await migratedDb();
  await db.insert(users).values({ id: 2, email: 'ops@example.com', passwordHash: 'x' });
  await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'web-1' } as never);
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.run(sql`UPDATE services SET server_id = 3 WHERE id = 5`);
  await setImageScanPolicy(db, { enabled: true });
});
afterEach(() => closeMigratedDb(db));

it('admits one node scan while capability discovery is in flight', async () => {
  const firstEntered = deferred<void>(), secondEntered = deferred<void>(), release = deferred<void>(), finish = deferred<never>();
  mocks.capability.mockImplementation(() => { if (mocks.capability.mock.calls.length === 1) firstEntered.resolve(); else secondEntered.resolve(); return release.promise; });
  mocks.scan.mockReturnValue(finish.promise);
  const app = await buildTestApp({ db });
  await app.register(serviceImageScanRoutes, { prefix: '/services' });
  const request = () => app.inject({ method: 'POST', url: '/services/5/image-scan', headers: asUser(1) });
  const first = request(); await firstEntered.promise;
  const second = request(); await Promise.race([second, secondEntered.promise]);
  release.resolve();
  const responses = await Promise.all([first, second]);
  try {
    expect(responses.map(response => response.statusCode).sort()).toEqual([202, 409]);
    expect(responses.find(response => response.statusCode === 202)?.json()).toEqual({ started: true, imageId: null });
    expect(responses.find(response => response.statusCode === 409)?.json().error.code).toBe('image_scan_running');
    expect(mocks.scan).toHaveBeenCalledOnce();
  } finally { finish.resolve(null as never); await app.close(); }
});

it('releases the node admission after a capability refusal', async () => {
  mocks.capability.mockRejectedValue(new Error('node unavailable'));
  const app = await buildTestApp({ db });
  await app.register(serviceImageScanRoutes, { prefix: '/services' });
  try {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/services/5/image-scan', headers: asUser(1) });
      expect(res.statusCode).not.toBe(202);
      expect((await app.inject({ method: 'GET', url: '/services/5/image-scan', headers: asUser(1) })).json().scanning).toBe(false);
    }
    expect(mocks.capability).toHaveBeenCalledTimes(2);
    expect(mocks.scan).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
