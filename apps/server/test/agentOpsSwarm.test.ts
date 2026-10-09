import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Multi-node T7, the agent side of Swarm (agentOps/swarm.ts, capability
 * `swarm`, design §7.7; security review M2): `swarm.info`, `swarm.join`,
 * `swarm.leave`, all sealed only, OPT-IN on the node through
 * `NINEDEPLOY_AGENT_SWARM_MANAGER=<host:port>`. `swarm.join` accepts only that
 * manager, refuses while `NINEDEPLOY_AGENT_DOCKER_SOCKET=off`, and hands the
 * token to the daemon through the Engine API — never an argv element. argv is
 * captured at the `spawnValidated` seam and the Engine API is a fake.
 */

const TOKEN = `SWMTKN-1-${'a1'.repeat(25)}-${'b2'.repeat(12)}z`;
const MANAGER = '10.0.0.1:2377';
const OPT_IN = { NINEDEPLOY_AGENT_SWARM_MANAGER: MANAGER };

const h = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('../src/lib/spawnValidated.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawnValidated.js')>()),
  spawnValidated: vi.fn(async (_exe: string, argv: string[], onLine: (l: string) => void) => {
    h.calls.push(argv);
    if (argv[0] === 'info') onLine('{"LocalNodeState":"active","NodeID":"node-abc","ControlAvailable":false}');
    return 0;
  }),
}));

const registry = await import('../src/agentOps/index.js');
const swarmMod = await import('../src/agentOps/swarm.js');
const { swarmOps, setEngineRequester, engineEndpoint } = swarmMod;
const agent = await import('../src/agent.js');

const engine = vi.fn(async (_m: string, _p: string, _b: unknown) => ({ status: 200, body: '' }));
const run = (op: string, params: Record<string, unknown>, sealed = true, env: NodeJS.ProcessEnv = OPT_IN) => {
  const lines: string[] = [];
  return registry.runRegisteredOp(op, params, (l) => lines.push(l), { sealed }, env).then((code) => ({ code, lines }));
};

beforeEach(() => {
  h.calls.length = 0;
  engine.mockClear();
  engine.mockImplementation(async () => ({ status: 200, body: '' }));
  setEngineRequester(engine);
  vi.stubEnv('NINEDEPLOY_AGENT_SWARM_MANAGER', MANAGER);
  vi.stubEnv('NINEDEPLOY_AGENT_DOCKER_SOCKET', '');
});
afterEach(() => {
  setEngineRequester(null);
  vi.unstubAllEnvs();
});

describe('registration and the opt-in (M19, review M2)', () => {
  it('the swarm ops are registered in the T7 block, sealed only', () => {
    expect(registry.AGENT_OP_MODULES).toContain(swarmOps);
    expect(registry.registeredCapabilities()).toContain('swarm');
    expect(agent.AGENT_CAPABILITIES).toContain('swarm');
    for (const op of ['swarm.info', 'swarm.join', 'swarm.leave']) {
      expect(registry.AGENT_OPS.get(op), op).toMatchObject({ cap: 'swarm', sealedOnly: true });
      expect(agent.agentMode.HANDLED_OPS.has(op), op).toBe(true);
    }
  });

  it('opt-in: unset NINEDEPLOY_AGENT_SWARM_MANAGER, the capability is not advertised and every op is refused before anything runs', async () => {
    expect(registry.advertisedCapabilities({})).not.toContain('swarm');
    expect(registry.advertisedCapabilities({ NINEDEPLOY_AGENT_SWARM_MANAGER: '  ' })).not.toContain('swarm');
    expect(registry.advertisedCapabilities(OPT_IN)).toContain('swarm');
    expect(registry.capabilityKillSwitch('swarm', {})).toBe('NINEDEPLOY_AGENT_SWARM_MANAGER');
    expect(registry.capabilityKillSwitch('swarm', OPT_IN)).toBeNull();
    for (const op of ['swarm.join', 'swarm.leave', 'swarm.info']) {
      await expect(run(op, op === 'swarm.join' ? { token: TOKEN, managerAddr: MANAGER } : {}, true, {}), op).rejects.toThrow(
        /not enabled on this node: its owner has not opted in \(NINEDEPLOY_AGENT_SWARM_MANAGER is not set\)/,
      );
    }
    expect(h.calls).toEqual([]);
    expect(engine).not.toHaveBeenCalled();
  });

  it('refuses the unencrypted transport for every swarm op (the join token is a cluster credential)', async () => {
    for (const [op, params] of [
      ['swarm.join', { token: TOKEN, managerAddr: MANAGER }],
      ['swarm.info', {}],
      ['swarm.leave', {}],
    ] as const) {
      await expect(run(op, params, false), op).rejects.toThrow(/only inside a sealed request/);
    }
    expect(h.calls).toEqual([]);
    expect(engine).not.toHaveBeenCalled();
  });
});

