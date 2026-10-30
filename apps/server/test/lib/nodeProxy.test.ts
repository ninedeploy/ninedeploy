import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const h = vi.hoisted(() => ({
  agentOp: vi.fn(async () => ({ exitCode: 0, lines: [] as string[] })),
  agentTransportSealed: vi.fn(async () => true),
  getAcmeEmail: vi.fn(async () => 'ops@example.com' as string | null),
  getDnsConfig: vi.fn(async () => ({ provider: null, token: null, wildcardApex: null })),
  renderStaticConfig: vi.fn(() => 'entryPoints: {}'),
  renderDynamicConfig: vi.fn(async () => 'http: {}'),
}));

vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.agentOp, agentTransportSealed: h.agentTransportSealed }));
vi.mock('../../src/engine/proxy.js', () => ({
  getAcmeEmail: h.getAcmeEmail,
  getDnsConfig: h.getDnsConfig,
  renderStaticConfig: h.renderStaticConfig,
  renderDynamicConfig: h.renderDynamicConfig,
}));

const { syncAllNodeProxies, syncNodeProxy } = await import('../../src/lib/nodeProxy.js');

const db = {} as never;

/** Ops issued, in order, by the last run. */
const opsIssued = (): string[] => h.agentOp.mock.calls.map((c) => (c as unknown[])[2] as string);

/** Make the agent answer as a node whose proxy is already up with this config. */
function agentSteady() {
  h.agentOp.mockImplementation(async (_db: unknown, _id: unknown, op: string) => {
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|172.18.0.2'] };
    return { exitCode: 0, lines: [] };
  });
}

/**
 * r037 — node-local ingress.
 *
 * Each node terminates TLS for its own services, so production traffic never
 * hairpins through the panel. The panel stays the source of truth for domains
 * and certificates: it renders both configs with the same functions that
 * generate its own, and the agent only writes them to a fixed path.
 */
