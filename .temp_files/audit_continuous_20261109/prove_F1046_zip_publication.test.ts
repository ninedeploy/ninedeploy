import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ paths: { dataDir: '' }, fail: false }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: state.paths } }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (state.fail && String(args[0]).endsWith('.zip')) { fs.writeFileSync(args[0], 'PARTIAL'); throw Object.assign(new Error('fixture partial ZIP write'), { code: 'ENOSPC' }); }
    return fs.writeFileSync(...args);
  } };
});
import { listSourceUploads, storeSourceUpload } from '../../apps/server/src/lib/sourceUpload.js';
function zip() {
  const name = Buffer.from('Dockerfile'), data = Buffer.from('FROM nginx\n');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, cd, name, end]);
}
it('preserves accepted ZIP bytes after a failed same-content reupload', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-zip-publication-')); state.paths.dataDir = root;
  try {
    const archive = zip(), stored = await storeSourceUpload(1, archive);
    const final = path.join(root, 'uploads', '1', `${stored.sha}.zip`);
    expect(readFileSync(final)).toEqual(archive);
    console.log('CONTROL EXPECTED: complete valid ZIP accepted | ACTUAL:', readFileSync(final).length);
    state.fail = true;
    await expect(storeSourceUpload(1, archive)).rejects.toMatchObject({ code: 'ENOSPC' });
    const actual = readFileSync(final);
    console.log('EXPECTED: prior complete ZIP preserved | ACTUAL:', { expectedBytes: archive.length, actualBytes: actual.length, listedBytes: listSourceUploads(1)[0]?.bytes });
    console.log(actual.equals(archive) ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(actual).toEqual(archive);
  } finally { state.fail = false; rmSync(root, { recursive: true, force: true }); }
});
