/**
 * G5.8 node tunnels, the paths nodeTunnel.test.ts leaves open: the panel's
 * NodeTunnelStream against a hand-driven socket (bad frames, flow control both
 * ways, close/error handling), `openNodeTunnel` with the agent client and the
 * capability check mocked and a fake socket factory, and the agent's
 * `attachTunnelChannel` against a hand-driven `ws` socket. No network, no Docker.
 */
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NINEDEPLOY_MASTER_KEY = 'ab'.repeat(32);
});

const capture = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 'service\ttrue\n'));
vi.mock('../src/lib/exec.js', async (orig) => ({ ...(await orig<object>()), capture }));
const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
const streamMock = vi.hoisted(() => vi.fn((..._a: unknown[]) => ({ helper: true })));
vi.mock('../src/lib/spawnValidated.js', async (orig) => ({ ...(await orig<object>()), spawnValidated: spawnMock, spawnValidatedStream: streamMock }));
const agentOp = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ exitCode: 0, lines: [] as string[] })));
const agentTransportSealed = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true));
vi.mock('../src/lib/agentClient.js', async (orig) => ({ ...(await orig<object>()), agentOp, agentTransportSealed }));
const assertNodeCapability = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
vi.mock('../src/lib/agentCapabilities.js', async (orig) => ({ ...(await orig<object>()), assertNodeCapability }));

const { servers } = await import('@ninedeploy/db');
const registry = await import('../src/agentOps/index.js');
const tunnels = await import('../src/agentOps/tunnels.js');
const { NodeTunnelStream, parseTunnelChannel, openNodeTunnel, assertNodeTunnels } = await import('../src/lib/nodeTunnel.js');
const { deriveFrameKey, FrameOpener, FrameSealer, TUNNEL_HKDF_INFO } = await import('../src/lib/agentFrameCipher.js');
const { TUNNEL_FRAME, TUNNEL_FRAME_TYPES, TUNNEL_PROTOCOL_PREFIX } = await import('../src/lib/nodeTunnelProtocol.js');
const { encrypt, sha256 } = await import('../src/lib/crypto.js');
const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');

type Listener = (ev?: unknown) => void;

/** The panel's WHATWG-style socket, driven by hand. */
function panelSocket() {
  const listeners: Record<string, Listener[]> = {};
  const s = {
    readyState: 1,
    binaryType: 'blob',
    bufferedAmount: 0,
    sent: [] as Buffer[],
    closed: [] as Array<number | undefined>,
    throwOnClose: false,
    send(data: Uint8Array) {
      s.sent.push(Buffer.from(data));
    },
    close(code?: number) {
      s.closed.push(code);
      if (s.throwOnClose) throw new Error('already closed');
      s.readyState = 3;
    },
    addEventListener(type: string, cb: Listener) {
      listeners[type] ??= [];
      listeners[type].push(cb);
    },
    emit(type: string, ev?: unknown) {
      for (const cb of listeners[type] ?? []) cb(ev);
    },
  };
  return s;
}

const KEY = Buffer.alloc(32, 9);

/** A stream on a fresh socket, plus the agent's sealer and an opener for what the panel sent. */
function panelStream(setup?: (s: ReturnType<typeof panelSocket>) => void) {
  const sock = panelSocket();
  setup?.(sock);
  const stream = new NodeTunnelStream(sock as never, KEY);
  const agentTx = new FrameSealer(KEY, 'agent');
  const panelRx = new FrameOpener(KEY, 'panel', TUNNEL_FRAME_TYPES);
  let seen = 0;
  /** Frame types the panel sent since the last call. */
  const sentTypes = () => {
    const out = sock.sent.slice(seen).map((f) => panelRx.open(f));
    seen = sock.sent.length;
    return out;
  };
  const deliver = (type: number, payload?: Buffer) => sock.emit('message', { data: new Uint8Array(agentTx.seal(type as never, payload)) });
  return { sock, stream, agentTx, sentTypes, deliver };
}

