import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ paths: { dataDir: '' }, arrivals: 0, count: 2, failSecond: false, gate: Promise.resolve(), release: () => {} }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: fixture.paths } }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: async (_cmd: string, args: string[]) => {
  if (args[0] === '-tzf') {
    const arrival = ++fixture.arrivals;
    if (fixture.arrivals === fixture.count) fixture.release();
    await fixture.gate;
    if (fixture.failSecond && arrival === 2) throw new Error('fixture validation failure');
  }
  return '';
} }));
import { listSourceUploads, storeSourceUpload } from '../../apps/server/src/lib/sourceUpload.js';
it('verifies multiple simultaneous owners, validation failure isolation and sequential retries', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-verify-upload-')); fixture.paths.dataDir = root;
  try {
    const archive = gzipSync(Buffer.alloc(1024));
    let serviceId = 0;
    for (const [count, failSecond] of [[2, false], [5, false], [2, true]] as const) {
      serviceId++; fixture.arrivals = 0; fixture.count = count; fixture.failSecond = failSecond;
      fixture.gate = new Promise<void>(resolve => { fixture.release = resolve; });
      const results = await Promise.allSettled(Array.from({ length: count }, () => storeSourceUpload(serviceId, archive)));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(failSecond ? count - 1 : count);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(failSecond ? 1 : 0);
      const files = readdirSync(path.join(root, 'uploads', String(serviceId)));
      expect(files.filter(file => file.startsWith('.pending-'))).toEqual([]);
      expect(listSourceUploads(serviceId)).toHaveLength(1);
      expect(readFileSync(path.join(root, 'uploads', String(serviceId), files[0]!))).toEqual(archive);
    }
    fixture.failSecond = false; fixture.gate = Promise.resolve();
    await storeSourceUpload(1, archive); await storeSourceUpload(1, archive);
    expect(listSourceUploads(1)).toHaveLength(1);
    console.log('EXPECTED: 2/5 owners publish, failed sibling cannot delete survivor, retries exact | ACTUAL: all gated checks passed');
    console.log('FIX VERIFIED');
  } finally { fixture.release(); rmSync(root, { recursive: true, force: true }); }
});
