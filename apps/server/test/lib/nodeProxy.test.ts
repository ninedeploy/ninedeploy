import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  agentOp: vi.fn(async () => ({ exitCode: 0, lines: [] as string[] })),
  getAcmeEmail: vi.fn(async () => 'ops@example.com' as string | null),
  getDnsConfig: vi.fn(async () => ({ provider: null, token: null, wildcardApex: null })),
  renderStaticConfig: vi.fn(() => 'entryPoints: {}'),
  renderDynamicConfig: vi.fn(async () => 'http: {}'),
}));

vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: h.agentOp }));
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