describe('syncNodeProxy', () => {
  it('refuses an autoscale promotion without node routing confirmation before contacting the agent', async () => {
    h.agentOp.mockReset();
    const result = await syncNodeProxy(db, 4, undefined, { autoscalePromotion: { serviceId: 1, ownerEpoch: 1, requestId: 'a'.repeat(32), workerToken: 'b'.repeat(32) } });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/confirmed node routing/) });
    expect(h.agentOp).not.toHaveBeenCalled();
  });
  it('does not write config or recreate a proxy after cancellation during inspection', async () => {
    const abort = new AbortController();
    h.agentOp.mockReset();
    h.agentOp.mockImplementation(async (_db: unknown, _id: unknown, op: string) => {
      if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
      if (op === 'docker.inspect') { abort.abort(Error('Lifecycle cancelled')); return { exitCode: 0, lines: ['exited|'] }; }
      return { exitCode: 0, lines: [] };
    });
    const result = await syncNodeProxy(db, 4, undefined, { signal: abort.signal } as never);
    expect(result).toMatchObject({ ok: false, routingUnconfirmed: true, reason: 'Lifecycle cancelled' });
    expect(opsIssued()).not.toContain('proxy.ensure');
  });

  it('does not contact any node when the routing refresh is already cancelled', async () => {
    h.agentOp.mockReset(); agentSteady();
    const abort = new AbortController(); abort.abort(Error('Lifecycle cancelled'));
    await expect(syncAllNodeProxies(db, [4, 5], undefined, { signal: abort.signal } as never)).rejects.toThrow('Lifecycle cancelled');
    expect(h.agentOp).not.toHaveBeenCalled();
  });

  it('ships the static and dynamic config the panel rendered for THAT node', async () => {
    h.agentOp.mockReset();
    agentSteady();

    await expect(syncNodeProxy(db, 4)).resolves.toEqual({ ok: true });

    // Scoping is load-bearing: a router's upstream is a container name resolved
    // over the LOCAL docker network, so a node must never be handed another
    // machine's services — every one of them would answer 502.
    expect(h.renderDynamicConfig).toHaveBeenCalledWith(db, { serverId: 4 });

    const writes = h.agentOp.mock.calls.filter((c) => (c as unknown[])[2] === 'proxy.writeConfig');
    expect(writes.map((c) => ((c as unknown[])[3] as { kind: string }).kind)).toEqual(['static', 'dynamic']);
    expect(((writes[0] as unknown[])[3] as { content: string }).content).toBe('entryPoints: {}');
    expect(((writes[1] as unknown[])[3] as { content: string }).content).toBe('http: {}');
  });

  it('leaves a healthy proxy alone when only the routing changed', async () => {
    h.agentOp.mockReset();
    agentSteady();

    await syncNodeProxy(db, 4);

    // `proxy.ensure` is a `rm -f` + `run`. Doing that on every domain edit
    // would turn each one into a brief ingress outage on the node; Traefik
    // hot-reloads the dynamic file on its own.
    expect(opsIssued()).not.toContain('proxy.ensure');
  });

  it('starts the proxy on a node that is not running one yet', async () => {
    h.agentOp.mockReset();
    h.agentOp.mockImplementation(async (_db: unknown, _id: unknown, op: string) => {
      if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
      if (op === 'docker.inspect') throw new Error('No such object: ninedeploy-proxy');
      return { exitCode: 0, lines: [] };
    });

    await expect(syncNodeProxy(db, 4)).resolves.toEqual({ ok: true });
    expect(opsIssued()).toContain('proxy.ensure');
  });

  it('recreates the proxy when the STATIC config changed', async () => {
    h.agentOp.mockReset();
    h.agentOp.mockImplementation(async (_db: unknown, _id: unknown, op: string, params: unknown) => {
      if (op === 'proxy.writeConfig') {
        const kind = (params as { kind: string }).kind;
        // Traefik reads the static file only at start-up.
        return { exitCode: 0, lines: [`proxy-config x ${kind === 'static' ? 'changed' : 'unchanged'}`] };
      }
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|172.18.0.2'] };
      return { exitCode: 0, lines: [] };
    });

    await syncNodeProxy(db, 4);
    expect(opsIssued()).toContain('proxy.ensure');
  });

  it('reports an unreachable node without throwing into the deploy', async () => {
    h.agentOp.mockReset();
    h.agentOp.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const lines: string[] = [];

    const res = await syncNodeProxy(db, 4, (l) => lines.push(l));

    // A node that cannot be refreshed keeps serving its previous routing; the
    // deployment must not fail for it, because the container IS running.
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/ECONNREFUSED/);
    expect(lines.join('\n')).toMatch(/keeps serving its previous routing/);
  });

  it('r416: says the node is DARK when the proxy.ensure step itself failed', async () => {
    // proxy.ensure recreates the node's only proxy with rm+run; when THAT op
    // fails the old "keeps serving its previous routing" line was a lie in
    // exactly the case an operator needs the truth.
    h.agentOp.mockReset();
    h.agentOp.mockImplementation(async (_db: unknown, _id: unknown, op: string) => {
      if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x changed'] };
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|172.18.0.2'] };
      if (op === 'proxy.ensure') throw new Error('agent proxy.ensure failed (500): image pull refused');
      return { exitCode: 0, lines: [] };
    });
    const lines: string[] = [];

    const res = await syncNodeProxy(db, 4, (l) => lines.push(l));

    expect(res.ok).toBe(false);
    expect(lines.join('\n')).toMatch(/PROXY IS DOWN/);
    expect(lines.join('\n')).not.toMatch(/keeps serving its previous routing/);
  });
});

