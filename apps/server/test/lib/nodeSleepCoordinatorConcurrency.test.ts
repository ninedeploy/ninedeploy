import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('reserves four file-backed sleep slots without consuming the other idle proofs or contending with managed transactions', () => {
  const root = mkdtempSync(join(tmpdir(), 'nd-sleep-coordinator-'));
  try {
    const worker = fileURLToPath(new URL('../fixtures/nodeSleepCoordinatorProcess.ts', import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', worker, root], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
    }));
    expect(result.taken).toEqual([1, 2, 3, 4]); expect(result.entered).toBe(4); expect(result.errors).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
