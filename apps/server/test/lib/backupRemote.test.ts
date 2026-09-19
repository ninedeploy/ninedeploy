import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { activeDestination, deleteRemoteBackup, fetchRemoteBackup, uploadBackup } from '../../src/lib/backupRemote.js';
import { createFakeDb } from '../helpers.js';

const s3Mocks = vi.hoisted(() => ({
  s3PutFile: vi.fn(async () => undefined),
  s3GetToFile: vi.fn(async () => undefined),
  s3Delete: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/s3.js', () => s3Mocks);

const cryptoMocks = vi.hoisted(() => ({
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const dest = {
  id: 1, name: 'minio', endpoint: 'https://s3.example.com', region: 'eu-central-1',
  bucket: 'b', prefix: 'nd', accessKeyId: 'ak', secretKeyEncrypted: 'enc:sk',
  active: true, createdAt: new Date(), updatedAt: new Date(),
};

describe('activeDestination', () => {
  it('resolves the first active destination with the decrypted secret', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    const cfg = await activeDestination(db);
    expect(cfg).toMatchObject({ endpoint: 'https://s3.example.com', bucket: 'b', prefix: 'nd' });
  });

  it('returns null when none are active', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [{ ...dest, active: false }] } });
    expect(await activeDestination(db)).toBeNull();
  });

  it('returns null when the table query fails (pre-migration)', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: () => { throw new Error('no table'); } } });
    expect(await activeDestination(db)).toBeNull();
  });
});

describe('uploadBackup', () => {
  let tmp: string;
  beforeEach(() => {
    vi.clearAllMocks();
    tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-bk-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('uploads the encrypted envelope from disk (streamed) and stamps remoteKey + destination', async () => {
    const file = path.join(tmp, 'db-2026.dump');
    writeFileSync(file, 'v0:ZW5j');
    const stamp = vi.fn(() => [{}]);
    const db = createFakeDb({
      findMany: { backupDestinations: [dest] },
      update: { backups: stamp },
    });
    const lines: string[] = [];
    await uploadBackup(db, 5, file, (l) => lines.push(l));
    // The destination is recorded so a later fetch resolves the bucket that
    // actually holds the object, even after the active destination changes.
    expect(stamp).toHaveBeenCalledWith(expect.objectContaining({ remoteKey: 'nd/db-2026.dump', destinationId: 1 }), expect.anything());
    // The upload streams the on-disk file (bounded memory) — the envelope
    // bytes never pass through the heap as a readFileSync buffer.
    expect(s3Mocks.s3PutFile).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'b' }),
      'nd/db-2026.dump',
      file,
    );
    expect(lines.join('\n')).toContain('Uploaded to b/nd/db-2026.dump');
  });

  it('skips silently when no destination is configured', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [] } });
    const file = path.join(tmp, 'x.dump');
    writeFileSync(file, 'x');
    await uploadBackup(db, 5, file, () => {});
    expect(s3Mocks.s3PutFile).not.toHaveBeenCalled();
  });

  it('never throws when the upload fails', async () => {
    s3Mocks.s3PutFile.mockRejectedValueOnce('plain-string failure');
    const file = path.join(tmp, 'y.dump');
    writeFileSync(file, 'y');
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    const lines: string[] = [];
    await expect(uploadBackup(db, 5, file, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('remote upload failed');
    // Error rejections print their message.
    s3Mocks.s3PutFile.mockRejectedValueOnce(new Error('network down'));
    await expect(uploadBackup(db, 5, file, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines.join('\n')).toContain('network down');
  });
});

describe('fetchRemoteBackup / deleteRemoteBackup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('streams the remote object straight to a local file', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    const target = path.join(os.tmpdir(), `fetch-${Date.now()}`);
    const p = await fetchRemoteBackup(db, { remoteKey: 'nd/k' }, target);
    expect(p).toBe(target);
    // The GET pipes to disk (s3GetToFile) — multi-GB restores never buffer.
    expect(s3Mocks.s3GetToFile).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'b' }),
      'nd/k',
      target,
    );
    expect(existsSync(target)).toBe(false); // the s3 mock wrote nothing
    expect(statSync(target, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
  });

  it('throws when no destination is configured for a fetch', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [] } });
    await expect(fetchRemoteBackup(db, { remoteKey: 'k' }, '/tmp/x')).rejects.toThrow('No backup destination');
  });

  it('resolves the RECORDED destination, not the active one', async () => {
    // The backup was uploaded to destination 1; the operator has since made
    // destination 2 active. The fetch must go to the bucket holding the
    // object — the old row's key does not exist in the new bucket.
    const old = { ...dest, id: 1, bucket: 'old-bucket', active: false };
    const now = { ...dest, id: 2, bucket: 'new-bucket', active: true };
    const db = createFakeDb({ findMany: { backupDestinations: [old, now] } });
    await fetchRemoteBackup(db, { remoteKey: 'nd/k', destinationId: 1 }, '/tmp/x');
    expect(s3Mocks.s3GetToFile).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'old-bucket' }),
      'nd/k',
      '/tmp/x',
    );
    await deleteRemoteBackup(db, { remoteKey: 'nd/k', destinationId: 1 });
    expect(s3Mocks.s3Delete).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'old-bucket' }),
      'nd/k',
    );
  });

  it('falls back to the active destination for legacy rows and deleted destinations', async () => {
    const active = { ...dest, id: 2, bucket: 'new-bucket' };
    const db = createFakeDb({ findMany: { backupDestinations: [active] } });
    // destinationId 1 has no row anymore; a legacy row has no id at all.
    await fetchRemoteBackup(db, { remoteKey: 'nd/k', destinationId: 1 }, '/tmp/x');
    await fetchRemoteBackup(db, { remoteKey: 'nd/k' }, '/tmp/y');
    expect(s3Mocks.s3GetToFile).toHaveBeenNthCalledWith(1, expect.objectContaining({ bucket: 'new-bucket' }), 'nd/k', '/tmp/x');
    expect(s3Mocks.s3GetToFile).toHaveBeenNthCalledWith(2, expect.objectContaining({ bucket: 'new-bucket' }), 'nd/k', '/tmp/y');
  });

  it('deletes remote objects and swallows failures', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    await deleteRemoteBackup(db, { remoteKey: 'nd/k' });
    expect(s3Mocks.s3Delete).toHaveBeenCalled();
    s3Mocks.s3Delete.mockRejectedValueOnce(new Error('gone'));
    await expect(deleteRemoteBackup(db, { remoteKey: 'nd/k' })).resolves.toBeUndefined();
    await expect(deleteRemoteBackup(db, { remoteKey: null })).resolves.toBeUndefined();
  });

  it('refuses a fetch when no remote key is recorded', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    await expect(fetchRemoteBackup(db, { remoteKey: null }, '/tmp/x')).rejects.toThrow('No remote key');
  });

  it('skips the remote delete when no destination is configured', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [] } });
    await deleteRemoteBackup(db, { remoteKey: 'nd/k' });
    expect(s3Mocks.s3Delete).not.toHaveBeenCalled();
  });
});
