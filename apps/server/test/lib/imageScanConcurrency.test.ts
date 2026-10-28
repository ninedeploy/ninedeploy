import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => { process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32); });
const mocks = vi.hoisted(() => ({ imageId: vi.fn(), scan: vi.fn() }));
vi.mock('../../src/lib/imageScan.js', async original => ({
  ...await original<typeof import('../../src/lib/imageScan.js')>(),
  containerImageId: mocks.imageId,
  scanServiceImage: mocks.scan,
}));

const { setImageScanPolicy } = await import('../../src/lib/imageScan.js');
const { serviceImageScanRoutes } = await import('../../src/modules/imageScans.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let db: DB;
beforeEach(async () => {
  mocks.imageId.mockReset(); mocks.scan.mockReset();
  db = await migratedDb();
  await db.insert(users).values({ id: 2, email: 'ops@example.com', passwordHash: 'x' });
  await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'web-1' } as never);
  await setImageScanPolicy(db, { enabled: true });
});
afterEach(() => closeMigratedDb(db));

it('admits only one manual scan while image inspection is in flight', async () => {
  const inspected = deferred<void>();
  const secondInspected = deferred<void>();
  const releaseInspection = deferred<string>();
  const finishScan = deferred<never>();
  mocks.imageId.mockImplementation(() => {
    if (mocks.imageId.mock.calls.length === 1) inspected.resolve();
    else secondInspected.resolve();
    return releaseInspection.promise;
  });
  mocks.scan.mockReturnValue(finishScan.promise);
  const app = await buildTestApp({ db });
  await app.register(serviceImageScanRoutes, { prefix: '/services' });
  const request = () => app.inject({ method: 'POST', url: '/services/5/image-scan', headers: asUser(1) });
  const first = request();
  await inspected.promise;
  const status = await app.inject({ method: 'GET', url: '/services/5/image-scan', headers: asUser(1) });
  const second = request();
  await Promise.race([second, secondInspected.promise]);
  // Let both requests proceed; the first scan stays pending until assertions finish.
  releaseInspection.resolve(`sha256:${'a'.repeat(64)}`);
  const responses = await Promise.all([first, second]);
  try {
    expect(status.json().scanning).toBe(true);
    expect(responses.map(response => response.statusCode).sort()).toEqual([202, 409]);
    expect(responses.find(response => response.statusCode === 409)?.json().error.code).toBe('image_scan_running');
    expect(mocks.scan).toHaveBeenCalledOnce();
  } finally {
    finishScan.resolve({ status: 'ok', counts: { critical: 0, high: 0 } } as never);
    await app.close();
  }
});

it('releases admission after an image inspection failure so the operator can retry', async () => {
  mocks.imageId.mockRejectedValue(new Error('container missing'));
  const app = await buildTestApp({ db });
  await app.register(serviceImageScanRoutes, { prefix: '/services' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({ method: 'POST', url: '/services/5/image-scan', headers: asUser(1) });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('image_scan_not_running');
      const status = await app.inject({ method: 'GET', url: '/services/5/image-scan', headers: asUser(1) });
      expect(status.json().scanning).toBe(false);
    }
    expect(mocks.imageId).toHaveBeenCalledTimes(2);
    expect(mocks.scan).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
