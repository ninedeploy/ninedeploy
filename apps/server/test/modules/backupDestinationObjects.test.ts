/**
 * 0.14 — GET /v1/backup-destinations/:id/objects (DESIGN §3.3): the S3 picker
 * for operator imports. Operator-only like every destination route; the
 * prefix defaults to the destination's own and may not leave it; S3 errors
 * are a 502 that never carries the response body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));
const m = vi.hoisted(() => ({ s3List: vi.fn() }));
vi.mock('../../src/lib/s3.js', async (orig) => ({ ...(await orig<typeof import('../../src/lib/s3.js')>()), s3List: m.s3List }));
vi.mock('../../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { backupDestinationRoutes } = await import('../../src/modules/backupDestinations.js');
const { asUser, buildTestApp, createFakeDb } = await import('../helpers.js');
const { encrypt } = await import('../../src/lib/crypto.js');

const dest = (prefix = 'ninedeploy') => ({
  id: 3,
  name: 'R2',
  endpoint: 'https://r2.invalid',
  region: 'auto',
  bucket: 'b',
  prefix,
  accessKeyId: 'AKIA',
  secretKeyEncrypted: encrypt('secret'),
  active: true,
  createdAt: new Date(0),
});

async function app(row: Record<string, unknown> | undefined) {
  const a = await buildTestApp({ db: createFakeDb({ findFirst: { backup_destinations: row } }) as never });
  await a.register(backupDestinationRoutes, { prefix: '/backup-destinations' });
  return a;
}
afterEach(() => vi.clearAllMocks());

describe('GET /backup-destinations/:id/objects', () => {
  it('lists under the destination prefix by default', async () => {
    m.s3List.mockResolvedValue([
      { key: 'ninedeploy/a.dump', sizeBytes: 12, lastModified: '2026-10-01T00:00:00.000Z' },
      { key: 'ninedeploy/b.sql.gz', sizeBytes: 3, lastModified: '' },
    ]);
    const res = await (await app(dest())).inject({ method: 'GET', url: '/backup-destinations/3/objects', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { key: 'ninedeploy/a.dump', sizeBytes: 12, lastModified: '2026-10-01T00:00:00.000Z' },
      { key: 'ninedeploy/b.sql.gz', sizeBytes: 3, lastModified: null },
    ]);
    expect(m.s3List).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'b', secretAccessKey: 'secret' }), 'ninedeploy/');
  });

  it('accepts a narrower prefix, refuses one outside the destination prefix', async () => {
    m.s3List.mockResolvedValue([]);
    const a = await app(dest('/ninedeploy/'));
    expect((await a.inject({ method: 'GET', url: '/backup-destinations/3/objects?prefix=ninedeploy/2026', headers: asUser() })).statusCode).toBe(200);
    expect(m.s3List).toHaveBeenLastCalledWith(expect.anything(), 'ninedeploy/2026');
    expect((await a.inject({ method: 'GET', url: '/backup-destinations/3/objects?prefix=other/', headers: asUser() })).statusCode).toBe(400);
    const open = await app(dest(''));
    expect((await open.inject({ method: 'GET', url: '/backup-destinations/3/objects', headers: asUser() })).statusCode).toBe(200);
    expect(m.s3List).toHaveBeenLastCalledWith(expect.anything(), '');
  });

  it('is operator-only, 404s an unknown destination, and hides S3 error bodies', async () => {
    const a = await app(dest());
    expect((await a.inject({ method: 'GET', url: '/backup-destinations/3/objects', headers: asUser({ id: 7, isOperator: false }) })).statusCode).toBe(403);
    expect((await (await app(undefined)).inject({ method: 'GET', url: '/backup-destinations/3/objects', headers: asUser() })).statusCode).toBe(404);
    m.s3List.mockRejectedValue(new Error('S3 list failed (403): <Error>InvalidAccessKeyId AKIA</Error>'));
    const res = await a.inject({ method: 'GET', url: '/backup-destinations/3/objects', headers: asUser() });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('AKIA');
    expect(m.s3List).toHaveBeenCalled();
  });
});
