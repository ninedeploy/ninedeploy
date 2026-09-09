
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSealedSupportCache, agentOp, agentPing, generateAgentToken, tokenMatches } from '../../src/lib/agentClient.js';
import { open as openSealed, seal } from '../../src/lib/agentSeal.js';
import { runOp } from '../../src/agent.js';
import { createFakeDb } from '../helpers.js';

const cryptoReal = await import('../../src/lib/crypto.js');

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

const serverRow = {
  id: 1, name: 'edge', host: '10.0.0.5', port: 4600, status: 'online',
  tokenEncrypted: cryptoReal.encrypt('raw-token'),
  lastSeenAt: null, createdAt: new Date(0), updatedAt: new Date(0),
};

describe('tokenMatches', () => {
  it('compares sha256 digests in constant time', async () => {
    const token = generateAgentToken();
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(token).digest('hex');
    expect(tokenMatches(token, hash)).toBe(true);
    expect(tokenMatches('wrong', hash)).toBe(false);
    expect(tokenMatches(token, 'short')).toBe(false);
  });
});

describe('generateAgentToken', () => {
  it('produces fresh url-safe tokens', () => {
    const a = generateAgentToken();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(generateAgentToken());
  });
});

/** The shared secret both ends derive the envelope key from: sha256(token). */
const SHARED = cryptoReal.sha256('raw-token');

/**
 * Answer `/agent/ping` with a capability and `/agent/exec` with `exec`.
 * The client probes the agent before an operation to decide whether it may use
 * the sealed transport, so a blanket `mockResolvedValue` would answer the probe
 * with an exec response.
 */
function routeFetch(opts: { sealed: boolean; exec: unknown; pingOk?: boolean }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/agent/ping')) {
      if (opts.pingOk === false) throw new Error('unreachable');
      return { ok: true, json: async () => ({ ok: true, agent: true, sealed: opts.sealed }) };
    }
    return { ok: true, json: async () => opts.exec };
  });
}

/**
 * An honest sealed agent: opens the request envelope, echoes the request's
 * nonce back (the core refuses a sealed reply that does not bind to ITS
 * request), and seals the reply with the same shared secret.
 */
function honestSealedAgent(
  result: { lines?: string[]; exitCode?: number } = { lines: [], exitCode: 0 },
  pingSealed = true,
) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/agent/ping')) {
      return { ok: true, json: async () => ({ ok: true, agent: true, sealed: pingSealed }) };
    }
    const request = openSealed<{ nonce?: string }>(SHARED, (JSON.parse(String(init?.body)) as { sealed: unknown }).sealed);
    return { ok: true, json: async () => ({ sealed: seal(SHARED, { ...result, nonce: request.nonce }) }) };
  });
}

