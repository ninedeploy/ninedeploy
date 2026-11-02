import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('recovers the same maintenance barrier across process restart before refreshing sleeping bindings', () => {
  const root = mkdtempSync(join(tmpdir(), 'nd-wake-maintenance-'));
  const worker = fileURLToPath(new URL('../fixtures/nodeWakeMaintenanceProcess.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const run = (mode: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', worker, mode, root], { cwd, encoding: 'utf8', timeout: 15_000 }));
  try {
    expect(run('accept')).toEqual({ persisted: true });
    expect(run('recover')).toEqual({ recovered: true, oldWorkerRefused: true, admissionBlocked: true, rebound: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