describe('swarm.info / swarm.join / swarm.leave', () => {
  it('swarm.info prints the node’s swarm state as one JSON line', async () => {
    const res = await run('swarm.info', {});
    expect(h.calls).toEqual([['info', '--format', '{{json .Swarm}}']]);
    expect(res.lines).toEqual(['{"LocalNodeState":"active","NodeID":"node-abc","ControlAvailable":false}']);
  });

  it('swarm.join goes through the Engine API (POST /swarm/join): the token is never an argv element', async () => {
    const res = await run('swarm.join', { token: TOKEN, managerAddr: MANAGER });
    expect(res.code).toBe(0);
    expect(h.calls).toEqual([]);
    expect(engine).toHaveBeenCalledWith('POST', '/swarm/join', { ListenAddr: '0.0.0.0:2377', AdvertiseAddr: '', DataPathAddr: '', RemoteAddrs: [MANAGER], JoinToken: TOKEN });
    expect(res.lines.join('\n')).not.toContain(TOKEN);
  });

  it('swarm.join accepts only the manager its owner named', async () => {
    await expect(run('swarm.join', { token: TOKEN, managerAddr: '10.9.9.9:2377' })).rejects.toThrow(/joins only the manager its owner named \(NINEDEPLOY_AGENT_SWARM_MANAGER=10\.0\.0\.1:2377\)/);
    expect(engine).not.toHaveBeenCalled();
  });

  it('swarm.join is refused while NINEDEPLOY_AGENT_DOCKER_SOCKET=off (a manager could mount the socket)', async () => {
    vi.stubEnv('NINEDEPLOY_AGENT_DOCKER_SOCKET', 'off');
    await expect(run('swarm.join', { token: TOKEN, managerAddr: MANAGER })).rejects.toThrow(/NINEDEPLOY_AGENT_DOCKER_SOCKET=off/);
    expect(engine).not.toHaveBeenCalled();
  });

  it('a daemon refusal fails the op with the token masked', async () => {
    engine.mockImplementation(async () => ({ status: 500, body: JSON.stringify({ message: `rpc error: invalid join token ${TOKEN}` }) }));
    const res = await run('swarm.join', { token: TOKEN, managerAddr: MANAGER });
    expect(res.code).toBe(1);
    expect(res.lines.join('\n')).toMatch(/swarm join failed \(500\): rpc error: invalid join token SWMTKN-1-\*\*\*/);
    expect(res.lines.join('\n')).not.toContain(TOKEN);
  });

  it('swarm.join validates every operand before anything is sent', async () => {
    for (const params of [
      { token: 'not-a-token', managerAddr: MANAGER },
      { token: `${TOKEN} --advertise-addr 1.2.3.4`, managerAddr: MANAGER },
      { token: TOKEN, managerAddr: '--help:2377' },
      { token: TOKEN, managerAddr: '10.0.0.1' },
      { token: TOKEN, managerAddr: '10.0.0.1:99999' },
      { token: TOKEN, managerAddr: MANAGER, listenAddr: '0.0.0.0' },
      { managerAddr: MANAGER },
    ]) {
      await expect(run('swarm.join', params), JSON.stringify(params)).rejects.toThrow(/Invalid/);
    }
    expect(engine).not.toHaveBeenCalled();
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

  it('the Engine API endpoint follows DOCKER_HOST (socket or plain tcp); a TLS DOCKER_HOST is refused', () => {
    expect(engineEndpoint({ DOCKER_HOST: 'unix:///run/docker.sock' })).toEqual({ socketPath: '/run/docker.sock' });
    expect(engineEndpoint({ DOCKER_HOST: 'tcp://dind:2375' })).toEqual({ host: 'dind', port: 2375 });
    expect(() => engineEndpoint({ DOCKER_HOST: 'tcp://dind:2376', DOCKER_TLS_VERIFY: '1' })).toThrow(/does not support a TLS DOCKER_HOST/);
    expect(() => engineEndpoint({ DOCKER_HOST: 'ssh://x' })).toThrow(/Unsupported DOCKER_HOST/);
  });
});