describe('agentOp', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    _resetSealedSupportCache();
    delete process.env['NINEDEPLOY_AGENT_REQUIRE_SEALED'];
    delete process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'];
  });

  it('seals the request so neither the token nor the params cross in cleartext', async () => {
    honestSealedAgent({ lines: ['a', 'b'], exitCode: 0 });
    const lines: string[] = [];
    const res = await agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', { image: 'nginx' }, (l) => lines.push(l));
    expect(res).toEqual({ exitCode: 0, lines: ['a', 'b'] });
    expect(lines).toEqual(['a', 'b']);

    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe('http://10.0.0.5:4600/agent/exec');
    // The whole point: no token header, and the operands are not readable.
    expect((init.headers as Record<string, string>)['x-agent-token']).toBeUndefined();
    const body = String(init.body);
    expect(body).not.toContain('raw-token');
    expect(body).not.toContain('nginx');
    // ...but the agent, holding the same secret, reads them back exactly —
    // including the fresh request nonce it must echo in its reply.
    expect(openSealed(SHARED, JSON.parse(body).sealed)).toEqual({
      op: 'docker.pull',
      params: { image: 'nginx' },
      nonce: expect.any(String),
    });
  });

  it('falls back to the legacy transport only when the operator opted in, and says so out loud', async () => {
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    routeFetch({ sealed: false, exec: { lines: ['a'], exitCode: 0 } });
    const lines: string[] = [];
    const res = await agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', { image: 'nginx' }, (l) => lines.push(l));
    expect(res).toEqual({ exitCode: 0, lines: ['a'] });
    // The warning reaches the deploy log, naming the host to upgrade.
    expect(lines[0]).toMatch(/older build.*travels unencrypted/);
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-agent-token']).toBe('raw-token');
    expect(JSON.parse(String(init.body))).toEqual({ op: 'docker.pull', params: { image: 'nginx' } });
  });

  it('refuses the cleartext fallback by default', async () => {
    // The fallback decision came from an UNAUTHENTICATED probe, so a forged
    // `sealed: false` must fail the operation closed — never silently send
    // the agent token and decrypted service secrets over plaintext HTTP.
    routeFetch({ sealed: false, exec: { lines: [], exitCode: 0 } });
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow(/does not support the encrypted transport/);
  });

  it('NINEDEPLOY_AGENT_REQUIRE_SEALED=1 wins even when the fallback is allowed', async () => {
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    process.env['NINEDEPLOY_AGENT_REQUIRE_SEALED'] = '1';
    routeFetch({ sealed: false, exec: { lines: [], exitCode: 0 } });
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow(/does not support the encrypted transport/);
  });

  it('fails closed when the ping is unreachable instead of assuming legacy', async () => {
    // Without cleartext opt-in, "cannot confirm" must not become "send
    // secrets anyway" — the operation fails and names the fix.
    routeFetch({ sealed: true, exec: { lines: [], exitCode: 0 }, pingOk: false });
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow(/does not support the encrypted transport/);
  });

  it('probes each server once and reuses the answer', async () => {
    honestSealedAgent();
    const db = createFakeDb({ findFirst: { servers: serverRow } });
    await agentOp(db, 1, 'docker.pull', {}, () => {});
    await agentOp(db, 1, 'docker.pull', {}, () => {});
    const pings = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/agent/ping'));
    expect(pings).toHaveLength(1);
  });

  it('re-probes after a failed ping instead of pinning the server to cleartext', async () => {
    // A negative answer we merely failed to obtain must NOT be cached. One
    // dropped probe — an agent restarting, a lost packet, or an on-path
    // attacker killing exactly one request — fails that operation closed and
    // the next call probes again.
    let pings = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/agent/ping')) {
        pings++;
        if (pings === 1) throw new Error('unreachable');
        return { ok: true, json: async () => ({ ok: true, agent: true, sealed: true }) };
      }
      const request = openSealed<{ nonce?: string }>(SHARED, (JSON.parse(String(init?.body)) as { sealed: unknown }).sealed);
      return { ok: true, json: async () => ({ sealed: seal(SHARED, { lines: [], exitCode: 0, nonce: request.nonce }) }) };
    });
    const db = createFakeDb({ findFirst: { servers: serverRow } });

    await expect(
      agentOp(db, 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow(/does not support the encrypted transport/);
    expect(pings).toBe(1);

    // Second call probes again, gets the real answer, and succeeds sealed.
    await agentOp(db, 1, 'docker.pull', {}, () => {});
    expect(pings).toBe(2);
  });

  it('does not cache a non-OK ping either', async () => {
    let pings = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/agent/ping')) {
        pings++;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ lines: [], exitCode: 0 }) };
    });
    const db = createFakeDb({ findFirst: { servers: serverRow } });
    await expect(agentOp(db, 1, 'docker.pull', {}, () => {})).rejects.toThrow(/encrypted transport/);
    await expect(agentOp(db, 1, 'docker.pull', {}, () => {})).rejects.toThrow(/encrypted transport/);
    expect(pings).toBe(2);
  });

  it('throws on transport errors', async () => {
    // Cleartext opt-in keeps these tests about the EXEC transport error: the
    // probe itself is answered 401 by the blanket mock, which (by design,
    // with the default) would otherwise fail closed as a downgrade refusal.
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    routeFetch({ sealed: true, exec: {} });
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow('agent docker.pull failed (401)');
  });

  it('throws on non-zero exit codes (cleartext opt-in)', async () => {
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    routeFetch({ sealed: false, exec: { lines: [], exitCode: 1 } });
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow('exited with 1');
  });

  it('rejects unknown ops through the null-def path', async () => {
    // No spawn mock needed: an unknown op returns -1 before any spawning.
    const code = await runOp('nope.nope', {}, () => {});
    expect(code).toBe(-1);
  });

  it('handles responses without a lines array', async () => {
    honestSealedAgent({ exitCode: 0 });
    const lines: string[] = [];
    const res = await agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.ping', {}, (l) => lines.push(l));
    expect(res).toEqual({ exitCode: 0, lines: [] });
    expect(lines).toEqual([]);
  });

  it('refuses a plaintext reply to a sealed request', async () => {
    // An on-path attacker can strip `sealed` from the RESPONSE body. The core
    // sent a sealed request, so anything unsealed back is tampering — never
    // "success" the panel would report as a live deployment.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/agent/ping')) {
        return { ok: true, json: async () => ({ ok: true, agent: true, sealed: true }) };
      }
      return { ok: true, json: async () => ({ lines: ['ok'], exitCode: 0 }) };
    });
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow(/response to a sealed request was not sealed/);
  });

  it('refuses a sealed reply that fails verification', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/agent/ping')) {
        return { ok: true, json: async () => ({ ok: true, agent: true, sealed: true }) };
      }
      const request = openSealed<{ nonce?: string }>(SHARED, (JSON.parse(String(init?.body)) as { sealed: unknown }).sealed);
      // Sealed with the WRONG secret — a tampered or replayed envelope.
      return { ok: true, json: async () => ({ sealed: seal('not-the-secret', { lines: [], exitCode: 0, nonce: request.nonce }) }) };
    });
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow(/sealed response failed verification/);
  });

  it('refuses a sealed reply that does not bind to this request (replay)', async () => {
    // A captured envelope from an earlier operation replays fine within the
    // five-minute seal window — unless the reply must echo THIS request's
    // nonce.
    let firstRequestNonce = '';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/agent/ping')) {
        return { ok: true, json: async () => ({ ok: true, agent: true, sealed: true }) };
      }
      const request = openSealed<{ nonce?: string }>(SHARED, (JSON.parse(String(init?.body)) as { sealed: unknown }).sealed);
      if (!firstRequestNonce) {
        firstRequestNonce = request.nonce ?? '';
        return { ok: true, json: async () => ({ sealed: seal(SHARED, { lines: [], exitCode: 0, nonce: request.nonce }) }) };
      }
      // Every later op gets a reply sealed for the FIRST request's nonce.
      return { ok: true, json: async () => ({ sealed: seal(SHARED, { lines: ['stale'], exitCode: 0, nonce: firstRequestNonce }) }) };
    });
    const db = createFakeDb({ findFirst: { servers: serverRow } });
    await agentOp(db, 1, 'docker.pull', {}, () => {});
    await expect(
      agentOp(db, 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow(/bad nonce/);
  });

  it('tolerates unreadable error bodies', async () => {
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    routeFetch({ sealed: true, exec: {} });
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: () => Promise.reject(new Error('stream gone')) });
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}),
    ).rejects.toThrow('agent docker.pull failed (500)');
  });

  it('throws for an unknown server', async () => {
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: undefined } }), 99, 'docker.pull', {}, () => {}),
    ).rejects.toThrow('Unknown server');
  });
});

