import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ paths: { dataDir: '' }, arrivals: 0, gate: Promise.resolve(), release: () => {}, fail: false }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: fixture.paths } }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: async (_cmd: string, args: string[]) => {
  if (args[0] === '-tzf') {
    const arrival = ++fixture.arrivals;
    if (arrival === 2) fixture.release();
    await fixture.gate;
    if (fixture.fail && arrival === 2) throw new Error('fixture tar failure');
  }
  return '';
} }));
import { listSourceUploads, storeSourceUpload } from './F1043_source_before.js';

it.each([false, true])('F1043: independent owners clean concurrent uploads (tar fails: %s)', async fail => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-source-concurrent-'));
  fixture.paths.dataDir = root;
  fixture.arrivals = 0; fixture.fail = fail;
  fixture.gate = new Promise<void>(resolve => { fixture.release = resolve; });
  try {
    const archive = gzipSync(Buffer.alloc(1024));
    const results = await Promise.allSettled([storeSourceUpload(1, archive), storeSourceUpload(1, archive)]);
    expect(results.map(result => result.status)).toEqual(fail ? ['fulfilled', 'rejected'] : ['fulfilled', 'fulfilled']);
    const files = readdirSync(path.join(root, 'uploads', '1'));
    expect(files.filter(file => file.startsWith('.pending-'))).toEqual([]);
    expect(listSourceUploads(1)).toHaveLength(1);
    expect(readFileSync(path.join(root, 'uploads', '1', files[0]!))).toEqual(archive);
  } finally { fixture.release(); rmSync(root, { recursive: true, force: true }); }
});