describe('parseTunnelChannel', () => {
  const salt = Buffer.alloc(32, 1).toString('base64');
  const channel = 'a'.repeat(32);

  it('takes the first ND-TUNNEL line and checks the channel id and salt', () => {
    expect(parseTunnelChannel(['noise', `ND-TUNNEL ${JSON.stringify({ channel, salt })}`])).toEqual({ channel, salt: Buffer.alloc(32, 1) });
    expect(parseTunnelChannel([])).toBeNull();
    expect(parseTunnelChannel(['ND-TUNNEL{"channel":"x"}', 'other'])).toBeNull();
    expect(parseTunnelChannel(['ND-TUNNEL not json'])).toBeNull();
    expect(parseTunnelChannel([`ND-TUNNEL ${JSON.stringify({ channel: 'A'.repeat(32), salt })}`])).toBeNull();
    expect(parseTunnelChannel([`ND-TUNNEL ${JSON.stringify({ channel: 7, salt })}`])).toBeNull();
    expect(parseTunnelChannel([`ND-TUNNEL ${JSON.stringify({ channel })}`])).toBeNull();
    expect(parseTunnelChannel([`ND-TUNNEL ${JSON.stringify({ channel, salt: Buffer.alloc(16).toString('base64') })}`])).toBeNull();
    // Only the first ND-TUNNEL line counts: a bad one is not rescued by a later good one.
    expect(parseTunnelChannel(['ND-TUNNEL {', `ND-TUNNEL ${JSON.stringify({ channel, salt })}`])).toBeNull();
  });
});

