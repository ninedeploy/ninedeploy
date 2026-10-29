/**
 * G5.8 node tunnels: the agent's `tunnel.open` and `/agent/tunnel` channel
 * (agentOps/tunnels.ts) wired in memory to the panel's NodeTunnelStream
 * (lib/nodeTunnel.ts). The helper container is a PassThrough echo; nothing
 * reaches Docker.
 */
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 'service\ttrue\n'));
vi.mock('../src/lib/exec.js', async (orig) => ({ ...(await orig<object>()), capture }));
const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', async (orig) => ({ ...(await orig<object>()), spawnValidated: spawnMock }));

const registry = await import('../src/agentOps/index.js');
const tunnels = await import('../src/agentOps/tunnels.js');
const { NodeTunnelStream, parseTunnelChannel } = await import('../src/lib/nodeTunnel.js');
const { deriveFrameKey, FrameSealer, TUNNEL_HKDF_INFO } = await import('../src/lib/agentFrameCipher.js');
const { TUNNEL_FRAME, TUNNEL_PROTOCOL_PREFIX } = await import('../src/lib/nodeTunnelProtocol.js');

const TOKEN_HASH = 'c'.repeat(64);

const open = async (params: Record<string, unknown>, sealed = true) => {
  const lines: string[] = [];
  await registry.runRegisteredOp('tunnel.open', params, (l) => lines.push(l), { sealed }, {});
  return lines;
};

/** An in-memory pair: the agent's `ws` socket and the panel's WHATWG one. */
function socketPair() {
  const agentHandlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const panelHandlers: Record<string, Array<(ev?: unknown) => void>> = {};
  const state = { open: true, agentClose: null as null | { code?: number; reason?: string } };
  const fire = (side: 'agent' | 'panel', type: string, ...args: unknown[]) =>
    queueMicrotask(() => (side === 'agent' ? agentHandlers[type] : panelHandlers[type])?.forEach((cb) => (cb as (...a: unknown[]) => void)(...args)));
  const shut = (code?: number, reason?: string) => {
    if (!state.open) return;
    state.open = false;
    state.agentClose = { code, reason };
    fire('agent', 'close');
    fire('panel', 'close');
  };
  const agent = {
    get readyState() {
      return state.open ? 1 : 3;
    },
    bufferedAmount: 0,
    send: (data: Buffer) => state.open && fire('panel', 'message', { data: new Uint8Array(data) }),
    close: shut,
    on: (type: string, cb: (...a: unknown[]) => void) => void (agentHandlers[type] ??= []).push(cb),
  };
  const panel = {
    get readyState() {
      return state.open ? 1 : 3;
    },
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    send: (data: Uint8Array) => state.open && fire('agent', 'message', Buffer.from(data), true),
    close: shut,
    addEventListener: (type: string, cb: (ev?: unknown) => void) => void (panelHandlers[type] ??= []).push(cb),
  };
  return { agent, panel, state };
}

/** A helper whose "service" echoes what it reads, upper-cased. */
function echoHelper() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let exit!: (v: { code: number; stderr: string }) => void;
  const helper = { stdin, stdout, exit: new Promise<{ code: number; stderr: string }>((r) => (exit = r)), kill: vi.fn(() => exit({ code: 143, stderr: '' })) };
  stdin.on('data', (b: Buffer) => stdout.write(Buffer.from(b.toString().toUpperCase())));
  return { helper, stop: () => exit({ code: 0, stderr: '' }) };
}

let spawnHelper: typeof tunnels.tunnelDeps.spawnHelper;
beforeEach(() => {
  capture.mockReset().mockResolvedValue('service\ttrue\n');
  spawnMock.mockClear();
  spawnHelper = tunnels.tunnelDeps.spawnHelper;
});
afterEach(() => {
  tunnels.tunnelDeps.spawnHelper = spawnHelper;
  tunnels.closeAllTunnelChannels();
});

