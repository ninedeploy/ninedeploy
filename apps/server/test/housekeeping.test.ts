import { describe, expect, it, vi } from 'vitest';
import { housekeepingRoutes } from '../src/modules/housekeeping.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const execMock = vi.hoisted(() => ({
  run: vi.fn(async (_cmd: string, _args: string[], _opts: unknown, onOutput?: (chunk: string, isErr: boolean) => void) => {
    onOutput?.('Total reclaimed space: 100MB\n', false);
  }),
}));

vi.mock('../src/lib/exec.js', () => ({
  run: execMock.run,
}));

describe('housekeeping and auto-prune API', () => {
  it('gets auto-prune config and disk status', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(housekeepingRoutes);

    const res = await app.inject({ method: 'GET', url: '/prune/config', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.thresholdPercent).toBe(85);
    expect(body.diskTotalBytes).toBeGreaterThan(0);
  });

  it('updates auto-prune config', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(housekeepingRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/prune/config',
      headers: asUser(),
      payload: {
        thresholdPercent: 90,
        pruneVolumes: true,
        maxAgeHours: 48,
      },
    });

    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.thresholdPercent).toBe(90);
    expect(updated.pruneVolumes).toBe(true);
    expect(updated.maxAgeHours).toBe(48);

    // Invalid config
    const resInvalid = await app.inject({
      method: 'PATCH',
      url: '/prune/config',
      headers: asUser(),
      payload: { thresholdPercent: 120 },
    });
    expect(resInvalid.statusCode).toBe(422);
  });

  it('triggers manual disk auto-prune run', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(housekeepingRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/prune',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('requires admin authorization', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(housekeepingRoutes);

    const res = await app.inject({ method: 'GET', url: '/prune/config', headers: asUser({ isOperator: false }) });
    expect(res.statusCode).toBe(403);
  });
});
