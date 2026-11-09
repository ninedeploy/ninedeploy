import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ paths: { dataDir: '' }, arrivals: 0, gate: Promise.resolve(), release: () => {}, entered: () => {}, fail: false }));
vi.mock('../src/config.js', () => ({ config: { paths: fixture.paths } }));
vi.mock('../src/lib/exec.js', () => ({ capture: async (_cmd: string, args: string[]) => {
  if (args[0] === '-tzf') {
    const arrival = ++fixture.arrivals;
    if (arrival === 1) fixture.entered();
    if (arrival === 2) fixture.release();
    await fixture.gate;
    if (fixture.fail && arrival === 2) throw new Error('fixture tar failure');
  }
  return '';
} }));
import { listSourceUploads, storeSourceUpload } from '../src/lib/sourceUpload.js';

it.each([false, true])('F1043: independent owners clean concurrent uploads (tar fails: %s)', async fail => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-source-concurrent-'));
  fixture.paths.dataDir = root;
  fixture.arrivals = 0; fixture.fail = fail;
  fixture.gate = new Promise<void>(resolve => { fixture.release = resolve; });
  const firstEntered = new Promise<void>(resolve => { fixture.entered = resolve; });
  try {
    const archive = gzipSync(Buffer.alloc(1024));
    const first = storeSourceUpload(1, archive);
    await Promise.race([firstEntered, first]);
    const results = await Promise.allSettled([first, storeSourceUpload(1, archive)]);
    expect(results.map(result => result.status)).toEqual(fail ? ['fulfilled', 'rejected'] : ['fulfilled', 'fulfilled']);
    const files = readdirSync(path.join(root, 'uploads', '1'));
    expect(files.filter(file => file.startsWith('.pending-'))).toEqual([]);
    expect(listSourceUploads(1)).toHaveLength(1);
    expect(readFileSync(path.join(root, 'uploads', '1', files[0]!))).toEqual(archive);
  } finally { fixture.release(); rmSync(root, { recursive: true, force: true }); }
});
