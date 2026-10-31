import { readFileSync, rmSync } from 'node:fs';
import { writeFileAtomic } from './instances.js';

/**
 * The OS credential store, as Electron's safeStorage exposes it: DPAPI on
 * Windows, the Keychain on macOS, libsecret/KWallet on Linux.
 */
export interface Cipher {
  /** False when only an obfuscating fallback exists (Linux without a keyring). */
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(sealed: Buffer): string;
}

/** A panel refresh token is a JWT of a few hundred bytes; anything far larger is not one. */
const MAX_TOKEN_LENGTH = 8192;

/**
 * One sealed refresh token per instance. Without a real OS store nothing is
 * written: the sign-in then lasts for the window, like a browser tab, rather
 * than sitting on disk under a key anyone with the file could reproduce.
 */
export class CredentialVault {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  canPersist(): boolean {
    try {
      return this.cipher.available();
    } catch {
      return false;
    }
  }

  save(instanceId: string, token: string): boolean {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
    if (!this.canPersist()) return false;
    const all = this.read();
    all[instanceId] = this.cipher.encrypt(token).toString('base64');
    this.write(all);
    return true;
  }

  load(instanceId: string): string | null {
    const sealed = this.read()[instanceId];
    if (!sealed || !this.canPersist()) return null;
    try {
      return this.cipher.decrypt(Buffer.from(sealed, 'base64'));
    } catch {
      // Sealed under another OS account or a reset keyring: unusable, so drop it.
      this.clear(instanceId);
      return null;
    }
  }

  clear(instanceId: string): void {
    const all = this.read();
    if (!(instanceId in all)) return;
    delete all[instanceId];
    this.write(all);
  }

  private read(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  }

  private write(all: Record<string, string>): void {
    if (Object.keys(all).length === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    writeFileAtomic(this.file, `${JSON.stringify(all)}\n`);
  }
}
