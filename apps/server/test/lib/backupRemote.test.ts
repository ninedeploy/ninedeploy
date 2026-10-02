import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import {
  activeDestination,
  deleteRemoteBackup,
  deleteRemoteBackupForRetention,
  fetchRemoteBackup,
  uploadBackup,
} from '../../src/lib/backupRemote.js';
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
  let fetchDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    fetchDir = mkdtempSync(path.join(os.tmpdir(), 'nd-fetch-'));
    // r645: the fetched object is checked for the backup envelope — model a
    // sealed object landing on disk.
    s3Mocks.s3GetToFile.mockImplementation(async (_cfg: unknown, _key: string, to: string) => {
      writeFileSync(to, 'NDBK1:v1:AAAAAAAAAAAAAAAA\nciphertext');
    });
  });
  afterEach(() => rmSync(fetchDir, { recursive: true, force: true }));

  it('streams the remote object straight to a local file', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    const target = path.join(fetchDir, 'fetch');
    const p = await fetchRemoteBackup(db, { remoteKey: 'nd/k' }, target);
    expect(p).toBe(target);
    // The GET pipes to disk (s3GetToFile) — multi-GB restores never buffer.
    expect(s3Mocks.s3GetToFile).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'b' }),
      'nd/k',
      target,
    );
    expect(existsSync(target)).toBe(true);
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
    const x = path.join(fetchDir, 'x');
    await fetchRemoteBackup(db, { remoteKey: 'nd/k', destinationId: 1 }, x);
    expect(s3Mocks.s3GetToFile).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'old-bucket' }),
      'nd/k',
      x,
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
    const x = path.join(fetchDir, 'x');
    const y = path.join(fetchDir, 'y');
    await fetchRemoteBackup(db, { remoteKey: 'nd/k', destinationId: 1 }, x);
    await fetchRemoteBackup(db, { remoteKey: 'nd/k' }, y);
    expect(s3Mocks.s3GetToFile).toHaveBeenNthCalledWith(1, expect.objectContaining({ bucket: 'new-bucket' }), 'nd/k', x);
    expect(s3Mocks.s3GetToFile).toHaveBeenNthCalledWith(2, expect.objectContaining({ bucket: 'new-bucket' }), 'nd/k', y);
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

describe('r542: deleteRemoteBackupForRetention', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes through the RECORDED destination and reports it', async () => {
    const old = { ...dest, id: 1, bucket: 'old-bucket', active: false };
    const now = { ...dest, id: 2, bucket: 'new-bucket', active: true };
    const db = createFakeDb({ findMany: { backupDestinations: [old, now] } });
    await expect(deleteRemoteBackupForRetention(db, { remoteKey: 'nd/k', destinationId: 1 })).resolves.toBe('deleted');
    expect(s3Mocks.s3Delete).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'old-bucket' }), 'nd/k');
  });

  it('never falls back to the active destination (a delete there would "succeed" on the wrong bucket)', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [{ ...dest, id: 2 }] } });
    await expect(deleteRemoteBackupForRetention(db, { remoteKey: 'nd/k', destinationId: 1 })).resolves.toBe(
      'unknown-destination',
    );
    await expect(deleteRemoteBackupForRetention(db, { remoteKey: 'nd/k', destinationId: null })).resolves.toBe(
      'unknown-destination',
    );
    expect(s3Mocks.s3Delete).not.toHaveBeenCalled();
  });

  it('surfaces an S3 failure instead of swallowing it, so the row is kept', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    s3Mocks.s3Delete.mockRejectedValueOnce(new Error('S3 delete failed (503)'));
    await expect(deleteRemoteBackupForRetention(db, { remoteKey: 'nd/k', destinationId: 1 })).rejects.toThrow('503');
  });

  it('treats a row without a remote key as nothing to delete', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    await expect(deleteRemoteBackupForRetention(db, { remoteKey: null })).resolves.toBe('deleted');
    expect(s3Mocks.s3Delete).not.toHaveBeenCalled();
  });
});

