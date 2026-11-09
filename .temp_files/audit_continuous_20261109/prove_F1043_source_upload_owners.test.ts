import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ paths: { dataDir: '' }, concurrent: false, arrivals: 0, gate: Promise.resolve(), release: () => {} }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: fixture.paths } }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: async (_cmd: string, args: string[]) => {
  if (fixture.concurrent && args[0] === '-tzf') {
    if (++fixture.arrivals === 2) fixture.release();
    await fixture.gate;
  }
  return '';
} }));
import { listSourceUploads, storeSourceUpload } from '../../apps/server/src/lib/sourceUpload.js';
it('lets concurrent identical tar uploads each finish successfully', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-upload-owner-')); fixture.paths.dataDir = root;
  try {
    const archive = gzipSync(Buffer.alloc(1024));
    await storeSourceUpload(1, archive); await storeSourceUpload(1, archive);
    expect(listSourceUploads(1)).toHaveLength(1);
    console.log('CONTROL EXPECTED: two serial identical uploads succeed | ACTUAL: passed');
    fixture.concurrent = true; fixture.gate = new Promise<void>(resolve => { fixture.release = resolve; });
    const results = await Promise.allSettled([storeSourceUpload(2, archive), storeSourceUpload(2, archive)]);
    const statuses = results.map(result => result.status);
    console.log('EXPECTED: fulfilled, fulfilled | ACTUAL:', statuses);
    console.log(results.every(result => result.status === 'fulfilled') ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(statuses).toEqual(['fulfilled', 'fulfilled']);
  } finally { fixture.concurrent = false; fixture.release(); rmSync(root, { recursive: true, force: true }); }
});
