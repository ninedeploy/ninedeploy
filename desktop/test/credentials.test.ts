import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Cipher, CredentialVault } from '../src/credentials.js';

/** A reversible stand-in for safeStorage that makes the sealed bytes visibly different. */
function fakeCipher(available = true): Cipher & { availableNow: boolean } {
  const cipher = {
    availableNow: available,
    available: () => cipher.availableNow,
    encrypt: (plain: string) => Buffer.from(`sealed:${Buffer.from(plain).toString('hex')}`),
    decrypt: (sealed: Buffer) => {
      const text = sealed.toString();
      if (!text.startsWith('sealed:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return Buffer.from(text.slice(7), 'hex').toString();
    },
  };
  return cipher;
}

const TOKEN = ['eyJhbGciOiJIUzI1NiJ9', 'payload', 'sig'].join('.');

describe('CredentialVault', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nd-vault-'));
    file = path.join(dir, 'credentials.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps one sealed token per instance; the plain token never reaches the disk', () => {
    const vault = new CredentialVault(file, fakeCipher());
    expect(vault.save('a', TOKEN)).toBe(true);
    expect(vault.save('b', `${TOKEN}-b`)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
    expect(vault.load('a')).toBe(TOKEN);
    expect(new CredentialVault(file, fakeCipher()).load('b')).toBe(`${TOKEN}-b`);
    vault.clear('a');
    expect(vault.load('a')).toBeNull();
    vault.clear('b');
    expect(existsSync(file)).toBe(false);
  });

  it('writes nothing without a real OS credential store', () => {
    const cipher = fakeCipher(false);
    const vault = new CredentialVault(file, cipher);
    expect(vault.canPersist()).toBe(false);
    expect(vault.save('a', TOKEN)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(vault.load('a')).toBeNull();
  });

  it('treats a throwing availability check as unavailable', () => {
    const vault = new CredentialVault(file, { ...fakeCipher(), available: () => { throw new Error('not ready'); } });
    expect(vault.save('a', TOKEN)).toBe(false);
  });

  it('drops a token sealed elsewhere instead of failing every launch', () => {
    const vault = new CredentialVault(file, fakeCipher());
    vault.save('a', TOKEN);
    const other = new CredentialVault(file, { ...fakeCipher(), decrypt: () => { throw new Error('wrong key'); } });
    expect(other.load('a')).toBeNull();
    expect(vault.load('a')).toBeNull();
  });

  it('refuses empty and oversized values', () => {
    const vault = new CredentialVault(file, fakeCipher());
    expect(vault.save('a', '')).toBe(false);
    expect(vault.save('a', 'x'.repeat(9000))).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});