describe('agentPing', () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(() => undefined);

  it('probes the ping endpoint with the token', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(agentPing('10.0.0.5', 4600, 'tok')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://10.0.0.5:4600/agent/ping');
    expect((init.headers as Record<string, string>)['x-agent-token']).toBe('tok');
  });

  it('throws when unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    await expect(agentPing('10.0.0.5', 4600, 'tok')).rejects.toThrow('agent unreachable (502)');
  });
});

describe('agent typed-operation table (unit)', () => {
  it('rejects hostile operands before spawning', async () => {
    const spawnMock2 = vi.fn(async () => 0);
    vi.doMock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock2 }));
    const { runOp } = await import('../../src/agent.js');
    await expect(runOp('docker.pull', { image: 'nginx; touch /pwn' }, () => {})).rejects.toThrow('Invalid image');
    await expect(runOp('docker.run', { name: '../escape' }, () => {})).rejects.toThrow('Invalid name');
    vi.doUnmock('../../src/lib/spawnValidated.js');
  });

  it('returns -1 for unknown operations without spawning', async () => {
    const spawnMock3 = vi.fn(async () => 0);
    vi.doMock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock3 }));
    const { runOp } = await import('../../src/agent.js');
    const code = await runOp('bash.exec', {}, () => {});
    expect(code).toBe(-1);
    expect(spawnMock3).not.toHaveBeenCalled();
    vi.doUnmock('../../src/lib/spawnValidated.js');
  });
});