describe('tunnel.open', () => {
  it('is sealed only, on tunnel.tcp, and switched off by the node owner', () => {
    expect(registry.AGENT_OPS.get('tunnel.open')).toMatchObject({ cap: 'tunnel.tcp', sealedOnly: true });
    expect(registry.capabilityKillSwitch('tunnel.tcp', { NINEDEPLOY_AGENT_TUNNELS: 'off' })).toBe('NINEDEPLOY_AGENT_TUNNELS');
  });

  it('opens a channel only to a running service container the panel started', async () => {
    const lines = await open({ container: 'nd-svc-api', port: 8080 });
    expect(parseTunnelChannel(lines)).toMatchObject({ channel: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(capture.mock.calls[0]![1]).toEqual(['inspect', '--format', tunnels.TUNNEL_INSPECT_FORMAT, 'nd-svc-api']);
    capture.mockResolvedValueOnce('database\ttrue\n');
    await expect(open({ container: 'nd-db-pg', port: 5432 })).rejects.toThrow(/not a service container/);
    capture.mockResolvedValueOnce('service\tfalse\n');
    await expect(open({ container: 'nd-svc-api', port: 8080 })).rejects.toThrow(/not running/);
    await expect(open({ container: '--privileged', port: 1 })).rejects.toThrow(/invalid container/);
    await expect(open({ container: 'nd-svc-api', port: 0 })).rejects.toThrow(/invalid port/);
    await expect(open({ container: 'nd-svc-api', port: '80' })).rejects.toThrow(/invalid port/);
  });

  it('runs the helper inside the container namespace only, without capabilities', () => {
    expect(tunnels.tunnelHelperArgv('nd-tunnel-x', 'nd-svc-api', 8080)).toEqual(
      expect.arrayContaining(['--network', 'container:nd-svc-api', '--cap-drop', 'ALL', '--read-only', 'nc', '127.0.0.1', '8080']),
    );
  });
});

describe('the tunnel channel', () => {
  async function attach(header?: string) {
    const lines = await open({ container: 'nd-svc-api', port: 8080 });
    const ch = parseTunnelChannel(lines)!;
    const pair = socketPair();
    tunnels.attachTunnelChannel(pair.agent, header ?? `${TUNNEL_PROTOCOL_PREFIX}${ch.channel}`, TOKEN_HASH);
    return { ch, pair, key: deriveFrameKey(TOKEN_HASH, ch.salt, TUNNEL_HKDF_INFO) };
  }

  it('carries bytes both ways once the panel proved the key, and closes when the service does', async () => {
    const { helper, stop } = echoHelper();
    tunnels.tunnelDeps.spawnHelper = vi.fn(() => helper as never);
    const { pair, key } = await attach();
    const stream = new NodeTunnelStream(pair.panel as never, key);
    const got: Buffer[] = [];
    stream.on('data', (b: Buffer) => got.push(b));
    stream.write(Buffer.from('hello'));
    await vi.waitFor(() => expect(Buffer.concat(got).toString()).toBe('HELLO'));
    expect(tunnels.tunnelDeps.spawnHelper).toHaveBeenCalledTimes(1);
    const closed = new Promise((r) => stream.on('close', r));
    stop();
    await closed;
    expect(pair.state.open).toBe(false);
    expect(tunnels.tunnelChannelCount()).toBe(0);
  });

  it('starts nothing for a peer without the key, an unknown channel or a reused one', async () => {
    tunnels.tunnelDeps.spawnHelper = vi.fn();
    const { ch, pair } = await attach();
    const wrong = new FrameSealer(deriveFrameKey('d'.repeat(64), ch.salt, TUNNEL_HKDF_INFO), 'panel');
    pair.panel.send(wrong.seal(TUNNEL_FRAME.resume));
    await vi.waitFor(() => expect(pair.state.agentClose).toEqual({ code: 1008, reason: 'bad frame' }));
    expect(tunnels.tunnelDeps.spawnHelper).not.toHaveBeenCalled();
    // The channel is single use.
    const again = socketPair();
    tunnels.attachTunnelChannel(again.agent, `${TUNNEL_PROTOCOL_PREFIX}${ch.channel}`, TOKEN_HASH);
    expect(again.state.agentClose).toEqual({ code: 1008, reason: 'unknown tunnel channel' });
    const unknown = socketPair();
    tunnels.attachTunnelChannel(unknown.agent, `${TUNNEL_PROTOCOL_PREFIX}${'0'.repeat(32)}`, TOKEN_HASH);
    expect(unknown.state.agentClose).toEqual({ code: 1008, reason: 'unknown tunnel channel' });
  });

  it('kills the helper when the panel goes away', async () => {
    const { helper } = echoHelper();
    tunnels.tunnelDeps.spawnHelper = vi.fn(() => helper as never);
    const { pair, key } = await attach();
    const stream = new NodeTunnelStream(pair.panel as never, key);
    await vi.waitFor(() => expect(tunnels.tunnelDeps.spawnHelper).toHaveBeenCalled());
    stream.destroy();
    await vi.waitFor(() => expect(helper.kill).toHaveBeenCalled());
    expect(spawnMock.mock.calls.some((c) => (c[1] as string[])[0] === 'rm')).toBe(true);
  });
});
