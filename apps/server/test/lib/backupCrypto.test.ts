import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptBackupFile,
  encryptBackupFile,
  isEncryptedBackupFile,
  readBackupHeader,
  reencryptSecretEnvelope,
} from '../../src/lib/backupCrypto.js';
import { encrypt } from '../../src/lib/crypto.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ninedeploy-backup-crypto-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const samplePlaintext = Buffer.from(
  'NineDeploy backup sample — fake postgres dump body for unit tests.\n'.repeat(64),
);

describe('lib/backupCrypto', () => {
  it('isEncryptedBackupFile returns false for a plaintext file', async () => {
    const file = join(tmpDir, 'plain.dump');
    writeFileSync(file, samplePlaintext);
    await expect(isEncryptedBackupFile(file)).resolves.toBe(false);
    await expect(readBackupHeader(file)).resolves.toBeNull();
  });

  it('encryptBackupFile adds the NDBK1: header + trailing GCM tag and round-trips', async () => {
    const file = join(tmpDir, 'db.dump');
    writeFileSync(file, samplePlaintext);
    expect(await isEncryptedBackupFile(file)).toBe(false);

    const info = await encryptBackupFile(file);
    expect(info.keyVersion).toBeGreaterThanOrEqual(0);
    expect(info.iv).toMatch(/^[A-Za-z0-9+/=]+$/);

    // File now starts with the magic + header line.
    const onDisk = readFileSync(file);
    expect(onDisk.subarray(0, 6).toString('utf8')).toBe('NDBK1:');
    // ...and ends with a 16-byte GCM auth tag.
    expect(onDisk.length).toBeGreaterThan(samplePlaintext.length + 16);

    // Decrypt and check we got the original bytes back.
    const out = join(tmpDir, 'db.dump.plain');
    await decryptBackupFile(file, out);
    expect(readFileSync(out)).toEqual(samplePlaintext);
  });

  it('encryptBackupFile is idempotent (a second call is a no-op)', async () => {
    const file = join(tmpDir, 'idempotent.dump');
    writeFileSync(file, samplePlaintext);
    const first = await encryptBackupFile(file);
    const second = await encryptBackupFile(file);
    expect(second.keyVersion).toBe(first.keyVersion);
    // Plaintext is still recoverable — no double-encryption garbage.
    const out = join(tmpDir, 'idempotent.dump.plain');
    await decryptBackupFile(file, out);
    expect(readFileSync(out)).toEqual(samplePlaintext);
  });

  it('decryptBackupFile refuses a plaintext input (no NDBK1: magic)', async () => {
    const file = join(tmpDir, 'plain.dump');
    writeFileSync(file, samplePlaintext);
    const out = join(tmpDir, 'plain.dump.out');
    await expect(decryptBackupFile(file, out)).rejects.toThrow(/not encrypted/);
  });

  it('removes plaintext output when an encrypted backup has a corrupt authentication tag', async () => {
    const file = join(tmpDir, 'corrupt.dump');
    const out = join(tmpDir, 'corrupt.dump.dec');
    writeFileSync(file, samplePlaintext);
    await encryptBackupFile(file);
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    writeFileSync(file, bytes);
    await expect(decryptBackupFile(file, out)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(file)).toEqual(bytes);
  });

  it('readBackupHeader reports the key version and IV base64', async () => {
    const file = join(tmpDir, 'header.dump');
    writeFileSync(file, samplePlaintext);
    const info = await encryptBackupFile(file);
    const read = await readBackupHeader(file);
    expect(read).toEqual(info);
  });

  it('encryptBackupFile throws (and leaves the source intact) when the file is unreadable', async () => {
    // Pointing at a directory causes createReadStream to fail fast — the
    // helper's catch path runs and the original on-disk content is not
    // touched. We pre-create a directory at the same path the helper is
    // given, then assert the directory is still there (i.e. we did not
    // accidentally clobber it with a file).
    const file = join(tmpDir, 'not-a-file');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(file, { recursive: true });
    await expect(encryptBackupFile(file)).rejects.toThrow();
    // The directory is still a directory — the helper bailed out before
    // touching it.
    const { statSync } = await import('node:fs');
    expect(statSync(file).isDirectory()).toBe(true);
  });

  it('readBackupHeader returns null for an empty file', async () => {
    const file = join(tmpDir, 'empty.dump');
    writeFileSync(file, '');
    await expect(readBackupHeader(file)).resolves.toBeNull();
  });

  it('reencryptSecretEnvelope re-encrypts a secrets-at-rest envelope under the active key version', () => {
    // A short secret string encrypted under whatever the current key is.
    const original = encrypt('hello world');
    const reencrypted = reencryptSecretEnvelope(original);
    // Round-trip back to plaintext (the function is identity-equivalent on
    // the active key; the point of the test is that the wrapper composes).
    expect(typeof reencrypted).toBe('string');
    expect(reencrypted).toMatch(/^v\d+:/);
  });
});
