import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ paths: { dataDir: '' }, fault: '' }));
vi.mock('../src/config.js', () => ({ config: { paths: state.paths } }));
vi.mock('../src/lib/exec.js', () => ({ capture: async () => '' }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (state.fault === 'rename' && path.basename(String(args[0])).startsWith('.pending-')) throw Object.assign(new Error('fixture publication denied'), { code: 'EACCES' });
      return fs.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (state.fault === 'write' && (path.basename(String(args[0])).startsWith('.pending-') || String(args[0]).endsWith('.zip'))) {
        fs.writeFileSync(args[0], 'PARTIAL');
        throw Object.assign(new Error('fixture partial write'), { code: 'ENOSPC' });
      }
      return fs.writeFileSync(...args);
    },
  };
});

import { listSourceUploads, storeSourceUpload } from '../src/lib/sourceUpload.js';

/** One stored, checksummed ZIP member; no external archive dependency. */
function zipArchive(): Buffer {
  const name = Buffer.from('Dockerfile'), data = Buffer.from('FROM nginx\n');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, cd, name, end]);
}

it.each([false, true])('F1046: failed ZIP write preserves accepted history (previous archive: %s)', async previous => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-zip-publish-'));
  state.paths.dataDir = root; state.fault = '';
  try {
    const archive = zipArchive();
    const stored = previous ? await storeSourceUpload(1, archive) : null;
    const before = listSourceUploads(1), dir = path.join(root, 'uploads', '1');
    state.fault = 'write';
    await expect(storeSourceUpload(1, archive)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(listSourceUploads(1)).toEqual(before);
    expect(readdirSync(dir)).toEqual(stored ? [`${stored.sha}.zip`] : []);
    if (stored) expect(readFileSync(path.join(dir, `${stored.sha}.zip`))).toEqual(archive);
    state.fault = '';
    await expect(storeSourceUpload(1, archive)).resolves.toMatchObject({ format: 'zip', bytes: archive.length });
    expect(listSourceUploads(1)).toHaveLength(1);
  } finally { state.fault = ''; rmSync(root, { recursive: true, force: true }); }
});
it.each(['rename', 'write'])('F1045: cleans pending %s failures and preserves the published archive', async fault => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-upload-publication-'));
  state.paths.dataDir = root; state.fault = '';
  try {
    const archive = gzipSync(Buffer.alloc(1024));
    const stored = await storeSourceUpload(1, archive);
    const dir = path.join(root, 'uploads', '1'), final = `${stored.sha}.tar.gz`;
    const before = listSourceUploads(1);
    state.fault = fault;
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(storeSourceUpload(1, archive)).rejects.toMatchObject({ code: fault === 'rename' ? 'EACCES' : 'ENOSPC' });
      expect(readdirSync(dir)).toEqual([final]);
      expect(readFileSync(path.join(dir, final))).toEqual(archive);
      expect(listSourceUploads(1)).toEqual(before);
    }
    state.fault = '';
    await expect(storeSourceUpload(1, archive)).resolves.toMatchObject({ sha: stored.sha });
    expect(readdirSync(dir)).toEqual([final]);
  } finally { state.fault = ''; rmSync(root, { recursive: true, force: true }); }
});