describe('syncNodeProxy — inline certificates (0.14)', () => {
  it('warns above 512 KiB, well before the agent refuses 1 MiB', async () => {
    h.agentOp.mockReset();
    agentSteady();
    const lines: string[] = [];
    h.renderDynamicConfig.mockResolvedValueOnce('x'.repeat(600 * 1024));
    await expect(syncNodeProxy(db, 4, (l) => lines.push(l))).resolves.toEqual({ ok: true });
    expect(lines.join('\n')).toMatch(/node #4 is 600 KiB .*refuses anything above 1 MiB/);
    lines.length = 0;
    await syncNodeProxy(db, 4, (l) => lines.push(l));
    expect(lines.join('\n')).not.toMatch(/KiB/);
  });
});

describe('syncAllNodeProxies', () => {
  it('visits each node once and keeps going after one fails', async () => {
    h.agentOp.mockReset();
    h.agentOp.mockImplementation(async (_db: unknown, id: unknown, op: string) => {
      if (id === 2) throw new Error('node 2 is down');
      if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|172.18.0.2'] };
      return { exitCode: 0, lines: [] };
    });

    const results = await syncAllNodeProxies(db, [1, 2, 3, 1]);

    const visited = new Set(h.agentOp.mock.calls.map((c) => (c as unknown[])[1] as number));
    expect([...visited].sort()).toEqual([1, 2, 3]);
    // r521: the per-node outcome reaches the caller (writeDynamicConfig fails
    // a deploy whose own node is the one that failed).
    expect(results.map((r) => [r.serverId, r.ok])).toEqual([[1, true], [2, false], [3, true]]);
    expect(results[1]!.reason).toMatch(/node 2 is down/);
  });

  it('ignores ids that are not real server rows', async () => {
    h.agentOp.mockReset();
    agentSteady();

    await syncAllNodeProxies(db, [0, -1, Number.NaN]);

    expect(h.agentOp).not.toHaveBeenCalled();
  });
});

describe('confirmed node routing transitions', () => {
  function currentAgent() {
    h.agentOp.mockReset(); h.agentTransportSealed.mockResolvedValue(true);
    h.agentOp.mockImplementation(async (_db: unknown, _id: unknown, op: string) => {
      if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT {"version":"0.17.2","caps":["proxy.routingAck"]}'] };
      if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|172.18.0.2'] };
      if (op === 'proxy.confirmRouting') return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update('http: {}').digest('hex')}`] };
      return { exitCode: 0, lines: [] };
    });
  }

  it('requires a generation receipt after sending the augmented routing file', async () => {
    currentAgent();
    await expect(syncNodeProxy(db, 4, undefined, { confirmRouting: true } as never)).resolves.toEqual({ ok: true });
    expect(opsIssued()).toEqual(['agent.ping', 'proxy.writeConfig', 'proxy.writeConfig', 'docker.inspect', 'proxy.confirmRouting']);
    const dynamic = h.agentOp.mock.calls.filter(c => (c as unknown[])[2] === 'proxy.writeConfig')[1] as unknown[];
    expect((dynamic[3] as { content: string }).content).toContain('nd_routing_ack_tls');
    expect(h.agentOp).toHaveBeenCalledWith(db, 4, 'proxy.confirmRouting', { content: 'http: {}' }, expect.any(Function));
  });

  it('refuses an older agent before modifying its routing', async () => {
    currentAgent();
    h.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ND-AGENT {"version":"0.17.1","caps":[]}'] });
    const result = await syncNodeProxy(db, 4, undefined, { confirmRouting: true } as never);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/Update the node agent.*0\.18\.0/) });
    expect(opsIssued()).toEqual(['agent.ping']);
  });

  it('never sends private routing confirmation content over plaintext', async () => {
    currentAgent(); h.agentTransportSealed.mockResolvedValueOnce(false);
    await expect(syncNodeProxy(db, 4, undefined, { confirmRouting: true } as never)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/unencrypted|sealed/) });
    expect(h.agentOp).not.toHaveBeenCalled();
  });

  it('marks a lost dynamic-write response as an unknown routing outcome', async () => {
    currentAgent();
    h.agentOp.mockImplementation(async (_db: unknown, _id: unknown, op: string, params: unknown) => {
      if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT {"caps":["proxy.routingAck"]}'] };
      if (op === 'proxy.writeConfig' && (params as { kind: string }).kind === 'dynamic') throw new Error('response lost after write');
      return { exitCode: 0, lines: [] };
    });
    const lines: string[] = [];
    await expect(syncNodeProxy(db, 4, s => lines.push(s), { confirmRouting: true } as never)).resolves.toMatchObject({ ok: false, routingUnconfirmed: true });
    expect(lines.join('\n')).not.toContain('keeps serving its previous routing');
  });

  it('does not accept a stale receipt or empty success from the agent', async () => {
    currentAgent();
    h.agentOp.mockImplementation(async (_db: unknown, _id: unknown, op: string) => {
      if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT {"caps":["proxy.routingAck"]}'] };
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
      return { exitCode: 0, lines: [] };
    });
    await expect(syncNodeProxy(db, 4, undefined, { confirmRouting: true } as never)).resolves.toMatchObject({ ok: false, routingUnconfirmed: true });
  });

  it('requires confirmation only from the selected node in a fleet refresh', async () => {
    currentAgent();
    await expect(syncAllNodeProxies(db, [3, 4], undefined, { confirmNode: 4 } as never)).resolves.toEqual([{ serverId: 3, ok: true }, { serverId: 4, ok: true }]);
    const confirmed = h.agentOp.mock.calls.filter(c => (c as unknown[])[2] === 'proxy.confirmRouting');
    expect(confirmed.map(c => (c as unknown[])[1])).toEqual([4]);
  });
});
