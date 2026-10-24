import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('nd-observability-reopen-')) throw new Error('Unsafe test cleanup');
    await rm(absolute, { recursive: true, force: true });
  }
});
const serverRoot = fileURLToPath(new URL('..', import.meta.url));
async function run(root: string, mode: string) {
  const report = join(root, mode + '.json');
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'test/fixtures/observabilityProcess.ts', mode, 'file:' + join(root, 'panel.db'), report], {
    cwd: serverRoot, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NINEDEPLOY_MASTER_KEY: 'a'.repeat(64), NINEDEPLOY_MASTER_KEYS: '' },
  });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(await readFile(report, 'utf8'));
}
async function directory() { const root = await mkdtemp(join(tmpdir(), 'nd-observability-reopen-')); roots.push(root); return root; }

describe('on-disk monitoring recovery across actual process restarts', () => {
  it('delivers captured logs after the original process and source container stopped', async () => {
    const root = await directory();
    expect(await run(root, 'capture')).toMatchObject({ queued: 1, failed: 1 });
    expect(await run(root, 'deliver')).toMatchObject({ shipped: 1, entries: ['persisted log'] });
  });
  it('retains long-range history after raw pruning and a fresh process', async () => {
    const root = await directory();
    expect(await run(root, 'metrics-write')).toEqual({ rawRows: 0 });
    expect(await run(root, 'metrics-read')).toEqual([{ ts: '2026-10-12T15:00:00.000Z', value: 2.5 }]);
  });
});
