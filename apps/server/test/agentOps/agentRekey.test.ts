import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TOKEN_HASH_FILE, agentRekeyOps, loadRekeyedTokenHash, rekeyRestart } from '../../src/agentOps/agentRekey.js';
import { AGENT_OPS } from '../../src/agentOps/index.js';

/** G4.3 security review: `agent.rekey` persists the new key hash and restarts the agent. */
describe('agent.rekey', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nd-rekey-'));
    cwd = process.cwd();
    process.chdir(dir);
    rekeyRestart.delayMs = 1;
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('is a sealed-only registered op', () => {
    expect(AGENT_OPS.get('agent.rekey')?.sealedOnly).toBe(true);
  });

  it('writes the hash owner-only, answers, then restarts; startup prefers it', async () => {
    const exit = vi.spyOn(rekeyRestart, 'exit').mockImplementation(() => undefined);
    const hash = 'a'.repeat(64);
    const lines: string[] = [];
    expect(await agentRekeyOps.ops['agent.rekey']!.run({ tokenSha256: hash }, (l) => lines.push(l), { sealed: true })).toBe(0);
    expect(lines).toEqual(['ND-REKEY ok']);
    expect(readFileSync(join(dir, AGENT_TOKEN_HASH_FILE), 'utf8').trim()).toBe(hash);
    if (process.platform !== 'win32') expect(statSync(join(dir, AGENT_TOKEN_HASH_FILE)).mode & 0o777).toBe(0o600);
    expect(loadRekeyedTokenHash(dir)).toBe(hash);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });

  it('refuses anything but a sha256 hex and writes nothing', async () => {
    const exit = vi.spyOn(rekeyRestart, 'exit').mockImplementation(() => undefined);
    await expect(agentRekeyOps.ops['agent.rekey']!.run({ tokenSha256: 'not-a-hash' }, () => {}, { sealed: true })).rejects.toThrow();
    expect(loadRekeyedTokenHash(dir)).toBeNull();
    expect(exit).not.toHaveBeenCalled();
  });
});
