import { describe, expect, it, vi, beforeEach } from 'vitest';
import { backupDestinationRoutes } from '../src/modules/backupDestinations.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const asAdmin = () => asUser(1);
const asMember = () => ({ 'x-test-user': '2', 'x-test-role': 'member' });

const s3Mocks = vi.hoisted(() => ({ s3Test: vi.fn(async () => undefined) }));
vi.mock('../src/lib/s3.js', () => s3Mocks);

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../src/lib/crypto.js', () => cryptoMocks);

const auditMocks = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMocks);

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, name: 'minio', endpoint: 'https://s3.example.com', region: 'eu-central-1',
  bucket: 'b', prefix: 'nd', accessKeyId: 'ak', secretKeyEncrypted: 'enc:sk',
  active: true, createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

const appWith = async (fixtures: Record<string, unknown>) => {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
  await app.register(backupDestinationRoutes, { prefix: '/backup-destinations' });
  return app;
};

describe('backup destinations routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires authentication', async () => {
    const app = await appWith({});
    const res = await app.inject({ method: 'GET', url: '/backup-destinations' });
    expect(res.statusCode).toBe(401);
  });

  it('requires admin', async () => {
    const app = await appWith({ findFirst: { users: { id: 2, isOperator: false } } });
    const res = await app.inject({ method: 'GET', url: '/backup-destinations', headers: asMember() });
    expect(res.statusCode).toBe(403);
  });

  it('lists destinations without secrets', async () => {
    const app = await appWith({ findMany: { backupDestinations: [row()] } });
    const res = await app.inject({ method: 'GET', url: '/backup-destinations', headers: asAdmin() });
    expect(res.statusCode).toBe(200);
    const body = res.json()[0];
    expect(body).toMatchObject({ id: 1, name: 'minio', bucket: 'b', active: true });
    expect(Object.keys(body)).not.toContain('secretKeyEncrypted');
  });

  it('creates a destination with encrypted secret', async () => {
    const app = await appWith({ insert: { backup_destinations: [row({ id: 5 })] } });
    const res = await app.inject({
      method: 'POST', url: '/backup-destinations', headers: asAdmin(),
      payload: { name: 'minio', endpoint: 'https://s3.example.com', bucket: 'b', accessKeyId: 'ak', secretAccessKey: 'sk' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 5 });
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith('sk');
  });

  it('rejects an incomplete or non-http endpoint payload', async () => {
    const app = await appWith({});
    const missing = await app.inject({
      method: 'POST', url: '/backup-destinations', headers: asAdmin(),
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('validation_error');
    const badUrl = await app.inject({
      method: 'POST', url: '/backup-destinations', headers: asAdmin(),
      payload: { name: 'x', endpoint: 'ftp://x', bucket: 'b', accessKeyId: 'ak', secretAccessKey: 'sk' },
    });
    expect(badUrl.statusCode).toBe(400);
  });

  it('defaults region and prefix when omitted', async () => {
    const app = await appWith({ insert: { backup_destinations: [row({ id: 6 })] } });
    const res = await app.inject({
      method: 'POST', url: '/backup-destinations', headers: asAdmin(),
      payload: { name: 'min', endpoint: 'https://s3.example.com', bucket: 'b', accessKeyId: 'ak', secretAccessKey: 'sk' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts explicit region/prefix and treats blanks as defaults', async () => {
    const app = await appWith({ insert: { backup_destinations: [row({ id: 7 })] } });
    const res = await app.inject({
      method: 'POST', url: '/backup-destinations', headers: asAdmin(),
      payload: { name: 'min2', endpoint: 'https://s3.example.com', region: '', prefix: '  ', bucket: 'b', accessKeyId: 'ak', secretAccessKey: 'sk' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts an empty body on create (fails validation)', async () => {
    const app = await appWith({});
    const res = await app.inject({ method: 'POST', url: '/backup-destinations', headers: asAdmin() });
    expect(res.statusCode).toBe(400);
  });

  it('reports a failed insert', async () => {
    const app = await appWith({ insert: { backup_destinations: [] } });
    const res = await app.inject({
      method: 'POST', url: '/backup-destinations', headers: asAdmin(),
      payload: { name: 'min', endpoint: 'https://s3.example.com', bucket: 'b', accessKeyId: 'ak', secretAccessKey: 'sk' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('patches fields and keeps the stored secret when omitted', async () => {
    const app = await appWith({ update: { backup_destinations: [row({ name: 'renamed', active: false })] } });
    const res = await app.inject({
      method: 'PATCH', url: '/backup-destinations/1', headers: asAdmin(),
      payload: { name: 'renamed', active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(cryptoMocks.encrypt).not.toHaveBeenCalled();
  });

  it('patches endpoint, region, bucket, prefix and accessKeyId', async () => {
    const app = await appWith({ update: { backup_destinations: [row()] } });
    const res = await app.inject({
      method: 'PATCH', url: '/backup-destinations/1', headers: asAdmin(),
      payload: { endpoint: 'https://other.example.com', region: 'us-west-2', bucket: 'b2', prefix: 'p2', accessKeyId: 'ak2' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('ignores empty-string patch fields', async () => {
    const app = await appWith({ update: { backup_destinations: [row()] } });
    const res = await app.inject({
      method: 'PATCH', url: '/backup-destinations/1', headers: asAdmin(),
      payload: { name: '  ', endpoint: '', bucket: '' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('re-encrypts a rotated secret on patch', async () => {
    const app = await appWith({ update: { backup_destinations: [row()] } });
    const res = await app.inject({
      method: 'PATCH', url: '/backup-destinations/1', headers: asAdmin(),
      payload: { secretAccessKey: 'new-sk' },
    });
    expect(res.statusCode).toBe(200);
    expect(cryptoMocks.encrypt).toHaveBeenCalledWith('new-sk');
  });

  it('404s when patching a missing destination', async () => {
    const app = await appWith({ update: { backup_destinations: [] } });
    const res = await app.inject({
      method: 'PATCH', url: '/backup-destinations/99', headers: asAdmin(),
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('accepts an empty body on patch (no changes)', async () => {
    const app = await appWith({ update: { backup_destinations: [row()] } });
    const res = await app.inject({ method: 'PATCH', url: '/backup-destinations/1', headers: asAdmin() });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a patch with invalid field types', async () => {
    const app = await appWith({ update: { backup_destinations: [row()] } });
    const res = await app.inject({
      method: 'PATCH', url: '/backup-destinations/1', headers: asAdmin(),
      payload: { active: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('deletes a destination', async () => {
    const app = await appWith({ findFirst: { backupDestinations: row() } });
    const res = await app.inject({ method: 'DELETE', url: '/backup-destinations/1', headers: asAdmin() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('tests connectivity through the S3 client', async () => {
    const app = await appWith({ findFirst: { backupDestinations: row() } });
    const res = await app.inject({ method: 'POST', url: '/backup-destinations/1/test', headers: asAdmin() });
    expect(res.statusCode).toBe(200);
    expect(s3Mocks.s3Test).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'b' }));
  });

  it('surfaces test failures as 400', async () => {
    s3Mocks.s3Test.mockRejectedValueOnce(new Error('403 from host'));
    const app = await appWith({ findFirst: { backupDestinations: row() } });
    const res = await app.inject({ method: 'POST', url: '/backup-destinations/1/test', headers: asAdmin() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('403 from host');
    // Non-Error rejections are stringified.
    s3Mocks.s3Test.mockRejectedValueOnce('plain failure');
    const res2 = await app.inject({ method: 'POST', url: '/backup-destinations/1/test', headers: asAdmin() });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.message).toContain('plain failure');
  });

  it('404s when testing a missing destination', async () => {
    const app = await appWith({ findFirst: { backupDestinations: undefined } });
    const res = await app.inject({ method: 'POST', url: '/backup-destinations/99/test', headers: asAdmin() });
    expect(res.statusCode).toBe(404);
  });
});
