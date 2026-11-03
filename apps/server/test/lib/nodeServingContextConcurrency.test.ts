import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('allows overlapping idle windows to read the same stable serving context without SQLite writer contention', () => {
  const root = mkdtempSync(join(tmpdir(), 'nd-serving-context-'));
  try {
    const worker = fileURLToPath(new URL('../fixtures/nodeServingContextProcess.ts', import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', worker, root], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
    }));
    expect(result.control, 'single-observer stable-context control').toBe(true);
    expect(result.refusal, 'a rejected context must not poison subsequent observers').toBe(true);
    expect(result.results, 'overlapping read-only observers must not contend for a SQLite writer').toEqual([
      { status: 'fulfilled', sameContext: true }, { status: 'fulfilled', sameContext: true },
    ]);
    expect(result.writeResults, 'file-backed managed writers also wait for their predecessor').toEqual(['fulfilled', 'fulfilled']);
    expect(result.written).toEqual([{ id: 1 }, { id: 2 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
