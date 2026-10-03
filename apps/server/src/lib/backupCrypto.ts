import { createReadStream, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBackupCipher, createBackupDecipher, reencrypt as reencryptSecret } from './crypto.js';

/**
 * Backup crypto public surface — Sprint 3, Gap G-13 (PR-A).
 *
 * The streaming AES-GCM envelope itself lives in `lib/crypto.ts`
 * (`createBackupCipher` / `createBackupDecipher`). This module is the
 * single public entry point the CLI, the future `ninedeploy backups
 * encrypt <id>` command, and any plugin that needs to inspect or
 * re-encrypt a backup file should reach for.
 *
 * Why a thin wrapper instead of touching `lib/crypto.ts`:
 *   - `lib/crypto.ts` is also the secrets-at-rest module. Mixing the
 *     backup file format in there was fine when only `engine/database.ts`
 *     used it; growing the surface there is what made this PR hard to
 *     land on Sprint 2. Keeping the public surface in its own file
 *     pins the dependency graph the right way.
 *   - The header format (`NDBK1:v<version>:<base64-iv>\n` + trailing
 *     16-byte GCM tag) is a contract this file owns end to end. If we
 *     ever need a v2 envelope, only `lib/backupCrypto.ts` and the
 *     private helpers in `lib/crypto.ts` change.
 *
 * The on-disk layout is identical to what `engine/database.ts` already
 * writes, so a file encrypted by the existing path round-trips through
 * these helpers without re-encoding.
 */

const STREAM_HEADER_RE = /^NDBK1:v(\d+):([A-Za-z0-9+/=]+)\n$/;
const GCM_TAG_BYTES = 16;

/** Public view of the file's encryption header. `null` means "plaintext / not
 *  an encrypted backup" (legacy dump or volume-scope tarball). */
export interface BackupEncryptionInfo {
  /** Master-key version the file is sealed under. */
  keyVersion: number;
  /** Base64 IV carried in the header. Useful for diagnostics and tests. */
  iv: string;
}

/**
 * Read just the on-disk header of an encrypted backup and return the key
 * version + IV. Returns `null` when the file does not start with the
 * `NDBK1:` magic — that means it is a legacy plaintext dump or a
 * volume-scope tarball, and the caller should skip crypto entirely.
 */
export async function readBackupHeader(file: string): Promise<BackupEncryptionInfo | null> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return null;
    // 128 bytes is comfortably more than the largest possible header
    // (`NDBK1:` + `v<digits>:` + base64(12) + `\n` ≈ 50 bytes).
    const prefix = Buffer.alloc(Math.min(128, stat.size));
    await handle.read(prefix, 0, prefix.length, 0);
    const newline = prefix.indexOf(0x0a);
    if (newline < 0) return null;
    const header = prefix.subarray(0, newline + 1).toString('utf8');
    const match = STREAM_HEADER_RE.exec(header);
    if (!match) return null;
    return { keyVersion: Number(match[1]), iv: match[2]! };
  } finally {
    await handle.close();
  }
}

/** True when the file carries an `NDBK1:` encryption header. */
export async function isEncryptedBackupFile(file: string): Promise<boolean> {
  return (await readBackupHeader(file)) !== null;
}

/**
 * Encrypt a backup file in place under the active master key. The file is
 * rewritten atomically (`<file>.<pid>.<ts>.enc` → `renameSync`) so a crash
 * mid-encryption cannot leave a half-encrypted file on disk.
 *
 * If the file already starts with the encryption header, this is a no-op
 * — calling it twice is safe.
 */
export async function encryptBackupFile(file: string): Promise<BackupEncryptionInfo> {
  if (await isEncryptedBackupFile(file)) {
    // Already encrypted; surface the existing key version so callers can
    // decide whether a re-encrypt is in order.
    return (await readBackupHeader(file))!;
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.enc`;
  const { cipher, header } = createBackupCipher();
  const output = createWriteStream(tmp, { mode: 0o600 });
  let headerWritten = false;
  // Buffer the first chunk just long enough to splice the header in front;
  // the GCM tag goes on the very end.
  const envelope = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: (err: Error | null, data?: Buffer) => void) {
      if (!headerWritten) {
        this.push(header);
        headerWritten = true;
      }
      callback(null, chunk);
    },
    flush(callback: (err?: Error | null) => void) {
      if (!headerWritten) this.push(header);
      this.push(cipher.getAuthTag());
      callback();
    },
  });
  try {
    await pipeline(createReadStream(file), cipher, envelope, output);
    renameSync(tmp, file);
  } catch (error) {
    output.destroy();
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return (await readBackupHeader(file))!;
}

/**
 * Decrypt an encrypted backup file to `outputPath`. Refuses plaintext
 * files (no `NDBK1:` header) rather than silently writing garbage — the
 * caller almost certainly pointed at the wrong file.
 */
export async function decryptBackupFile(file: string, outputPath: string): Promise<void> {
  const info = await readBackupHeader(file);
  if (!info) {
    throw new Error('Backup file is not encrypted; refusing to decrypt plaintext');
  }
  // Read the trailing 16-byte GCM tag.
  const handle = await open(file, 'r');
  let header: string;
  let authTag: Buffer;
  let dataStart: number;
  let dataEnd: number;
  try {
    const stat = await handle.stat();
    authTag = Buffer.alloc(GCM_TAG_BYTES);
    await handle.read(authTag, 0, GCM_TAG_BYTES, stat.size - GCM_TAG_BYTES);
    // Re-derive the header line: it is the prefix up to and including the
    // first `\n` (i.e. `NDBK1:v<version>:<iv>\n`).
    const prefix = Buffer.alloc(Math.min(128, stat.size));
    await handle.read(prefix, 0, prefix.length, 0);
    const newline = prefix.indexOf(0x0a);
    header = prefix.subarray(0, newline + 1).toString('utf8');
    dataStart = newline + 1;
    dataEnd = stat.size - GCM_TAG_BYTES - 1;
  } finally {
    await handle.close();
  }
  const decipher = createBackupDecipher(header, authTag);
  const output = createWriteStream(outputPath, { mode: 0o600 });
  try {
    await pipeline(createReadStream(file, { start: dataStart, end: dataEnd }), decipher, output);
  } catch (error) {
    // Authentication is checked at the end of the stream; discard any
    // plaintext emitted before a corrupt tag or write failure was detected.
    try { unlinkSync(outputPath); } catch { /* absent or inaccessible */ }
    throw error;
  }
}

/**
 * Re-encrypt every secret-shaped envelope (DB credential blobs, etc.) under
 * the active master-key version. Backups themselves stay where they are
 * — they are already on the active key for new writes, and legacy
 * plaintext backups keep working because `readBackupHeader()` returns
 * `null` and the callers (downloads) hand the bytes through unchanged.
 *
 * This is a thin convenience wrapper around the existing `reencrypt()`
 * helper; it exists so CLI commands can advertise "re-encrypt secrets"
 * without reaching into `lib/crypto.ts` directly.
 */
export function reencryptSecretEnvelope(payload: string): string {
  return reencryptSecret(payload);
}
