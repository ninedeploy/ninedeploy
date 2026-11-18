import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashCheckpointFile, packCheckpoint, unpackCheckpoint, validateCheckpoint, type CheckpointManifest } from '../../src/engine/pitrCheckpoint.js';
import { encryptPanelBackupFile, decryptPanelBackupFile } from '../../src/lib/panelBackup.js';

let dir: string;
let manifest: CheckpointManifest;
let files: string[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nd-checkpoint-'));
  files = [];
  const names = ['base/nd-20261117T090000000Z/base.tar.gz', 'base/nd-20261117T090000000Z/backup_manifest', 'wal/000000010000000000000003.00000028.backup.gz', 'wal/000000010000000000000003.gz', 'wal/000000010000000000000004.gz'];
  const entries = [];
  for (const [i, name] of names.entries()) {
    const data = Buffer.from(i === 1 ? '{"Files":[]}' : `fixture-${i}`);
    const file = path.join(dir, `f${i}`); await writeFile(file, data); files.push(file);
    entries.push({ name, size: data.length, sha256: await hashCheckpointFile(file) });
  }
  manifest = {
    format: 'NDPITR1', createdAt: '2026-11-17T09:03:00.000Z', source: { slug: 'main', version: '18', username: 'nine', dbName: 'app' },
    base: { label: 'nd-20261117T090000000Z', startSegment: '000000010000000000000003', historyFile: '000000010000000000000003.00000028.backup', timeline: 1, startedAt: '2026-11-17T09:00:00.000Z', finishedAt: '2026-11-17T09:01:00.000Z', sizeBytes: 9 },
    segments: [{ name: '000000010000000000000003', archivedAt: '2026-11-17T09:01:00.000Z', sizeBytes: 9 }, { name: '000000010000000000000004', archivedAt: '2026-11-17T09:02:00.000Z', sizeBytes: 9 }], files: entries,
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('portable checkpoint integrity', () => {
  it('round-trips every byte through the operator passphrase without the old master key', async () => {
    const plain = path.join(dir, 'plain'), sealed = path.join(dir, 'sealed'), opened = path.join(dir, 'opened');
    await packCheckpoint(manifest, files, plain);
    await encryptPanelBackupFile(plain, sealed, 'an operator held passphrase');
    expect((await readFile(sealed)).includes(Buffer.from('fixture-'))).toBe(false);
    await decryptPanelBackupFile(sealed, opened, 'an operator held passphrase');
    const unpacked = await unpackCheckpoint(opened, path.join(dir, 'out'));
    expect(unpacked.manifest).toEqual(manifest);
    for (const [i, file] of unpacked.files.entries()) expect(await readFile(file)).toEqual(await readFile(files[i]!));
  });
  it.each(['wrong passphrase', 'damaged ciphertext'])('refuses %s without plaintext output', async (fault) => {
    const plain = path.join(dir, 'plain'), sealed = path.join(dir, 'sealed'), output = path.join(dir, 'output');
    await packCheckpoint(manifest, files, plain); await encryptPanelBackupFile(plain, sealed, 'an operator held passphrase');
    if (fault === 'damaged ciphertext') { const b = await readFile(sealed); b[b.length - 20] = b[b.length - 20]! ^ 1; await writeFile(sealed, b); }
    await expect(decryptPanelBackupFile(sealed, output, fault === 'wrong passphrase' ? 'wrong passphrase' : 'an operator held passphrase')).rejects.toThrow(/wrong|damaged/);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['truncated', 'trailing data', 'damaged file', 'oversized header'])('refuses a %s bundle', async (fault) => {
    const plain = path.join(dir, 'plain'); await packCheckpoint(manifest, files, plain);
    let b = await readFile(plain);
    if (fault === 'truncated') b = b.subarray(0, b.length - 1);
    if (fault === 'trailing data') b = Buffer.concat([b, Buffer.from('x')]);
    if (fault === 'damaged file') b[b.length - 1] = b[b.length - 1]! ^ 1;
    if (fault === 'oversized header') b.writeUInt32BE(0xffffffff, 8);
    await writeFile(plain, b);
    await expect(unpackCheckpoint(plain, path.join(dir, 'out'))).rejects.toThrow(/truncated|trailing|integrity|length/);
  });
  it.each(['../master.key', '/etc/passwd', 'base/x/link', 'wal/extra.gz'])('refuses unlisted archive path %s', (name) => {
    manifest.files[0]!.name = name;
    expect(() => validateCheckpoint(manifest)).toThrow(/file list/);
  });
  it('refuses missing WAL even when the file list and hashes are otherwise consistent', () => {
    manifest.segments[1]!.name = '000000010000000000000005';
    manifest.files[4]!.name = 'wal/000000010000000000000005.gz';
    expect(() => validateCheckpoint(manifest)).toThrow(/Segment .* is missing/);
  });
  it('refuses a changed source copy instead of sealing a mismatched manifest', async () => {
    await writeFile(files[0]!, 'different');
    await expect(packCheckpoint(manifest, files, path.join(dir, 'plain'))).rejects.toThrow(/changed/);
  });
  it.each(['Path', 'Encoded-Path'])('refuses tablespace references in an authenticated checkpoint manifest (%s)', async (field) => {
    const name = 'pg_tblspc/16384/PG_18_202506291/5/16385';
    const data = Buffer.from(JSON.stringify({ Files: [{ [field]: field === 'Path' ? name : Buffer.from(name).toString('hex') }] }));
    await writeFile(files[1]!, data);
    manifest.files[1]!.size = data.length; manifest.files[1]!.sha256 = await hashCheckpointFile(files[1]!);
    const plain = path.join(dir, 'plain'); await packCheckpoint(manifest, files, plain);
    await expect(unpackCheckpoint(plain, path.join(dir, 'out'))).rejects.toThrow(/tablespace/);
  });
});
