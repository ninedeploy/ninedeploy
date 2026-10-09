import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Multi-node T7, the agent side of Swarm (agentOps/swarm.ts, capability
 * `swarm`, design §7.7): `swarm.info`, `swarm.join`, `swarm.leave`, all
 * sealed only, behind the node owner's `NINEDEPLOY_AGENT_SWARM` switch. argv
 * is captured at the `spawnValidated` seam; nothing reaches Docker.
 */

const TOKEN = `SWMTKN-1-${'a1'.repeat(25)}-${'b2'.repeat(12)}z`;

const h = vi.hoisted(() => ({ calls: [] as string[][], echo: '' }));
vi.mock('../src/lib/spawnValidated.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawnValidated.js')>()),
  spawnValidated: vi.fn(async (_exe: string, argv: string[], onLine: (l: string) => void) => {
    h.calls.push(argv);
    if (argv[0] === 'info') onLine('{"LocalNodeState":"active","NodeID":"node-abc","ControlAvailable":false}');
    if (h.echo) onLine(h.echo);
    return 0;
  }),
}));

const registry = await import('../src/agentOps/index.js');
const { swarmOps } = await import('../src/agentOps/swarm.js');
const agent = await import('../src/agent.js');

const run = (op: string, params: Record<string, unknown>, sealed = true, env: NodeJS.ProcessEnv = {}) => {
  const lines: string[] = [];
  return registry.runRegisteredOp(op, params, (l) => lines.push(l), { sealed }, env).then((code) => ({ code, lines }));
};

beforeEach(() => {
  h.calls.length = 0;
  h.echo = '';
});

describe('registration (M19)', () => {
  it('the swarm ops are registered in the T7 block, sealed only, and advertised as `swarm`', () => {
    expect(registry.AGENT_OP_MODULES).toContain(swarmOps);
    expect(registry.registeredCapabilities()).toContain('swarm');
    expect(agent.AGENT_CAPABILITIES).toContain('swarm');
    for (const op of ['swarm.info', 'swarm.join', 'swarm.leave']) {
      expect(registry.AGENT_OPS.get(op), op).toMatchObject({ cap: 'swarm', sealedOnly: true });
      expect(agent.agentMode.HANDLED_OPS.has(op), op).toBe(true);
    }
  });

  it("the node owner's switch removes the capability from the ping and refuses every op before anything runs", async () => {
    expect(registry.advertisedCapabilities({ NINEDEPLOY_AGENT_SWARM: 'off' })).not.toContain('swarm');
    expect(registry.advertisedCapabilities({})).toContain('swarm');
    await expect(run('swarm.join', { token: TOKEN, managerAddr: '10.0.0.1:2377' }, true, { NINEDEPLOY_AGENT_SWARM: 'off' })).rejects.toThrow(/disabled on this node by its owner/);
    expect(h.calls).toEqual([]);
  });

  it('refuses the unencrypted transport for every swarm op (the join token is a cluster credential)', async () => {
    for (const [op, params] of [
      ['swarm.join', { token: TOKEN, managerAddr: '10.0.0.1:2377' }],
      ['swarm.info', {}],
      ['swarm.leave', {}],
    ] as const) {
      await expect(run(op, params, false), op).rejects.toThrow(/only inside a sealed request/);
    }
    expect(h.calls).toEqual([]);
  });
});

describe('swarm.info / swarm.join / swarm.leave', () => {
  it('swarm.info prints the node’s swarm state as one JSON line', async () => {
    const res = await run('swarm.info', {});
    expect(h.calls).toEqual([['info', '--format', '{{json .Swarm}}']]);
    expect(res.lines).toEqual(['{"LocalNodeState":"active","NodeID":"node-abc","ControlAvailable":false}']);
  });

  it('swarm.join runs `docker swarm join --token <t> <addr>` and never echoes the token', async () => {
    h.echo = `Error: join failed for ${TOKEN}`;
    const res = await run('swarm.join', { token: TOKEN, managerAddr: '10.0.0.1:2377' });
    expect(h.calls).toEqual([['swarm', 'join', '--token', TOKEN, '10.0.0.1:2377']]);
    expect(res.lines.join('\n')).not.toContain(TOKEN);
    expect(res.lines).toEqual(['Error: join failed for SWMTKN-1-***']);
    // An IPv6 manager in brackets and a hostname are fine.
    await run('swarm.join', { token: TOKEN, managerAddr: '[fd00::1]:2377' });
    await run('swarm.join', { token: TOKEN, managerAddr: 'panel.example.com:2377' });
  });

  it('swarm.join validates every operand before anything is spawned', async () => {
    for (const params of [
      { token: 'not-a-token', managerAddr: '10.0.0.1:2377' },
      { token: `${TOKEN} --advertise-addr 1.2.3.4`, managerAddr: '10.0.0.1:2377' },
      { token: TOKEN, managerAddr: '--help:2377' },
      { token: TOKEN, managerAddr: '10.0.0.1' },
      { token: TOKEN, managerAddr: '10.0.0.1:99999' },
      { token: TOKEN, managerAddr: '10.0.0.1:2377', listenAddr: '0.0.0.0' },
      { managerAddr: '10.0.0.1:2377' },
    ]) {
      await expect(run('swarm.join', params), JSON.stringify(params)).rejects.toThrow(/Invalid/);
    }
    expect(h.calls).toEqual([]);
  });

  it('swarm.leave never leaves by force', async () => {
    await run('swarm.leave', {});
    await run('swarm.leave', { force: false });
    expect(h.calls).toEqual([
      ['swarm', 'leave'],
      ['swarm', 'leave'],
    ]);
    await expect(run('swarm.leave', { force: true })).rejects.toThrow(/never leaves by force/);
    await expect(run('swarm.info', { verbose: true })).rejects.toThrow(/Invalid swarm param/);
    expect(h.calls).toHaveLength(2);
  });
});
