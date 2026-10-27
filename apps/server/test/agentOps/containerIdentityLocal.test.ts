import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const id = 'a'.repeat(64);
vi.mock('../../src/lib/spawnValidated.js', () => ({
  spawnValidated: async (_cmd: string, args: string[], sink: (line: string) => void) => {
    if (args[0] === 'inspect') sink(JSON.stringify({ id, name: '/web-4', managed: 'service', serviceId: '7', deploymentId: '4', composeProject: null }));
    return 0;
  },
}));
import { containerIdentityOps } from '../../src/agentOps/containerIdentity.js';

let temporary: string;
const original = process.cwd();
beforeEach(() => { temporary = mkdtempSync(join(tmpdir(), 'nd-retire-root-')); });
afterEach(() => { process.chdir(original); rmSync(temporary, { recursive: true, force: true }); });

it('uses the panel data journal for local retirement while leaving the agent working directory untouched', async () => {
  const work = join(temporary, 'work'), journal = join(temporary, 'data', 'local-lifecycle');
  mkdirSync(work); process.chdir(work);
  const lines: string[] = [];
  const result = await containerIdentityOps.ops['docker.retire']!.run({ id, name: 'web-4', graceSeconds: 0 }, line => lines.push(line),
    { sealed: true, lifecycleJournalRoot: journal });
  expect(result).toBe(0);
  expect(lines).toContain(`ND-RETIRED ${id}`);
  expect(existsSync(join(journal, 'service-7.sqlite'))).toBe(true);
  expect(existsSync(join(work, '.agent-work'))).toBe(false);
});

it('keeps the agent journal in its existing working-directory location', async () => {
  const work = join(temporary, 'work'); mkdirSync(work); process.chdir(work);
  const lines: string[] = [];
  expect(await containerIdentityOps.ops['docker.retire']!.run({ id, name: 'web-4', graceSeconds: 0 }, line => lines.push(line), { sealed: true })).toBe(0);
  expect(lines).toContain(`ND-RETIRED ${id}`);
  expect(existsSync(join(work, '.agent-work', '.lifecycle', 'service-7.sqlite'))).toBe(true);
});