// r645: a remote object is fed to pg_restore / mysql / tar on restore. A
// plaintext object in the bucket used to be restored as "legacy" — anyone with
// bucket write access could have the panel run their SQL. Only rows that may
// genuinely predate the envelope keep restoring plaintext.
describe('fetchRemoteBackup refuses an unsealed object (r645)', () => {
  let dir: string;
  const at = (iso: string) => new Date(iso);
  const writeObject = (body: string) =>
    s3Mocks.s3GetToFile.mockImplementation(async (_cfg: unknown, _key: string, to: string) => { writeFileSync(to, body); });
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(path.join(os.tmpdir(), 'nd-seal-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a plaintext database dump and removes it from disk', async () => {
    writeObject('-- PostgreSQL database dump\nDROP TABLE users;');
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    const target = path.join(dir, 'gone.dump.remote');
    await expect(
      fetchRemoteBackup(db, { remoteKey: 'nd/gone.dump', destinationId: 1, scope: 'db', createdAt: at('2026-08-20T00:00:00Z') }, target),
    ).rejects.toThrow(/Refusing to restore the remote object 'nd\/gone.dump': it is not encrypted/);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a plaintext object for a volume snapshot that was uploaded sealed (destination stamped)', async () => {
    writeObject('plain tar bytes');
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    await expect(
      fetchRemoteBackup(db, { remoteKey: 'nd/v.tgz', destinationId: 1, scope: 'volumes', createdAt: at('2026-09-25T00:00:00Z') }, path.join(dir, 'v')),
    ).rejects.toThrow(/not encrypted/);
  });

  it('accepts both envelopes for any row', async () => {
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    writeObject('NDBK1:v2:AAAAAAAAAAAAAAAA\nsealed');
    await expect(fetchRemoteBackup(db, { remoteKey: 'k', scope: 'db' }, path.join(dir, 'a'))).resolves.toBeTruthy();
    writeObject('v1:base64envelope');
    await expect(fetchRemoteBackup(db, { remoteKey: 'k', scope: 'db' }, path.join(dir, 'b'))).resolves.toBeTruthy();
  });

  it('keeps restoring a legacy plaintext volume snapshot taken before this server stamped destinations', async () => {
    writeObject('legacy plain tar');
    const db = createFakeDb({
      findMany: { backupDestinations: [dest] },
      // The first destination-stamped upload on this server (it ran 0.10.3+ from then on).
      findFirst: { backups: { createdAt: at('2026-09-30T00:00:00Z') } },
    });
    await expect(
      fetchRemoteBackup(db, { remoteKey: 'nd/old.tgz', destinationId: null, scope: 'volumes', createdAt: at('2026-09-10T00:00:00Z') }, path.join(dir, 'old')),
    ).resolves.toBe(path.join(dir, 'old'));
    // No stamped row at all (the server never uploaded under 0.10.3+): still legacy.
    const fresh = createFakeDb({ findMany: { backupDestinations: [dest] } });
    await expect(
      fetchRemoteBackup(fresh, { remoteKey: 'nd/old.tgz', scope: 'volumes', createdAt: at('2026-10-01T00:00:00Z') }, path.join(dir, 'old2')),
    ).resolves.toBeTruthy();
  });

  it('refuses a plaintext volume object newer than the first stamped upload (its destination was deleted)', async () => {
    writeObject('plain tar');
    const db = createFakeDb({
      findMany: { backupDestinations: [dest] },
      findFirst: { backups: { createdAt: at('2026-09-20T00:00:00Z') } },
    });
    await expect(
      fetchRemoteBackup(db, { remoteKey: 'nd/new.tgz', destinationId: null, scope: 'volumes', createdAt: at('2026-09-28T00:00:00Z') }, path.join(dir, 'new')),
    ).rejects.toThrow(/not encrypted/);
  });

  it('fails closed for a ref that carries no provenance', async () => {
    writeObject('plain');
    const db = createFakeDb({ findMany: { backupDestinations: [dest] } });
    await expect(fetchRemoteBackup(db, { remoteKey: 'k' }, path.join(dir, 'c'))).rejects.toThrow(/not encrypted/);
  });
});
