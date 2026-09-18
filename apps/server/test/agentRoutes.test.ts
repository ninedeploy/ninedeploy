import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRoutes, runOp } from '../src/agent.js';
import { MAX_SKEW_MS, open as openSealed, seal } from '../src/lib/agentSeal.js';
import { buildTestApp } from './helpers.js';

const spawnMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));
const dockerPullMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/lib/dockerPull.js', () => ({ pullDockerImage: dockerPullMock }));

const TOKEN = 'agent-shared-token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-agent-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function appWith() {
  const app = await buildTestApp();
  await app.register(agentRoutes, { tokenHash: TOKEN_HASH });
  return app;
}

describe('agent /agent/exec route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(0);
  });

  it('rejects a bad token', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': 'wrong' },
      payload: { op: 'docker.pull', params: { image: 'nginx' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unknown operations', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 'bash.start', params: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_op');
  });

  it('executes a typed operation and returns its lines', async () => {
    spawnMock.mockImplementation(async (_exe, _argv, onLine) => {
      onLine?.('stopping web-3');
      return 0;
    });
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 'docker.stop', params: { name: 'web-3' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().exitCode).toBe(0);
    expect(res.json().lines).toEqual(['stopping web-3']);
    expect(res.json().envFile).toBeNull();
    // The 4th argument carries the confined cwd. A host-level op like `stop`
    // names no workspace, so it runs in the agent's own directory.
    expect(spawnMock).toHaveBeenCalledWith('docker', ['stop', '-t', '5', 'web-3'], expect.any(Function), {});
  });

  it('surfaces operand validation failures as 400', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 'docker.pull', params: { image: 'nginx; rm -rf /' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_params');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('writes env files for file.writeEnv and returns their path', async () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const app = await appWith();
      const res = await app.inject({
        method: 'POST', url: '/agent/exec',
        headers: { 'x-agent-token': TOKEN },
        payload: { op: 'file.writeEnv', params: { name: 'testenv', env: { KEY: 'value' } } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().envFile).toContain('testenv');

      const resDel = await app.inject({
        method: 'POST', url: '/agent/exec',
        headers: { 'x-agent-token': TOKEN },
        payload: { op: 'file.deleteEnv', params: { name: 'testenv' } },
      });
      expect(resDel.statusCode).toBe(200);
      expect(resDel.json().exitCode).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it('reports non-Error op failures generically', async () => {
    dockerPullMock.mockRejectedValueOnce('plain boom');
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 'docker.pull', params: { image: 'nginx' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Invalid params');
  });

  it('registers without an option object or env hash', async () => {
    const app = await buildTestApp();
    delete process.env['NINEDEPLOY_AGENT_TOKEN'];
    await app.register(agentRoutes);
    // No token hash → every token is rejected.
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': 'anything' },
      payload: { op: 'docker.pull', params: { image: 'nginx' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('executes file.deleteEnv via the route', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 'file.deleteEnv', params: { name: 'never-existed' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().exitCode).toBe(0);
  });

  it('handles empty request bodies and non-string ops', async () => {
    const app = await appWith();
    const noBody = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 42, params: 'nonsense' },
    });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().error.code).toBe('unknown_op');
  });

  it('falls back to the env token hash when the option is omitted', async () => {
    const app = await buildTestApp();
    process.env['NINEDEPLOY_AGENT_TOKEN'] = TOKEN_HASH;
    try {
      await app.register(agentRoutes);
      const res = await app.inject({
        method: 'POST', url: '/agent/exec',
        headers: { 'x-agent-token': TOKEN },
        payload: { op: 'nope', params: {} },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      delete process.env['NINEDEPLOY_AGENT_TOKEN'];
    }
  });

  it('treats a missing body as an empty object', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_op');
  });

  it('treats a null params object as empty', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 'unknown-thing', params: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_op');
  });

  it('answers the ping probe, advertising the sealed transport', async () => {
    // This flag is how an upgraded core learns it may stop sending the token
    // in a header. Without it the core falls back to cleartext, so the field
    // is load-bearing, not decorative.
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/agent/ping' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, agent: true, sealed: true });
  });
});

/**
 * The sealed path. Opening the envelope IS the authentication: a caller who
 * cannot produce one signed by sha256(token) never reaches `runOp`, and the
 * token itself never crosses the wire.
 */
describe('agent /agent/exec sealed transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(0);
  });

  it('answers an authenticated ping without touching Docker or the filesystem', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      payload: { sealed: seal(TOKEN_HASH, { op: 'agent.ping', params: {}, nonce: 'probe-123' }) },
    });
    expect(res.statusCode).toBe(200);
    expect(openSealed(TOKEN_HASH, res.json().sealed)).toEqual({
      lines: [], exitCode: 0, envFile: null, nonce: 'probe-123',
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(dockerPullMock).not.toHaveBeenCalled();
  });

  it('executes a sealed request with no token header at all', async () => {
    spawnMock.mockImplementation(async (_exe, _argv, onLine) => {
      onLine?.('stopping web-3');
      return 0;
    });
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      payload: { sealed: seal(TOKEN_HASH, { op: 'docker.stop', params: { name: 'web-3' } }) },
    });
    expect(res.statusCode).toBe(200);
    // The reply is sealed too — command output routinely echoes configuration.
    const body = res.json();
    expect(body.lines).toBeUndefined();
    expect(openSealed(TOKEN_HASH, body.sealed)).toEqual({
      lines: ['stopping web-3'],
      exitCode: 0,
      envFile: null,
    });
    expect(spawnMock).toHaveBeenCalled();
  });

  it('rejects an envelope sealed with the wrong secret, without spawning', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      payload: { sealed: seal('deadbeef'.repeat(8), { op: 'docker.stop', params: { name: 'web' } }) },
    });
    expect(res.statusCode).toBe(401);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a tampered envelope', async () => {
    const env = seal(TOKEN_HASH, { op: 'docker.stop', params: { name: 'web' } });
    const ct = Buffer.from(env.c, 'base64');
    ct[0] = (ct[0] as number) ^ 0x01;
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      payload: { sealed: { ...env, c: ct.toString('base64') } },
    });
    expect(res.statusCode).toBe(401);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a replayed envelope once it is outside the skew window', async () => {
    const app = await appWith();
    const stale = seal(TOKEN_HASH, { op: 'docker.stop', params: { name: 'web' } }, Date.now() - MAX_SKEW_MS - 1000);
    const res = await app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: stale } });
    expect(res.statusCode).toBe(401);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('r174: refuses a sealed request replayed INSIDE the skew window', async () => {
    const app = await appWith();
    const envelope = seal(TOKEN_HASH, { op: 'docker.stop', params: { name: 'web-3' }, nonce: 'a1b2c3d4e5f60718' });
    const first = await app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: envelope } });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: envelope } });
    expect(replay.statusCode).toBe(401);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // A fresh nonce (a genuinely new request) still runs.
    const fresh = seal(TOKEN_HASH, { op: 'docker.stop', params: { name: 'web-3' }, nonce: 'ffeeddccbbaa9988' });
    expect((await app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: fresh } })).statusCode).toBe(200);
  });

  it('answers a bad envelope exactly like a bad token, so it is no oracle', async () => {
    const app = await appWith();
    const sealedRes = await app.inject({
      method: 'POST', url: '/agent/exec',
      payload: { sealed: { v: 1, s: 'AAAA', i: 'AAAA', c: 'AAAA', t: 'AAAA', ts: Date.now() } },
    });
    const tokenRes = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': 'wrong' },
      payload: { op: 'docker.pull', params: { image: 'nginx' } },
    });
    expect(sealedRes.statusCode).toBe(tokenRes.statusCode);
    expect(sealedRes.json()).toEqual(tokenRes.json());
  });

  it('still rejects an unknown op inside a valid envelope', async () => {
    // Sealing authenticates the caller; it does not widen the operation table.
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      payload: { sealed: seal(TOKEN_HASH, { op: 'bash.exec', params: {} }) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_op');
  });

  it('still rejects hostile operands inside a valid envelope', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      payload: { sealed: seal(TOKEN_HASH, { op: 'docker.pull', params: { image: 'nginx; touch /pwn' } }) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_params');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('leaves the legacy plaintext reply unsealed for an un-upgraded core', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST', url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN },
      payload: { op: 'docker.stop', params: { name: 'web-3' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exitCode: 0 });
    expect(res.json().sealed).toBeUndefined();
  });
});

