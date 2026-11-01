
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSealedSupportCache, agentOp, agentPing, agentTransportSealed, generateAgentToken, isSealedOnlyAgentOp, tokenMatches } from '../../src/lib/agentClient.js';
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
    // The runner can invoke a stubbed global fetch with no arguments during
    // post-test cleanup; that is not an agent request, and crashing here on a
    // missing body fails the file with an unhandled rejection.
    if (!init?.body) return { ok: true, json: async () => ({}) };
    const request = openSealed<{ nonce?: string }>(SHARED, (JSON.parse(String(init.body)) as { sealed: unknown }).sealed);
    return { ok: true, json: async () => ({ sealed: seal(SHARED, { ...result, nonce: request.nonce }) }) };
  });
}

describe('agentOp', () => {
  it.each([[5, 35_000], [37, 67_000], [300, 330_000], [999, 35_000]])('bounds retirement transport around requested grace %i', async (graceSeconds, budget) => {
    honestSealedAgent();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.retire', { id: 'a'.repeat(64), name: 'web-9', graceSeconds: String(graceSeconds) }, () => {}, { timeoutMs: 400_000 });
      expect(timeout).toHaveBeenCalledWith(budget);
    } finally { timeout.mockRestore(); }
  });

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

  it('honours cancellation before any request is sent', async () => {
    const controller = new AbortController();
    controller.abort(new Error('collector closed'));
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'agent.stats', {}, () => undefined, { signal: controller.signal, timeoutMs: 20_000 })).rejects.toThrow('collector closed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits for a sealed rate-limit refusal and retries the identical envelope once capacity returns', async () => {
    vi.useFakeTimers();
    const bodies: string[] = [], sink = vi.fn();
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/agent/ping')) return { ok: true, json: async () => ({ sealed: true }) };
      bodies.push(String(init.body));
      if (bodies.length === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => 'Rate limit exceeded' };
      const request = openSealed<{ nonce: string }>(SHARED, JSON.parse(String(init.body)).sealed);
      return { ok: true, status: 200, json: async () => ({ sealed: seal(SHARED, { nonce: request.nonce, exitCode: 0, lines: ['removed'] }) }) };
    });
    try {
      const result = agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.rm', { name: 'app-3' }, sink, { timeoutMs: 5000 });
      void result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(999); expect(bodies).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({ exitCode: 0, lines: ['removed'] });
      expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]); expect(sink.mock.calls).toEqual([['removed']]);
    } finally { vi.useRealTimers(); }
  });

  it('cancels a pending rate-limit wait without resending a mutating operation', async () => {
    vi.useFakeTimers(); const controller = new AbortController(); let calls = 0;
    fetchMock.mockImplementation(async url => {
      if (String(url).endsWith('/agent/ping')) return { ok: true, json: async () => ({ sealed: true }) };
      calls++;
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => 'limited' };
    });
    try {
      const result = agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.rm', { name: 'app-3' }, () => {}, { signal: controller.signal, timeoutMs: 5000 });
      void result.catch(() => undefined); await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error('deployment stopped'));
      await expect(result).rejects.toThrow('deployment stopped'); await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('never extends the original deadline to accommodate a rate-limit wait', async () => {
    fetchMock.mockImplementation(async url => String(url).endsWith('/agent/ping') ? { ok: true, json: async () => ({ sealed: true }) }
      : { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => 'limited' });
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.rm', { name: 'app-3' }, () => {}, { timeoutMs: 500 })).rejects.toThrow(/timeout/i);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/agent/exec'))).toHaveLength(1);
  });

  it.each([[429, undefined], [429, 'invalid'], [429, '61'], [500, '1']] as const)('does not retry status %s with unsupported Retry-After %s', async (status, retry) => {
    fetchMock.mockImplementation(async url => String(url).endsWith('/agent/ping') ? { ok: true, json: async () => ({ sealed: true }) }
      : { ok: false, status, headers: new Headers(retry ? { 'retry-after': retry } : {}), text: async () => 'refused' });
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.rm', {}, () => {})).rejects.toThrow(`failed (${status})`);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/agent/exec'))).toHaveLength(1);
  });

  it('does not automatically retry an opt-in legacy plaintext operation', async () => {
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    fetchMock.mockImplementation(async url => String(url).endsWith('/agent/ping') ? { ok: true, json: async () => ({ sealed: false }) }
      : { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => 'limited' });
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.rm', {}, () => {})).rejects.toThrow('failed (429)');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/agent/exec'))).toHaveLength(1);
  });

  it('caps repeated rate-limit refusals and never replaces the sealed nonce', async () => {
    vi.useFakeTimers(); const bodies: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/agent/ping')) return { ok: true, json: async () => ({ sealed: true }) };
      bodies.push(String(init.body)); return { ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }), text: async () => 'limited' };
    });
    try {
      const result = agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.rm', {}, () => {}, { timeoutMs: 5000 });
      void result.catch(() => undefined); await vi.advanceTimersByTimeAsync(3000);
      await expect(result).rejects.toThrow('failed (429)'); expect(bodies).toHaveLength(3); expect(new Set(bodies).size).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('propagates a replay refusal without minting a new mutation nonce', async () => {
    vi.useFakeTimers(); const bodies: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/agent/ping')) return { ok: true, json: async () => ({ sealed: true }) };
      bodies.push(String(init.body)); return { ok: false, status: bodies.length === 1 ? 429 : 409, headers: new Headers({ 'retry-after': '1' }), text: async () => 'request already reserved' };
    });
    try {
      const result = agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.rm', {}, () => {}, { timeoutMs: 5000 });
      void result.catch(() => undefined); await vi.advanceTimersByTimeAsync(1000);
      await expect(result).rejects.toThrow('failed (409)'); expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
    } finally { vi.useRealTimers(); }
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

  it('0.13 (T5): never sends a Git credential in clear, even with the cleartext fallback opted in', async () => {
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    routeFetch({ sealed: false, exec: { lines: [], exitCode: 0 } });
    const credential = { username: 'x-access-token', password: 'ghs_cleartextNever' };
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'git.fetch', { workspace: 'web', credential }, () => {}),
    ).rejects.toThrow(/refusing to send a Git credential over the unencrypted transport/);
    // Only the capability probe went out — no exec request carried the token.
    expect(fetchMock.mock.calls.every(([u]) => String(u).endsWith('/agent/ping'))).toBe(true);
    // The same op without a credential still takes the operator's fallback.
    await expect(
      agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'git.fetch', { workspace: 'web' }, () => {}),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it('never sends a database terminal credential in clear even when legacy fallback is explicitly enabled',async()=>{
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT']='1';
    routeFetch({sealed:false,exec:{lines:[],exitCode:0}});
    const params={kind:'database',databaseId:7,container:'nd-db-owned',containerId:'d'.repeat(64),client:{engine:'postgres',username:'nine',database:'app',password:'private-terminal-fixture'},cols:80,rows:24,sessionId:1};
    let refusal: unknown;try{await agentOp(createFakeDb({findFirst:{servers:serverRow}}),1,'terminal.open',params,()=>undefined);}catch(error){refusal=error;}
    const exec=fetchMock.mock.calls.filter(([url])=>String(url).endsWith('/agent/exec'));
    expect({refused:refusal instanceof Error,execRequests:exec.length,plaintextCredentialRequests:exec.filter(([,init])=>String(init?.body).includes('private-terminal-fixture')).length}).toEqual({refused:true,execRequests:0,plaintextCredentialRequests:0});
    await expect(agentOp(createFakeDb({findFirst:{servers:serverRow}}),1,'docker.pull',{image:'nginx'},()=>undefined)).resolves.toMatchObject({exitCode:0});
    _resetSealedSupportCache();honestSealedAgent();
    await expect(agentOp(createFakeDb({findFirst:{servers:serverRow}}),1,'terminal.open',params,()=>undefined)).resolves.toMatchObject({exitCode:0});
    const [,init]=fetchMock.mock.calls.at(-1)!;expect(String(init.body)).not.toContain('private-terminal-fixture');
    expect(openSealed<{params:{client:{password:string}}}>(SHARED,JSON.parse(String(init.body)).sealed).params.client.password).toBe('private-terminal-fixture');
  });
  it.each(['db.studio.start', 'db.studio.stop', 'db.studio.open', 'proxy.traffic.open', 'proxy.traffic.sample', 'proxy.traffic.finish', 'proxy.traffic.close', 'proxy.traffic.future', 'proxy.servingTraffic.open', 'proxy.servingTraffic.sample', 'proxy.servingTraffic.finish', 'proxy.servingTraffic.close', 'proxy.servingTraffic.future', 'docker.readiness'])('never sends %s metadata or credentials through legacy plaintext fallback', async op => {
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    routeFetch({ sealed: false, exec: { lines: [], exitCode: 0 } });
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, op, { password: 'private-studio-fixture' }, () => undefined)).rejects.toThrow();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/agent/exec'))).toHaveLength(0);
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', { image: 'nginx' }, () => undefined)).resolves.toMatchObject({ exitCode: 0 });
    _resetSealedSupportCache(); honestSealedAgent();
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, op, { password: 'private-studio-fixture' }, () => undefined)).resolves.toMatchObject({ exitCode: 0 });
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(init.body)).not.toContain('private-studio-fixture');
    expect(openSealed<{ params: { password: string } }>(SHARED, JSON.parse(String(init.body)).sealed).params.password).toBe('private-studio-fixture');
  });
  it('never sends membership or container-tool operands in clear, even with the cleartext fallback opted in', async () => {
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    routeFetch({ sealed: false, exec: { lines: [], exitCode: 0 } });
    const token = `SWMTKN-1-${'a1'.repeat(25)}-${'b2'.repeat(12)}z`;
    for (const [op, params] of [
      ['swarm.join', { token, managerAddr: '10.0.0.1:2377' }],
      ['swarm.leave', {}],
      ['swarm.info', {}],
      ['swarm.future', {}],
      ['docker.containerTool', { action: 'write', container: 'same-name', path: '/tmp/file', contentBase64: 'c2VjcmV0LWZpeHR1cmU=' }],
    ] as const) {
      await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, op, params, () => {}), op).rejects.toThrow(
        /refusing to send it over the unencrypted transport; it is sealed only/,
      );
    }
    expect(isSealedOnlyAgentOp('swarm.join')).toBe(true);
    expect(isSealedOnlyAgentOp('docker.pull')).toBe(false);
    // Only the capability probe went out — no exec request carried the token.
    expect(fetchMock.mock.calls.every(([u]) => String(u).endsWith('/agent/ping'))).toBe(true);
    // Sealed, the same op goes through.
    _resetSealedSupportCache();
    honestSealedAgent();
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'swarm.info', {}, () => {})).resolves.toMatchObject({ exitCode: 0 });
  });

  it('0.13 (T5): a credential rides inside the sealed envelope only', async () => {
    honestSealedAgent();
    const credential = { username: 'x-access-token', password: 'ghs_sealedOnly' };
    await agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'git.fetch', { workspace: 'web', credential }, () => {});
    const body = String((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body);
    expect(body).not.toContain('ghs_sealedOnly');
    expect(openSealed<{ params: unknown }>(SHARED, JSON.parse(body).sealed).params).toEqual({ workspace: 'web', credential });
  });

  it('0.13 (T5): agentTransportSealed reports the transport an op would use', async () => {
    honestSealedAgent();
    expect(await agentTransportSealed(createFakeDb({ findFirst: { servers: serverRow } }), 1)).toBe(true);
    _resetSealedSupportCache();
    routeFetch({ sealed: false, exec: {} });
    expect(await agentTransportSealed(createFakeDb({ findFirst: { servers: serverRow } }), 1)).toBe(false);
    routeFetch({ sealed: true, exec: {}, pingOk: false });
    expect(await agentTransportSealed(createFakeDb({ findFirst: { servers: serverRow } }), 1)).toBe(false);
    expect(await agentTransportSealed(createFakeDb({ findFirst: { servers: undefined } }), 1)).toBe(false);
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

  it('r470: tolerateExit hands the non-zero result back instead of throwing', async () => {
    // Probe-style ops (docker.volumeInspect as an existence check) pass
    // tolerateExit and read res.exitCode themselves — exit 1 is the ANSWER
    // ("volume missing"), not a transport failure.
    process.env['NINEDEPLOY_AGENT_ALLOW_CLEARTEXT'] = '1';
    routeFetch({ sealed: false, exec: { lines: ['no such volume'], exitCode: 1 } });
    const res = await agentOp(
      createFakeDb({ findFirst: { servers: serverRow } }),
      1,
      'docker.volumeInspect',
      {},
      () => {},
      { tolerateExit: true },
    );
    expect(res).toEqual({ exitCode: 1, lines: ['no such volume'] });
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

  it.each([undefined, null, '0', 'not-a-number', 0.5])('rejects invalid exit code %j instead of reporting success', async (exitCode) => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/agent/ping')) return { ok: true, json: async () => ({ sealed: true }) };
      if (!init?.body) return { ok: true, json: async () => ({}) };
      const request = openSealed<{ nonce: string }>(SHARED, JSON.parse(String(init.body)).sealed);
      return { ok: true, json: async () => ({ sealed: seal(SHARED, { exitCode, nonce: request.nonce }) }) };
    });
    await expect(agentOp(createFakeDb({ findFirst: { servers: serverRow } }), 1, 'docker.pull', {}, () => {}))
      .rejects.toThrow('invalid exit code');
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

  it('authenticates using a sealed challenge without exposing the token', async () => {
    honestSealedAgent();
    await expect(agentPing('10.0.0.5', 4600, 'raw-token')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://10.0.0.5:4600/agent/exec');
    expect((init.headers as Record<string, string>)['x-agent-token']).toBeUndefined();
    expect(String(init.body)).not.toContain('raw-token');
    expect(openSealed(SHARED, JSON.parse(String(init.body)).sealed)).toEqual({
      op: 'agent.ping', params: {}, nonce: expect.any(String),
    });
    expect(init.redirect).toBe('error');
  });

  it.each([
    { ok: true, agent: true, sealed: true },
    { exitCode: 0 },
    { sealed: seal(SHARED, { exitCode: 0, nonce: 'replayed' }) },
    { sealed: seal(cryptoReal.sha256('wrong-token'), { exitCode: 0 }) },
    null,
  ])('refuses unauthenticated or mismatched probe replies: %j', async (reply) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => reply });
    await expect(agentPing('10.0.0.5', 4600, 'raw-token')).rejects.toThrow('agent authentication failed');
  });

  it('throws when unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    await expect(agentPing('10.0.0.5', 4600, 'tok')).rejects.toThrow('agent unreachable (502)');
  });

  it('F892: brackets an IPv6-literal host (the SSH bootstrap stores one whole)', async () => {
    _resetSealedSupportCache();
    honestSealedAgent();
    await expect(agentPing('2001:db8::1', 4600, 'raw-token')).resolves.toBeUndefined();
    await agentOp(createFakeDb({ findFirst: { servers: { ...serverRow, host: '2001:db8::1' } } }), 1, 'docker.pull', { image: 'nginx' }, () => undefined);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      'http://[2001:db8::1]:4600/agent/exec',
      'http://[2001:db8::1]:4600/agent/ping',
      'http://[2001:db8::1]:4600/agent/exec',
    ]);
    for (const u of urls) expect(new URL(u).port).toBe('4600');
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
