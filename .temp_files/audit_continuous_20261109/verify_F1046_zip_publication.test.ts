import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ paths: { dataDir: '' }, fault: '' }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: state.paths } }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (state.fault === 'write' && String(args[0]).endsWith('.zip')) { fs.writeFileSync(args[0], 'PARTIAL'); throw new Error('fixture partial write'); }
      return fs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => { if (state.fault === 'rename') throw new Error('fixture rename failure'); return fs.renameSync(...args); },
  };
});
import { extractSourceUpload, listSourceUploads, storeSourceUpload } from '../../apps/server/src/lib/sourceUpload.js';
function archive(text: string): Buffer {
  const name = Buffer.from('index.txt'), data = Buffer.from(text);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
it('verifies atomic first/reuploads, failure cleanup, unrelated ownership and extractable retries', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-verify-zip-')); state.paths.dataDir = root;
  try {
    let serviceId = 0;
    for (const previous of [false, true]) {
      for (const fault of ['write', 'rename']) {
        serviceId++; state.fault = '';
        const bytes = archive('EXACT-SOURCE'), dir = path.join(root, 'uploads', String(serviceId)); mkdirSync(dir, { recursive: true });
        if (previous) await storeSourceUpload(serviceId, bytes);
        writeFileSync(path.join(dir, '.pending-other-owner'), 'OTHER');
        const files = readdirSync(dir).sort(), records = listSourceUploads(serviceId);
        state.fault = fault;
        for (let attempt = 0; attempt < 3; attempt++) {
          await expect(storeSourceUpload(serviceId, bytes)).rejects.toThrow();
          expect(readdirSync(dir).sort()).toEqual(files); expect(listSourceUploads(serviceId)).toEqual(records);
          expect(readFileSync(path.join(dir, '.pending-other-owner'), 'utf8')).toBe('OTHER');
          if (records[0]) expect(readFileSync(path.join(dir, `${records[0].sha}.zip`))).toEqual(bytes);
        }
        state.fault = ''; const stored = await storeSourceUpload(serviceId, bytes);
        const work = path.join(root, 'repos', String(serviceId)); await extractSourceUpload(serviceId, stored.sha, work);
        expect(readFileSync(path.join(work, 'index.txt'), 'utf8')).toBe('EXACT-SOURCE');
        expect(listSourceUploads(serviceId)).toHaveLength(1);
      }
    }
    console.log('EXPECTED: 12 failed ZIP writes/moves preserve accepted bytes/history, retry extracts exact source | ACTUAL: all passed');
    console.log('FIX VERIFIED');
  } finally { state.fault = ''; rmSync(root, { recursive: true, force: true }); }
});
