import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('recovers the same durable sleep command across process restarts without adopting the old worker or sleeping the service', () => {
  const root = mkdtempSync(join(tmpdir(), 'nd-sleep-recovery-'));
  const worker = fileURLToPath(new URL('../fixtures/nodeSleepJournalProcess.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const run = (mode: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', worker, mode, root], { cwd, encoding: 'utf8', timeout: 15_000 }));
  try {
    expect(run('accept')).toMatchObject({ persisted: true, epoch: expect.any(Number) });
    expect(run('recover')).toEqual({ recovered: true, oldWorkerRefused: true, sameCommand: true, slept: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
