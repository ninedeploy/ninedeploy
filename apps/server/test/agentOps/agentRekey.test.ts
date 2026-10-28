import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TOKEN_HASH_FILE,
  agentRekeyOps,
  loadRekeyedTokenHash,
  REKEY_BOOTSTRAP_OPS,
  rekeyRestart,
} from '../../src/agentOps/agentRekey.js';
import { AGENT_OPS } from '../../src/agentOps/index.js';

/** G4.3 security review: `agent.rekey` persists the new key hash and restarts the agent. */
describe('agent.rekey', () => {
  const ENV_KEY = 'e'.repeat(64);
  let dir: string;
  let cwd: string;
  let envBefore: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nd-rekey-'));
    cwd = process.cwd();
    process.chdir(dir);
    envBefore = process.env['NINEDEPLOY_AGENT_TOKEN'];
    process.env['NINEDEPLOY_AGENT_TOKEN'] = ENV_KEY;
    rekeyRestart.delayMs = 1;
  });
  afterEach(() => {
    process.chdir(cwd);
    if (envBefore === undefined) delete process.env['NINEDEPLOY_AGENT_TOKEN'];
    else process.env['NINEDEPLOY_AGENT_TOKEN'] = envBefore;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const rekey = (hash: string) => agentRekeyOps.ops['agent.rekey']!.run({ tokenSha256: hash }, () => {}, { sealed: true });

  it('is a sealed-only registered op, allowed while the node waits for it', () => {
    expect(AGENT_OPS.get('agent.rekey')?.sealedOnly).toBe(true);
    expect([...REKEY_BOOTSTRAP_OPS].sort()).toEqual(['agent.ping', 'agent.rekey']);
  });

  it('writes the hash owner-only, answers, then restarts; startup prefers it', async () => {
    const exit = vi.spyOn(rekeyRestart, 'exit').mockImplementation(() => undefined);
    const hash = 'a'.repeat(64);
    const lines: string[] = [];
    expect(await agentRekeyOps.ops['agent.rekey']!.run({ tokenSha256: hash }, (l) => lines.push(l), { sealed: true })).toBe(0);
    expect(lines).toEqual(['ND-REKEY ok']);
    expect(readFileSync(join(dir, AGENT_TOKEN_HASH_FILE), 'utf8').split('\n')[0]).toBe(hash);
    if (process.platform !== 'win32') expect(statSync(join(dir, AGENT_TOKEN_HASH_FILE)).mode & 0o777).toBe(0o600);
    expect(loadRekeyedTokenHash(dir)).toEqual({ hash, stale: false });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });

  it('is ignored once the agent runs with another environment key', async () => {
    const exit = vi.spyOn(rekeyRestart, 'exit').mockImplementation(() => undefined);
    await rekey('b'.repeat(64));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(loadRekeyedTokenHash(dir, 'f'.repeat(64))).toEqual({ hash: null, stale: true });
    // A file without the fingerprint (hand-written, truncated) is never trusted either.
    writeFileSync(join(dir, AGENT_TOKEN_HASH_FILE), `${'c'.repeat(64)}\n`);
    expect(loadRekeyedTokenHash(dir)).toEqual({ hash: null, stale: true });
  });

  it('refuses anything but a sha256 hex and writes nothing', async () => {
    const exit = vi.spyOn(rekeyRestart, 'exit').mockImplementation(() => undefined);
    await expect(rekey('not-a-hash')).rejects.toThrow();
    expect(loadRekeyedTokenHash(dir)).toEqual({ hash: null, stale: false });
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('an agent waiting for its rekey (NINEDEPLOY_AGENT_REKEY_REQUIRED)', () => {
  it('answers agent.ping but refuses every other op, sealed or not', async () => {
    const { agentRoutes } = await import('../../src/agent.js');
    const { buildAgentApp } = await import('../../src/agentApp.js');
    const { seal } = await import('../../src/lib/agentSeal.js');
    const shared = 'cd'.repeat(32);
    const app = await buildAgentApp();
    app.log.level = 'silent';
    await app.register(agentRoutes, { tokenHash: shared, awaitingRekey: true });
    try {
      const exec = (op: string, nonce: string) =>
        app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: seal(shared, { op, params: {}, nonce }) } });
      expect((await exec('agent.ping', 'rk-1')).statusCode).toBe(200);
      for (const [i, op] of ['docker.ps', 'terminal.open', 'stream.open'].entries()) {
        const res = await exec(op, `rk-op-${i}`);
        if (res.statusCode === 400) continue; // not an op this agent has
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('rekey_required');
      }
      expect((await exec('terminal.open', 'rk-t')).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
