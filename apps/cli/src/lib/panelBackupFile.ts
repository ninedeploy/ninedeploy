import { createDecipheriv, scrypt as scryptCb } from 'node:crypto';
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Offline reader for a sealed panel backup (`.ndpb`, format NDPB1) — the
 * restore path that needs no running panel. Kept to node builtins only: it is
 * the CLI twin of `decryptPanelBackupFile` in apps/server/src/lib/panelBackup.ts,
 * and the server's tests open real server-written backups with this reader.
 *
 * Layout: "NDPB1:scrypt:<N>:<r>:<p>:<b64 salt>:<b64 iv>\n", AES-256-GCM
 * ciphertext, 16-byte GCM tag. The header line is the GCM AAD; the key is
 * scrypt(passphrase, salt, 32 bytes, N, r, p).
 */
const HEADER_RE = /^NDPB1:scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)\n$/;
const TAG_BYTES = 16;

export const PANEL_BACKUP_DECRYPT_ERROR =
  'Could not decrypt the panel backup: the recovery passphrase is wrong, or the file is damaged';

export async function decryptPanelBackup(input: string, output: string, passphrase: string): Promise<void> {
  const handle = await open(input, 'r');
  let header = '';
  const tag = Buffer.alloc(TAG_BYTES);
  let size: number;
  try {
    size = (await handle.stat()).size;
    const prefix = Buffer.alloc(Math.min(256, size));
    await handle.read(prefix, 0, prefix.length, 0);
    const nl = prefix.indexOf(0x0a);
    if (nl >= 0) header = prefix.subarray(0, nl + 1).toString('utf8');
    if (size >= TAG_BYTES) await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const m = HEADER_RE.exec(header);
  if (!m) throw new Error('Not a NineDeploy panel backup (missing NDPB1 header)');
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!(N >= 1 << 14 && N <= 1 << 20 && (N & (N - 1)) === 0) || r < 1 || r > 32 || p < 1 || p > 16) {
    throw new Error('Unsupported panel backup key-derivation parameters');
  }
  const salt = Buffer.from(m[4]!, 'base64');
  const iv = Buffer.from(m[5]!, 'base64');
  const headerBytes = Buffer.byteLength(header);
  if (iv.length !== 12 || salt.length < 16 || size < headerBytes + TAG_BYTES) throw new Error(PANEL_BACKUP_DECRYPT_ERROR);
  const key = await new Promise<Buffer>((resolve, reject) =>
    scryptCb(passphrase, salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, k) => (err ? reject(err) : resolve(k))),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(header));
  decipher.setAuthTag(tag);
  const dataEnd = size - TAG_BYTES - 1;
  try {
    const source = dataEnd < headerBytes ? Readable.from([]) : createReadStream(input, { start: headerBytes, end: dataEnd });
    await pipeline(source, decipher, createWriteStream(output, { mode: 0o600 }));
  } catch {
    // Nothing unauthenticated may be left behind for someone to import.
    try { unlinkSync(output); } catch { /* absent */ }
    throw new Error(PANEL_BACKUP_DECRYPT_ERROR);
  }
}