describe('runOp env-file helpers', () => {
  it('deletes a previously written env file', async () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      await runOp('file.writeEnv', { name: 'delenv', env: { A: 'b' } }, () => {});
      const code = await runOp('file.deleteEnv', { name: 'delenv' }, () => {});
      expect(code).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it('rejects a string env payload', async () => {
    await expect(
      runOp('file.writeEnv', { name: 'x', env: 'not-an-object' }, () => {}),
    ).rejects.toThrow('Invalid env');
  });

  it('rejects env values with newlines', async () => {
    await expect(
      runOp('file.writeEnv', { name: 'badenv', env: { A: 'x\nB=1' } }, () => {}),
    ).rejects.toThrow('Invalid env value');
  });

  it('returns -1 for an unknown op in runOp', async () => {
    const code = await runOp('unknown.op', {}, () => {});
    expect(code).toBe(-1);
  });
});

describe('r176: auto-join token persistence', () => {
  it('reuses the token written on first start, so a restarted agent is not locked out', async () => {
    const { loadOrCreateAgentToken } = await import('../src/agent.js');
    const dir = mkdtempSync(path.join(tmp, 'tok-'));
    const first = loadOrCreateAgentToken(() => 'a'.repeat(64), dir);
    const second = loadOrCreateAgentToken(() => 'b'.repeat(64), dir);
    expect(first).toBe('a'.repeat(64));
    expect(second).toBe(first);
  });
});
