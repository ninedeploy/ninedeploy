/**
 * An encrypted backup of an empty dump (header + GCM tag, no data) reads back
 * as an empty stream, and its tag is still checked. createReadStream refused
 * end < start, so restoring or downloading such a backup threw a RangeError.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

const { createBackupReadStream } = await import('../src/engine/database.js');
const { createBackupCipher } = await import('../src/lib/crypto.js');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function emptyBackup(tamper = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nd-empty-backup-'));
  dirs.push(dir);
  const { cipher, header } = createBackupCipher();
  const body = cipher.final();
  const tag = cipher.getAuthTag();
  if (tamper) tag[0] = tag[0]! ^ 0xff;
  const file = path.join(dir, 'empty.dump.enc');
  writeFileSync(file, Buffer.concat([header, body, tag]));
  return file;
}

async function readAll(file: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await createBackupReadStream(file)) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('an empty encrypted backup', () => {
  it('reads back as no bytes', async () => {
    expect((await readAll(emptyBackup())).length).toBe(0);
  });

  it('still fails when its tag was tampered with', async () => {
    await expect(readAll(emptyBackup(true))).rejects.toThrow();
  });
});