describe('NodeTunnelStream', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates with a resume frame and delivers data frames as bytes', async () => {
    const { stream, sentTypes, deliver, sock } = panelStream();
    expect(sentTypes()).toEqual([{ type: TUNNEL_FRAME.resume, payload: Buffer.alloc(0) }]);
    const got: Buffer[] = [];
    stream.on('data', (b: Buffer) => got.push(b));
    deliver(TUNNEL_FRAME.data, Buffer.from('abc'));
    deliver(TUNNEL_FRAME.data, Buffer.alloc(0)); // empty: nothing pushed
    await vi.waitFor(() => expect(Buffer.concat(got).toString()).toBe('abc'));
    expect(got).toHaveLength(1);
    // A close frame ends the readable side and closes the socket.
    const ended = new Promise((r) => stream.on('end', r));
    const closed = new Promise((r) => stream.on('close', r));
    deliver(TUNNEL_FRAME.close);
    await Promise.all([ended, closed]);
    expect(sock.closed).toEqual([1000]);
    // Messages after the end are ignored.
    deliver(TUNNEL_FRAME.data, Buffer.from('late'));
    expect(Buffer.concat(got).toString()).toBe('abc');
  });

  it('reads ArrayBuffer messages', async () => {
    const { stream, sock, agentTx } = panelStream();
    const frame = agentTx.seal(TUNNEL_FRAME.data, Buffer.from('xyz'));
    const ab = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    const got: Buffer[] = [];
    stream.on('data', (b: Buffer) => got.push(b));
    sock.emit('message', { data: ab });
    await vi.waitFor(() => expect(Buffer.concat(got).toString()).toBe('xyz'));
  });

  it('fails on a text message', async () => {
    const { stream, sock } = panelStream();
    const err = new Promise<Error>((r) => stream.on('error', r));
    sock.emit('message', { data: 'hello' });
    expect((await err).message).toBe('the node tunnel sent a bad frame');
    expect(sock.closed).toEqual([1000]);
  });

  it('fails on a frame sealed under another key', async () => {
    const { stream, sock } = panelStream();
    const err = new Promise<Error>((r) => stream.on('error', r));
    const wrong = new FrameSealer(Buffer.alloc(32, 1), 'agent');
    sock.emit('message', { data: new Uint8Array(wrong.seal(TUNNEL_FRAME.data, Buffer.from('x'))) });
    expect((await err).message).toBe('the node tunnel sent a bad frame');
  });

  it('fails on a socket error, even when closing the socket throws', async () => {
    const { stream, sock } = panelStream();
    sock.throwOnClose = true;
    const err = new Promise<Error>((r) => stream.on('error', r));
    sock.emit('error');
    expect((await err).message).toBe('the node tunnel failed');
    expect(sock.closed).toEqual([1000]);
    // A later close event is a no-op.
    sock.emit('close');
    expect(sock.closed).toEqual([1000]);
  });

  it('ends cleanly when the socket closes', async () => {
    const { stream, sock } = panelStream();
    stream.resume();
    const closed = new Promise((r) => stream.on('close', r));
    sock.emit('close');
    await closed;
    expect(stream.destroyed).toBe(true);
  });

  it('refuses to open on a socket that is not open, even when close throws', () => {
    const sock = panelSocket();
    sock.readyState = 0;
    sock.throwOnClose = true;
    expect(() => new NodeTunnelStream(sock as never, KEY)).toThrow('could not authenticate the node tunnel');
    expect(sock.sent).toHaveLength(0);
    expect(sock.closed).toEqual([undefined]);
  });

  it('fails a held write with "closed" when the tunnel is destroyed without an error', async () => {
    const { stream, deliver } = panelStream();
    deliver(TUNNEL_FRAME.pause);
    const cb = vi.fn();
    stream.on('error', () => undefined);
    stream.write(Buffer.from('held'), cb);
    await new Promise((r) => setImmediate(r));
    stream.destroy();
    await vi.waitFor(() => expect(cb).toHaveBeenCalled());
    expect((cb.mock.calls[0]![0] as Error).message).toBe('the node tunnel is closed');
  });

  it('holds writes while the agent is paused and releases them on resume', async () => {
    // A socket that does not report bufferedAmount counts as empty.
    const { stream, sentTypes, deliver } = panelStream((s) => {
      delete (s as { bufferedAmount?: number }).bufferedAmount;
    });
    sentTypes();
    deliver(TUNNEL_FRAME.pause);
    const cb = vi.fn();
    stream.write(Buffer.from('held'), cb);
    // The bytes go out; only the callback waits.
    expect(sentTypes()).toEqual([{ type: TUNNEL_FRAME.data, payload: Buffer.from('held') }]);
    await new Promise((r) => setImmediate(r));
    expect(cb).not.toHaveBeenCalled();
    deliver(TUNNEL_FRAME.resume);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    expect(cb.mock.calls[0]?.[0]).toBeFalsy();
    // Not paused any more: the next write settles straight away.
    const cb2 = vi.fn();
    stream.write(Buffer.from('free'), cb2);
    await vi.waitFor(() => expect(cb2).toHaveBeenCalledTimes(1));
    stream.destroy();
  });

  it('keeps holding a write on resume while the socket buffer is still full, then polls it free', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { stream, sock, deliver } = panelStream();
    sock.bufferedAmount = 5 * 1024 * 1024;
    const cb = vi.fn();
    stream.write(Buffer.from('x'), cb);
    await new Promise((r) => setImmediate(r));
    deliver(TUNNEL_FRAME.resume); // agent not paused, but the buffer is still high
    vi.advanceTimersByTime(200);
    await new Promise((r) => setImmediate(r));
    expect(cb).not.toHaveBeenCalled();
    sock.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    await new Promise((r) => setImmediate(r));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toBeFalsy();
    stream.destroy();
  });

  it('fails a write that cannot be sent, and a write after the tunnel closed', async () => {
    const { stream, sock } = panelStream();
    stream.on('error', () => undefined);
    sock.readyState = 3;
    const err = await new Promise<Error | null | undefined>((r) => stream.write(Buffer.from('x'), r));
    expect(err?.message).toBe('could not send data through the node tunnel');
    // _write after the end is refused outright.
    const { stream: s2 } = panelStream();
    s2.destroy();
    const cb = vi.fn();
    (s2 as unknown as { _write: (c: Buffer, e: string, cb: (e?: Error | null) => void) => void })._write(Buffer.from('x'), 'buffer', cb);
    expect(cb.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((cb.mock.calls[0]![0] as Error).message).toBe('the node tunnel is closed');
  });

  it('sends a close frame on destroy, swallowing a throwing close', () => {
    const { stream, sock, sentTypes } = panelStream();
    sentTypes();
    sock.throwOnClose = true;
    stream.destroy();
    expect(sentTypes().map((f) => f.type)).toEqual([TUNNEL_FRAME.close]);
    expect(sock.closed).toEqual([1000]);
  });

  it('asks the agent to pause when the reader falls behind, and to resume when it reads again', async () => {
    const { stream, sentTypes, deliver } = panelStream();
    sentTypes();
    deliver(TUNNEL_FRAME.data, Buffer.alloc(2 * 1024 * 1024, 1));
    deliver(TUNNEL_FRAME.data, Buffer.alloc(16, 2)); // still over: no second pause
    expect(sentTypes().map((f) => f.type)).toEqual([TUNNEL_FRAME.pause]);
    let total = 0;
    stream.on('data', (b: Buffer) => (total += b.length));
    await vi.waitFor(() => expect(total).toBe(2 * 1024 * 1024 + 16));
    expect(sentTypes().map((f) => f.type)).toContain(TUNNEL_FRAME.resume);
    stream.destroy();
  });
});

