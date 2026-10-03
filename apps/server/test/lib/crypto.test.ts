import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from '../../src/lib/crypto.js';

const KEY_HEX = 'a'.repeat(64); // 32 bytes

describe('crypto primitives', () => {
  beforeEach(() => {
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', KEY_HEX);
  });

  it('sha256 produces the expected digest', () => {
    const expected = createHash('sha256').update('hello').digest('hex');
    expect(crypto.sha256('hello')).toBe(expected);
    expect(crypto.sha256('hello')).not.toBe(crypto.sha256('world'));
  });

  it('randomToken produces URL-safe tokens of the requested length', () => {
    expect(crypto.randomToken()).toHaveLength(43); // 32 bytes → base64url
    expect(crypto.randomToken(16)).toHaveLength(22);
    expect(crypto.randomToken()).not.toBe(crypto.randomToken());
    expect(crypto.randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashPassword/verifyPassword roundtrip succeeds for the right password', async () => {
    const hash = await crypto.hashPassword('s3cret-pass');
    expect(hash).not.toContain('s3cret-pass');
    await expect(crypto.verifyPassword(hash, 's3cret-pass')).resolves.toBe(true);
  });

  it('verifyPassword returns false for a wrong password', async () => {
    const hash = await crypto.hashPassword('right');
    await expect(crypto.verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });

  it('verifyPassword returns false for a malformed hash', async () => {
    await expect(crypto.verifyPassword('not-a-valid-argon2-hash', 'x')).resolves.toBe(false);
  });
});

describe('encrypt/decrypt with an env master key', () => {
  beforeEach(() => {
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', KEY_HEX);
  });

  it('roundtrips plaintext in a versioned envelope', () => {
    const ct = crypto.encrypt('my secret value');
    expect(ct.startsWith('v0:')).toBe(true);
    expect(ct.slice(3).split(':')).toHaveLength(3); // iv:tag:ciphertext after the version
    expect(crypto.decrypt(ct)).toBe('my secret value');
  });

  it('produces unique ciphertext per call (random IV)', () => {
    const a = crypto.encrypt('same');
    const b = crypto.encrypt('same');
    expect(a).not.toBe(b);
    expect(crypto.decrypt(a)).toBe(crypto.decrypt(b));
  });

  it('decrypt rejects tampered payloads', () => {
    const ct = crypto.encrypt('data'); // v0:iv:tag:ct
    const parts = ct.split(':');
    const tampered = [parts[0], parts[1], 'AAAAAAAAAAAAAAAAAAAAAA==', parts[3]].join(':'); // flip the auth tag
    expect(() => crypto.decrypt(tampered)).toThrow();
  });

  it('decrypt rejects a malformed payload', () => {
    expect(() => crypto.decrypt('not-a-valid-payload')).toThrow();
  });

  it('roundtrips backup bytes through the streaming AES-GCM primitives', async () => {
    const { cipher, header } = crypto.createBackupCipher();
    const encrypted: Buffer[] = [];
    cipher.end(Buffer.from('large-backup-chunk'));
    for await (const chunk of cipher) encrypted.push(Buffer.from(chunk));
    const decipher = crypto.createBackupDecipher(header.toString(), cipher.getAuthTag());
    const plain: Buffer[] = [];
    decipher.end(Buffer.concat(encrypted));
    for await (const chunk of decipher) plain.push(Buffer.from(chunk));
    expect(Buffer.concat(plain).toString()).toBe('large-backup-chunk');
  });
});

describe('master key resolution from the key file', () => {
  const tmp = fsTempDir();
  const freshDir = path.join(tmp, 'fresh');
  const existingDir = path.join(tmp, 'existing');
  const existingKey = randomBytes(32).toString('hex');

  beforeAll(() => {
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(path.join(existingDir, 'master.key'), existingKey, { mode: 0o600 });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('creates and persists a master key file when none exists', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', '');
    vi.stubEnv('NINEDEPLOY_DATA_DIR', freshDir);
    const mod = await import('../../src/lib/crypto.js');
    const ct = mod.encrypt('hello');
    expect(mod.decrypt(ct)).toBe('hello');
    const keyFile = path.join(freshDir, 'master.key');
    expect(existsSync(keyFile)).toBe(true);
    expect(readFileSync(keyFile, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads an existing master key file', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', '');
    vi.stubEnv('NINEDEPLOY_DATA_DIR', existingDir);
    const mod = await import('../../src/lib/crypto.js');
    const ct = mod.encrypt('from-file');
    expect(mod.decrypt(ct)).toBe('from-file');
  });

  it('throws when the env master key is not 32 bytes', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'aabb'); // 2 bytes
    vi.stubEnv('NINEDEPLOY_DATA_DIR', freshDir);
    const mod = await import('../../src/lib/crypto.js');
    expect(() => mod.encrypt('x')).toThrow('must decode to 32 bytes');
  });
});

describe('key rotation (versioned key ring)', () => {
  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('encrypts with the highest-version key as active', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A},1:${KEY_B}`);
    const mod = await import('../../src/lib/crypto.js');
    const ct = mod.encrypt('rotated');
    expect(ct.startsWith('v1:')).toBe(true);
    expect(mod.decrypt(ct)).toBe('rotated');
  });

  it('decrypts a legacy un-versioned envelope with the active key', () => {
    vi.stubEnv('NINEDEPLOY_MASTER_KEY', KEY_A);
    const ct = crypto.encrypt('legacy'); // v0:iv:tag:ct
    const legacy = ct.slice('v0:'.length); // strip the version → iv:tag:ct
    expect(crypto.decrypt(legacy)).toBe('legacy');
  });

  it('decrypts a legacy envelope with the ORIGINAL key after rotation (active is now newer)', async () => {
    // Seal a value under the original single key (becomes legacy iv:tag:ct).
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A}`);
    const mod0 = await import('../../src/lib/crypto.js');
    const legacy = mod0.encrypt('pre-rotation-secret').slice('v0:'.length); // strip prefix

    // Rotate: add key 1 (now active). Legacy secret must still decrypt with key 0.
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A},1:${KEY_B}`);
    const mod1 = await import('../../src/lib/crypto.js');
    expect(mod1.decrypt(legacy)).toBe('pre-rotation-secret');
    // And reencrypt migrates it onto the active key.
    expect(mod1.reencrypt(legacy).startsWith('v1:')).toBe(true);
  });

  it('still decrypts old-version ciphertext after a new key is added', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A}`);
    const mod0 = await import('../../src/lib/crypto.js');
    const v0ct = mod0.encrypt('old-secret');
    expect(v0ct.startsWith('v0:')).toBe(true);

    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A},1:${KEY_B}`); // key 1 now active
    const mod1 = await import('../../src/lib/crypto.js');
    expect(mod1.decrypt(v0ct)).toBe('old-secret'); // old key version still readable
  });

  it('reencrypt migrates an old-version value onto the active key (and is a no-op when current)', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A}`);
    const mod0 = await import('../../src/lib/crypto.js');
    const v0ct = mod0.encrypt('migrate-me');

    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A},1:${KEY_B}`);
    const mod1 = await import('../../src/lib/crypto.js');
    const migrated = mod1.reencrypt(v0ct);
    expect(migrated.startsWith('v1:')).toBe(true);
    expect(mod1.decrypt(migrated)).toBe('migrate-me');
    // Already on the active version → unchanged.
    expect(mod1.reencrypt(migrated)).toBe(migrated);
  });

  it('rejects a multi-key entry that is not 32 bytes', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', '0:aabb');
    const mod = await import('../../src/lib/crypto.js');
    expect(() => mod.encrypt('x')).toThrow('must decode to 32 bytes');
  });

  it('skips malformed (colon-less) entries in the multi-key list', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A},garbage-entry`);
    const mod = await import('../../src/lib/crypto.js');
    expect(mod.decrypt(mod.encrypt('ok'))).toBe('ok'); // key 0 still parsed
  });

  it('rejects a multi-key list with no valid entries', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', 'garbage1,garbage2');
    const mod = await import('../../src/lib/crypto.js');
    expect(() => mod.encrypt('x')).toThrow('contained no valid keys');
  });

  it('throws on an unknown key version instead of silently falling back', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${KEY_A},1:${KEY_B}`);
    const mod = await import('../../src/lib/crypto.js');
    // Active is v1; relabel an active ciphertext as an unknown v9 version.
    const forged = mod.encrypt('fallback').replace(/^v1:/, 'v9:');
    expect(() => mod.decrypt(forged)).toThrow('Unknown master key version 9');
  });

  it('falls back to the active key for a legacy envelope when version 0 is absent from the ring', async () => {
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `1:${KEY_A}`); // no version 0 declared
    const mod = await import('../../src/lib/crypto.js');
    const legacy = mod.encrypt('legacy-no-v0').slice('v1:'.length); // strip prefix
    expect(mod.decrypt(legacy)).toBe('legacy-no-v0');
  });
});

function fsTempDir(): string {
  const dir = path.join(os.tmpdir(), `ninedeploy-crypto-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