describe('openNodeTunnel', () => {
  let db: Awaited<ReturnType<typeof migratedDb>>;
  const TOKEN = 'node-token-for-tunnels';
  const salt = Buffer.alloc(32, 5);
  const channel = 'b'.repeat(32);
  const tunnelLine = `ND-TUNNEL ${JSON.stringify({ channel, salt: salt.toString('base64') })}`;
  let v4Id: number;
  let v6Id: number;

  beforeAll(async () => {
    db = await migratedDb();
    const [a] = await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4601, tokenEncrypted: encrypt(TOKEN) }).returning();
    const [b] = await db.insert(servers).values({ name: 'edge-6', host: 'fd00::5', port: 4602, tokenEncrypted: encrypt(TOKEN) }).returning();
    v4Id = a!.id;
    v6Id = b!.id;
  });
  afterAll(() => closeMigratedDb(db));
  beforeEach(() => {
    agentOp.mockReset().mockResolvedValue({ exitCode: 0, lines: [tunnelLine] });
    agentTransportSealed.mockReset().mockResolvedValue(true);
    assertNodeCapability.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A factory whose socket fires `event` on the next microtask. */
  function factory(event: 'open' | 'error' | 'close' | null, opts: { throwOnClose?: boolean } = {}) {
    const made: Array<{ url: string; protocols: string[]; sock: ReturnType<typeof panelSocket> }> = [];
    const fn = vi.fn((url: string, protocols: string[]) => {
      const sock = panelSocket();
      sock.throwOnClose = !!opts.throwOnClose;
      made.push({ url, protocols, sock });
      if (event) queueMicrotask(() => sock.emit(event));
      return sock as never;
    });
    return { fn, made };
  }

  it('asks for the tunnel.tcp capability over the sealed transport', async () => {
    await assertNodeTunnels(db, v4Id);
    expect(assertNodeCapability).toHaveBeenCalledWith(db, v4Id, expect.objectContaining({ cap: 'tunnel.tcp', sealedRequired: true }));
  });

  it('opens a service tunnel whose first frame is sealed under the node key', async () => {
    const { fn, made } = factory('open');
    const stream = await openNodeTunnel(db, v4Id, { container: 'nd-svc-api', port: 8080 }, { socketFactory: fn });
    expect(agentOp).toHaveBeenCalledWith(db, v4Id, 'tunnel.open', { container: 'nd-svc-api', port: 8080 }, expect.any(Function));
    expect((agentOp.mock.calls[0]![4] as () => void)()).toBeUndefined();
    expect(made[0]!.url).toBe('ws://10.0.0.5:4601/agent/tunnel');
    expect(made[0]!.protocols).toEqual([`${TUNNEL_PROTOCOL_PREFIX}${channel}`]);
    expect(made[0]!.sock.binaryType).toBe('arraybuffer');
    const key = deriveFrameKey(sha256(TOKEN), salt, TUNNEL_HKDF_INFO);
    const rx = new FrameOpener(key, 'panel', TUNNEL_FRAME_TYPES);
    expect(rx.open(made[0]!.sock.sent[0]!).type).toBe(TUNNEL_FRAME.resume);
    // A later error event does not re-settle the open; it fails the stream.
    const err = new Promise<Error>((r) => stream.on('error', r));
    made[0]!.sock.emit('error');
    expect((await err).message).toBe('the node tunnel failed');
  });

  it('brackets an IPv6 host and names a database tunnel', async () => {
    const { fn, made } = factory('open');
    const stream = await openNodeTunnel(db, v6Id, { container: 'nd-db-pg', port: 5432, kind: 'database' }, { socketFactory: fn });
    expect(made[0]!.url).toBe('ws://[fd00::5]:4602/agent/tunnel');
    expect(agentOp.mock.calls[0]![3]).toEqual({ container: 'nd-db-pg', port: 5432, kind: 'database' });
    stream.destroy();
  });

  it('refuses a node that is gone, lacks the capability, or is unsealed', async () => {
    const { fn } = factory('open');
    await expect(openNodeTunnel(db, 9999, { container: 'c', port: 1 }, { socketFactory: fn })).rejects.toThrow('node #9999 no longer exists');
    assertNodeCapability.mockRejectedValueOnce(new Error('agent too old'));
    await expect(openNodeTunnel(db, v4Id, { container: 'c', port: 1 }, { socketFactory: fn })).rejects.toThrow('agent too old');
    agentTransportSealed.mockResolvedValueOnce(false);
    await expect(openNodeTunnel(db, v4Id, { container: 'c', port: 1 }, { socketFactory: fn })).rejects.toThrow(
      'the panel reaches node "edge-1" only over the unencrypted transport',
    );
    expect(agentOp).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses an answer without a channel line', async () => {
    const { fn } = factory('open');
    agentOp.mockResolvedValueOnce({ exitCode: 0, lines: ['ok'] });
    await expect(openNodeTunnel(db, v4Id, { container: 'c', port: 1 }, { socketFactory: fn })).rejects.toThrow(
      'the agent on node "edge-1" answered tunnel.open without a channel',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('fails when the socket errors or closes before it opened', async () => {
    const e = factory('error');
    await expect(openNodeTunnel(db, v4Id, { container: 'c', port: 1 }, { socketFactory: e.fn })).rejects.toThrow(
      'could not connect to the tunnel channel on node "edge-1"',
    );
    expect(e.made[0]!.sock.closed).toEqual([undefined]);
    const c = factory('close', { throwOnClose: true });
    await expect(openNodeTunnel(db, v4Id, { container: 'c', port: 1 }, { socketFactory: c.fn })).rejects.toThrow(
      'the agent on node "edge-1" refused the tunnel channel',
    );
    expect(c.made[0]!.sock.sent).toHaveLength(0);
  });

  it('gives up when the channel does not open within 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fn, made } = factory(null);
    const p = openNodeTunnel(db, v4Id, { container: 'c', port: 1 }, { socketFactory: fn });
    const outcome = p.then(
      () => null,
      (e: Error) => e,
    );
    await vi.waitFor(() => expect(fn).toHaveBeenCalled(), { interval: 1, timeout: 5000 });
    vi.advanceTimersByTime(9_999);
    await Promise.resolve();
    vi.advanceTimersByTime(1);
    const err = await outcome;
    expect(err?.message).toBe('the agent on node "edge-1" did not open the tunnel channel in time');
    expect(made[0]!.sock.closed).toEqual([undefined]);
    // A late open after the timeout settles nothing.
    made[0]!.sock.emit('open');
  });
});

describe('attachTunnelChannel', () => {
  const TOKEN_HASH = 'e'.repeat(64);
  let spawnHelper: typeof tunnels.tunnelDeps.spawnHelper;

  beforeEach(() => {
    capture.mockReset().mockResolvedValue('service\ttrue\n');
    spawnMock.mockClear();
    spawnHelper = tunnels.tunnelDeps.spawnHelper;
  });
  afterEach(() => {
    tunnels.tunnelDeps.spawnHelper = spawnHelper;
    tunnels.closeAllTunnelChannels();
    vi.useRealTimers();
  });

  const openChannel = async () => {
    const lines: string[] = [];
    await registry.runRegisteredOp('tunnel.open', { container: 'nd-svc-api', port: 8080 }, (l) => lines.push(l), { sealed: true }, {});
    return parseTunnelChannel(lines)!;
  };

  /** The agent's `ws` socket, driven by hand. */
  function agentSocket() {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const s = {
      readyState: 1,
      bufferedAmount: 0,
      sent: [] as Buffer[],
      closes: [] as Array<{ code?: number; reason?: string }>,
      throwOnSend: false,
      throwOnClose: false,
      send(d: Buffer) {
        if (s.throwOnSend) throw new Error('send failed');
        s.sent.push(d);
      },
      close(code?: number, reason?: string) {
        s.closes.push({ code, reason });
        if (s.throwOnClose) throw new Error('close failed');
        s.readyState = 3;
      },
      on(type: string, cb: (...a: unknown[]) => void) {
        handlers[type] ??= [];
        handlers[type].push(cb);
      },
      emit(type: string, ...a: unknown[]) {
        for (const cb of handlers[type] ?? []) cb(...a);
      },
    };
    return s;
  }

  function fakeHelper(stdin = new PassThrough()) {
    const stdout = new PassThrough();
    let exit!: (v: { code: number; stderr: string }) => void;
    const helper = { stdin, stdout, exit: new Promise<{ code: number; stderr: string }>((r) => (exit = r)), kill: vi.fn() };
    return { helper, exit: (code: number) => exit({ code, stderr: '' }) };
  }

  async function attached(stdin?: PassThrough) {
    const ch = await openChannel();
    const sock = agentSocket();
    const h = fakeHelper(stdin);
    tunnels.tunnelDeps.spawnHelper = vi.fn(() => h.helper as never);
    tunnels.attachTunnelChannel(sock, [`other`, `${TUNNEL_PROTOCOL_PREFIX}${ch.channel}`], TOKEN_HASH);
    const key = deriveFrameKey(TOKEN_HASH, ch.salt, TUNNEL_HKDF_INFO);
    const tx = new FrameSealer(key, 'panel');
    const rx = new FrameOpener(key, 'agent', TUNNEL_FRAME_TYPES);
    let seen = 0;
    const sentFrames = () => {
      const out = sock.sent.slice(seen).map((f) => rx.open(f));
      seen = sock.sent.length;
      return out;
    };
    const deliver = (type: number, payload?: Buffer) => sock.emit('message', tx.seal(type as never, payload), true);
    return { ch, sock, h, tx, sentFrames, deliver };
  }

  it('refuses tunnel.open outside a sealed request and beyond the channel cap', async () => {
    const run = tunnels.tunnelOps.ops['tunnel.open']!.run;
    await expect(run({ container: 'nd-svc-api', port: 80 }, () => undefined, { sealed: false })).rejects.toThrow(/unencrypted transport/);
    await expect(run({ port: 80 }, () => undefined, { sealed: true })).rejects.toThrow(/invalid container/);
    await expect(run({ container: 'x'.repeat(129), port: 80 }, () => undefined, { sealed: true })).rejects.toThrow(/invalid container/);
    await expect(run({ container: 'nd-svc-api', port: 80.5 }, () => undefined, { sealed: true })).rejects.toThrow(/invalid port/);
    await expect(run({ container: 'nd-svc-api', port: 65536 }, () => undefined, { sealed: true })).rejects.toThrow(/invalid port/);
    for (let i = 0; i < tunnels.TUNNEL_MAX_CHANNELS; i++) await openChannel();
    expect(tunnels.tunnelChannelCount()).toBe(tunnels.TUNNEL_MAX_CHANNELS);
    await expect(openChannel()).rejects.toThrow(/Too many open tunnels/);
    // An empty inspect answer is neither the kind nor running.
    tunnels.closeAllTunnelChannels();
    capture.mockResolvedValueOnce('');
    await expect(openChannel()).rejects.toThrow(/not a service container/);
  });

  it('drops a channel nobody attached within the TTL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await openChannel();
    // An attached, authenticated channel outlives the TTL.
    const { deliver, sock } = await attached();
    deliver(TUNNEL_FRAME.resume);
    expect(tunnels.tunnelChannelCount()).toBe(2);
    vi.advanceTimersByTime(tunnels.TUNNEL_CHANNEL_TTL_MS - 1);
    expect(tunnels.tunnelChannelCount()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(tunnels.tunnelChannelCount()).toBe(1);
    expect(sock.closes).toHaveLength(0);
  });

  it('closes a channel whose panel never authenticates', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sock, sentFrames } = await attached();
    vi.advanceTimersByTime(10_000);
    expect(sock.closes).toEqual([{ code: 1008, reason: 'channel not authenticated' }]);
    expect(sentFrames().map((f) => [f.type, f.payload.toString()])).toEqual([[TUNNEL_FRAME.close, 'channel not authenticated']]);
    expect(tunnels.tunnelDeps.spawnHelper).not.toHaveBeenCalled();
    expect(tunnels.tunnelChannelCount()).toBe(0);
  });

  it('starts the real helper as a long-lived docker run with a piped stdin', () => {
    const argv = tunnels.tunnelHelperArgv('nd-tunnel-x', 'nd-svc-api', 8080);
    expect(spawnHelper(argv)).toEqual({ helper: true });
    expect(streamMock).toHaveBeenCalledWith('docker', argv, { timeoutMs: 24 * 3600 * 1000, stdin: 'pipe' });
  });

  it('reads the channel id from a protocol header list only', () => {
    const id = 'f'.repeat(32);
    expect(tunnels.tunnelChannelId(`a, ${TUNNEL_PROTOCOL_PREFIX}${id}`)).toBe(id);
    expect(tunnels.tunnelChannelId(['a', `${TUNNEL_PROTOCOL_PREFIX}${id}`])).toBe(id);
    expect(tunnels.tunnelChannelId(undefined)).toBeNull();
    expect(tunnels.tunnelChannelId(`${TUNNEL_PROTOCOL_PREFIX}${id.toUpperCase()}`)).toBeNull();
    expect(tunnels.tunnelChannelId('nothing')).toBeNull();
    const sock = agentSocket();
    tunnels.attachTunnelChannel(sock, undefined, TOKEN_HASH);
    expect(sock.closes).toEqual([{ code: 1008, reason: 'unknown tunnel channel' }]);
  });

  it('shuts a channel on a text frame', async () => {
    const { sock, sentFrames, h } = await attached();
    sock.emit('message', Buffer.from('hi'), false);
    expect(sock.closes).toEqual([{ code: 1008, reason: 'text frames are not part of this protocol' }]);
    expect(sentFrames()[0]!.type).toBe(TUNNEL_FRAME.close);
    expect(h.helper.kill).not.toHaveBeenCalled();
    // Anything after the shut is ignored.
    sock.emit('message', Buffer.from('hi'), true);
    expect(sock.closes).toHaveLength(1);
  });

  it('accepts fragmented and ArrayBuffer frames, writes data to the helper and pipes its output back', async () => {
    const { sock, tx, sentFrames, h } = await attached();
    const auth = tx.seal(TUNNEL_FRAME.resume);
    sock.emit('message', [auth.subarray(0, 5), auth.subarray(5)], true);
    expect(tunnels.tunnelDeps.spawnHelper).toHaveBeenCalledTimes(1);
    expect((tunnels.tunnelDeps.spawnHelper as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual(expect.arrayContaining(['--network', 'container:nd-svc-api', '8080']));
    const data = tx.seal(TUNNEL_FRAME.data, Buffer.from('ping'));
    sock.emit('message', data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), true);
    sock.emit('message', tx.seal(TUNNEL_FRAME.data, Buffer.alloc(0)), true);
    expect(h.helper.stdin.read()?.toString()).toBe('ping');
    h.helper.stdout.write(Buffer.from('pong'));
    await vi.waitFor(() => expect(sentFrames().map((f) => f.payload.toString())).toContain('pong'));
  });

  it('pauses and resumes the helper output on the panel’s flow-control frames', async () => {
    const { deliver, h } = await attached();
    deliver(TUNNEL_FRAME.resume);
    expect(h.helper.stdout.isPaused()).toBe(false);
    deliver(TUNNEL_FRAME.pause);
    expect(h.helper.stdout.isPaused()).toBe(true);
    deliver(TUNNEL_FRAME.resume);
    expect(h.helper.stdout.isPaused()).toBe(false);
  });

  it('asks the panel to pause while the service reads slowly, and to resume on drain', async () => {
    const stdin = new PassThrough({ highWaterMark: 4 });
    const { deliver, sentFrames } = await attached(stdin);
    deliver(TUNNEL_FRAME.resume);
    deliver(TUNNEL_FRAME.data, Buffer.from('0123456789'));
    deliver(TUNNEL_FRAME.data, Buffer.from('more')); // already asked: one pause only
    expect(sentFrames().map((f) => f.type)).toEqual([TUNNEL_FRAME.pause]);
    stdin.resume();
    await vi.waitFor(() => expect(sentFrames().map((f) => f.type)).toEqual([TUNNEL_FRAME.resume]));
  });

  it('stops reading the service while the panel socket is backed up, until it drains', async () => {
    const { sock, deliver, h, sentFrames } = await attached();
    deliver(TUNNEL_FRAME.resume);
    sock.bufferedAmount = 5 * 1024 * 1024;
    h.helper.stdout.write(Buffer.from('bulk'));
    await vi.waitFor(() => expect(h.helper.stdout.isPaused()).toBe(true));
    expect(sentFrames().map((f) => f.payload.toString())).toEqual(['bulk']);
    // Still paused by pressure: a panel resume does not restart the output.
    deliver(TUNNEL_FRAME.resume);
    expect(h.helper.stdout.isPaused()).toBe(true);
    sock.bufferedAmount = 1024;
    await vi.waitFor(() => expect(h.helper.stdout.isPaused()).toBe(false));
  });

  it('ends the drain poll when the socket closes under pressure', async () => {
    const { sock, deliver, h } = await attached();
    deliver(TUNNEL_FRAME.resume);
    sock.bufferedAmount = 5 * 1024 * 1024;
    h.helper.stdout.write(Buffer.from('bulk'));
    await vi.waitFor(() => expect(h.helper.stdout.isPaused()).toBe(true));
    sock.readyState = 3; // closed without a close event yet
    await vi.waitFor(() => expect(h.helper.stdout.isPaused()).toBe(false));
  });

  it('closes on the panel’s close frame and kills the helper', async () => {
    const { sock, deliver, h, sentFrames } = await attached();
    deliver(TUNNEL_FRAME.resume);
    deliver(TUNNEL_FRAME.close);
    expect(sock.closes).toEqual([{ code: 1000, reason: 'closed by the panel' }]);
    expect(sentFrames().map((f) => f.type)).toEqual([TUNNEL_FRAME.close]);
    expect(h.helper.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('docker', ['rm', '-f', expect.stringMatching(/^nd-tunnel-[0-9a-f]{16}$/)], expect.any(Function));
    // Output after the close is dropped.
    h.helper.stdout.write(Buffer.from('late'));
    await new Promise((r) => setImmediate(r));
    expect(sock.sent.length).toBe(1);
  });

  it('reports a failed service connection when the helper exits non-zero', async () => {
    const { sock, deliver, h, sentFrames } = await attached();
    deliver(TUNNEL_FRAME.resume);
    h.exit(1);
    await vi.waitFor(() => expect(sock.closes).toEqual([{ code: 1000, reason: 'the connection to the service failed' }]));
    expect(sentFrames().map((f) => f.payload.toString())).toEqual(['the connection to the service failed']);
  });

  it('closes 1011 on a socket error, tolerating a throwing send and close', async () => {
    const { sock, deliver, h } = await attached();
    deliver(TUNNEL_FRAME.resume);
    sock.throwOnSend = true;
    sock.throwOnClose = true;
    h.helper.stdout.write(Buffer.from('dropped')); // send throws: swallowed
    await new Promise((r) => setImmediate(r));
    sock.emit('error');
    expect(sock.closes).toEqual([{ code: 1011, reason: '' }]);
    expect(h.helper.kill).toHaveBeenCalledTimes(1);
    expect(tunnels.tunnelChannelCount()).toBe(0);
    // The close event that follows is a no-op for the channel.
    sock.emit('close');
    expect(h.helper.kill).toHaveBeenCalledTimes(1);
  });

  it('sends nothing on a socket that already closed', async () => {
    const { sock, deliver } = await attached();
    deliver(TUNNEL_FRAME.resume);
    sock.readyState = 3;
    sock.emit('close');
    expect(sock.sent).toHaveLength(0);
    expect(sock.closes).toHaveLength(0);
    expect(tunnels.tunnelChannelCount()).toBe(0);
  });
});
