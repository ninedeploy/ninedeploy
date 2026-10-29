import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

/**
 * lib/agentTerminal.ts, the panel side of node terminals, against a fake
 * WebSocket (the injectable socketFactory) and a faked sealed agentOp:
 * parseTerminalChannel's refusals, AgentChannelTty's frame handling (early
 * output, exit, close, protocol violations, a failing socket, kill) and
 * openNodeTerminalTty's refusals, params, URL and connect outcomes. Agent
 * frames are sealed with the real cipher under the key the panel derives.
 */

const h = vi.hoisted(() => ({
  ops: [] as Array<{ serverId: number; op: string; params: Record<string, unknown>; opts: unknown }>,
  answer: { exitCode: 0, lines: [] as string[] },
  sealed: true,
  clientChecks: [] as number[],
}));

vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentTransportSealed: vi.fn(async () => h.sealed),
  agentOp: vi.fn(async (_db: unknown, serverId: number, op: string, params: Record<string, unknown>, _sink: unknown, opts?: unknown) => {
    h.ops.push({ serverId, op, params, opts });
    return h.answer;
  }),
}));
vi.mock('../src/lib/nodeDatabaseClient.js', () => ({
  assertNodeDatabaseClientSupport: vi.fn(async (_db: unknown, serverId: number) => {
    h.clientChecks.push(serverId);
  }),
}));

const { AgentChannelTty, AGENT_TERMINAL_PATH, AGENT_TERMINAL_PROTOCOL_PREFIX, openNodeTerminalTty, parseTerminalChannel } = await import('../src/lib/agentTerminal.js');
const { decodeResize, deriveFrameKey, encodeExit, FRAME_TYPE, FrameOpener, FrameSealer } = await import('../src/lib/agentFrameCipher.js');
const { encrypt, sha256 } = await import('../src/lib/crypto.js');

type Listener = (ev?: unknown) => void;
class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  sent: Buffer[] = [];
  closes: Array<number | undefined> = [];
  throwOnSend = false;
  throwOnClose = false;
  private listeners = new Map<string, Listener[]>();
  constructor(
    readonly url = '',
    readonly protocols: string[] = [],
  ) {}
  send(data: Uint8Array): void {
    if (this.throwOnSend) throw new Error('socket closing');
    this.sent.push(Buffer.from(data));
  }
  close(code?: number): void {
    this.closes.push(code);
    if (this.throwOnClose) throw new Error('already closed');
  }
  addEventListener(type: string, cb: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  emit(type: string, ev?: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
}

const SALT = randomBytes(32);
const CHANNEL = 'c'.repeat(32);
const TOKEN = 'node-token';
const KEY = deriveFrameKey(sha256(TOKEN), SALT);
const ndTerminal = (channel = CHANNEL, salt: Buffer | string = SALT) =>
  `ND-TERMINAL ${JSON.stringify({ channel, salt: typeof salt === 'string' ? salt : salt.toString('base64') })}`;

/** A live channel: the tty, its socket, the agent's sealer and an opener for what the panel sent. */
function channel(kind: 'container' | 'host' = 'container') {
  const socket = new FakeSocket();
  socket.readyState = 1;
  const tty = new AgentChannelTty(socket as never, KEY, kind);
  const agent = new FrameSealer(KEY, 'agent');
  const fromPanel = new FrameOpener(KEY, 'panel');
  const deliver = (frame: Buffer) => socket.emit('message', { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  const sentFrames = () => socket.sent.map((f) => fromPanel.open(f));
  return { socket, tty, agent, deliver, sentFrames };
}

beforeEach(() => {
  h.ops.length = 0;
  h.answer = { exitCode: 0, lines: [ndTerminal()] };
  h.sealed = true;
  h.clientChecks.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('parseTerminalChannel', () => {
  it('reads the first ND-TERMINAL line', () => {
    expect(parseTerminalChannel(['noise', ndTerminal(), ndTerminal('d'.repeat(32))])).toEqual({ channel: CHANNEL, salt: SALT });
  });

  it.each([
    ['no line', ['ok']],
    ['invalid JSON', ['ND-TERMINAL {nope']],
    ['an upper-case channel', [ndTerminal('C'.repeat(32))]],
    ['a short channel', [ndTerminal('c'.repeat(31))]],
    ['a non-string salt', [`ND-TERMINAL ${JSON.stringify({ channel: CHANNEL, salt: 5 })}`]],
    ['a salt of the wrong length', [ndTerminal(CHANNEL, randomBytes(16))]],
    ['a JSON null', ['ND-TERMINAL null']],
  ])('answers null for %s', (_what, lines) => {
    expect(parseTerminalChannel(lines)).toBeNull();
  });
});

describe('AgentChannelTty', () => {
  it('buffers output until a listener attaches, then streams it; empty data frames are dropped', () => {
    const { tty, agent, deliver } = channel();
    expect(tty.mode).toBe('exec');
    deliver(agent.seal(FRAME_TYPE.data, Buffer.from('he')));
    deliver(agent.seal(FRAME_TYPE.data, Buffer.alloc(0)));
    deliver(agent.seal(FRAME_TYPE.data, Buffer.from('llo')));
    const out: string[] = [];
    tty.onData((c) => void out.push(c.toString()));
    deliver(agent.seal(FRAME_TYPE.data, Buffer.from(' world')));
    expect(out).toEqual(['hello', ' world']);
    expect(tty.failure).toBeNull();
  });

  it('keeps at most 1 MiB of early output', () => {
    const { tty, agent, deliver } = channel();
    for (const frame of agent.sealData(Buffer.alloc(1024 * 1024 + 64 * 1024, 7))) deliver(frame);
    const out: Buffer[] = [];
    tty.onData((c) => void out.push(c));
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(1024 * 1024);
  });

  it('accepts a typed-array view at an offset as well as an ArrayBuffer', () => {
    const { socket, tty, agent } = channel();
    const out: string[] = [];
    tty.onData((c) => void out.push(c.toString()));
    const frame = agent.seal(FRAME_TYPE.data, Buffer.from('view'));
    const backing = new Uint8Array(frame.length + 3);
    backing.set(frame, 3);
    socket.emit('message', { data: backing.subarray(3) });
    expect(out).toEqual(['view']);
  });

  it('the exit frame carries the code to onEnd when the socket closes; later messages are ignored', () => {
    const { socket, tty, agent, deliver } = channel();
    const ends: Array<number | null> = [];
    tty.onEnd((c) => void ends.push(c));
    deliver(agent.seal(FRAME_TYPE.exit, encodeExit(42)));
    expect(ends).toEqual([]);
    socket.emit('close');
    socket.emit('error');
    expect(ends).toEqual([42]);
    const out: Buffer[] = [];
    tty.onData((c) => void out.push(c));
    deliver(agent.seal(FRAME_TYPE.data, Buffer.from('late')));
    expect(out).toEqual([]);
    // Already ended: onEnd answers at once.
    tty.onEnd((c) => void ends.push(c));
    expect(ends).toEqual([42, 42]);
  });

  it("the agent's close frame closes the socket (1000) and ends the session", () => {
    const { socket, tty, agent, deliver } = channel('host');
    expect(tty.mode).toBe('host');
    const ends: Array<number | null> = [];
    tty.onEnd((c) => void ends.push(c));
    deliver(agent.seal(FRAME_TYPE.close));
    expect(socket.closes).toEqual([1000]);
    expect(ends).toEqual([null]);
    expect(tty.failure).toBeNull();
  });

  it('a text message, a frame under another key, and a panel-only frame type are protocol failures', () => {
    const text = channel();
    text.socket.emit('message', { data: 'hello' });
    expect(text.tty.failure).toBe('protocol');
    expect(text.socket.closes).toEqual([1000]);

    const forged = channel();
    forged.deliver(new FrameSealer(randomBytes(32), 'agent').seal(FRAME_TYPE.data, Buffer.from('x')));
    expect(forged.tty.failure).toBe('auth');

    const short = channel();
    short.deliver(Buffer.from([1, 2, 3]));
    expect(short.tty.failure).toBe('malformed');

    const resize = channel();
    resize.socket.throwOnClose = true;
    const ends: Array<number | null> = [];
    resize.tty.onEnd((c) => void ends.push(c));
    resize.deliver(resize.agent.seal(FRAME_TYPE.resize, Buffer.from('{}')));
    expect(resize.tty.failure).toBe('protocol');
    expect(ends).toEqual([null]);
  });

  it('start, write, resize, pause and resume send sealed panel frames in order', () => {
    const { tty, sentFrames } = channel();
    tty.start(120, 40);
    tty.write(Buffer.from('ls\n'));
    tty.pause();
    tty.resume();
    const frames = sentFrames();
    expect(frames.map((f) => f.type)).toEqual([FRAME_TYPE.resize, FRAME_TYPE.data, FRAME_TYPE.pause, FRAME_TYPE.resume]);
    expect(decodeResize(frames[0]!.payload)).toEqual({ cols: 120, rows: 40 });
    expect(frames[1]!.payload.toString()).toBe('ls\n');
  });

  it('sends nothing on a socket that is not open, swallows a throwing send, and drops writes after the end', () => {
    const { socket, tty } = channel();
    socket.readyState = 0;
    tty.resize(80, 24);
    expect(socket.sent).toEqual([]);
    socket.readyState = 1;
    socket.throwOnSend = true;
    expect(() => tty.write(Buffer.from('x'))).not.toThrow();
    socket.throwOnSend = false;
    socket.emit('close');
    tty.write(Buffer.from('y'));
    tty.pause();
    expect(socket.sent).toEqual([]);
  });

  it('kill sends a close frame, closes the socket and resolves when the channel closes', async () => {
    const { socket, tty, sentFrames } = channel();
    const ends: Array<number | null> = [];
    tty.onEnd((c) => void ends.push(c));
    const killed = tty.kill();
    expect(sentFrames().map((f) => f.type)).toEqual([FRAME_TYPE.close]);
    expect(socket.closes).toEqual([1000]);
    socket.emit('close');
    await killed;
    expect(ends).toEqual([null]);
    // Idempotent: nothing more is sent.
    await tty.kill();
    expect(socket.sent).toHaveLength(1);
  });

  it('kill gives up after 2 s when the channel never closes, and never throws', async () => {
    vi.useFakeTimers();
    const { socket, tty } = channel();
    socket.throwOnClose = true;
    const ends: Array<number | null> = [];
    tty.onEnd((c) => void ends.push(c));
    let done = false;
    const killed = tty.kill().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await killed;
    expect(ends).toEqual([null]);
  });
});

describe('openNodeTerminalTty', () => {
  const server = { id: 3, name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt(TOKEN) };
  const dbWith = (row: unknown) => ({ query: { servers: { findFirst: vi.fn(async () => row) } } }) as unknown as DB;
  const target = (over: Record<string, unknown> = {}) => ({ kind: 'service' as const, serverId: 3, containerName: 'web-1', ...over }) as never;

  /** A socket factory that records the socket and runs `then` on it once created. */
  function factory(then: (s: FakeSocket) => void = (s) => queueMicrotask(() => s.open())) {
    const made: FakeSocket[] = [];
    const socketFactory = vi.fn((url: string, protocols: string[]) => {
      const s = new FakeSocket(url, protocols);
      made.push(s);
      then(s);
      return s as never;
    });
    return { made, socketFactory };
  }

  it('opens a container shell: the sealed op, the agent URL and subprotocol, then the initial size frame', async () => {
    const f = factory();
    const tty = await openNodeTerminalTty(dbWith(server), target(), { sessionId: 11, cols: 100, rows: 30, socketFactory: f.socketFactory });
    expect(h.ops).toEqual([{ serverId: 3, op: 'terminal.open', params: { kind: 'container', cols: 100, rows: 30, sessionId: 11, container: 'web-1' }, opts: undefined }]);
    expect(f.socketFactory).toHaveBeenCalledWith(`ws://10.0.0.5:4600${AGENT_TERMINAL_PATH}`, [`${AGENT_TERMINAL_PROTOCOL_PREFIX}${CHANNEL}`]);
    const socket = f.made[0]!;
    expect(socket.binaryType).toBe('arraybuffer');
    expect(tty.mode).toBe('exec');
    const first = new FrameOpener(KEY, 'panel').open(socket.sent[0]!);
    expect([first.type, decodeResize(first.payload)]).toEqual([FRAME_TYPE.resize, { cols: 100, rows: 30 }]);
  });

  it('a host shell names no container; an IPv6 node is bracketed in the URL', async () => {
    const f = factory();
    const tty = await openNodeTerminalTty(dbWith({ ...server, host: 'fd00::5' }), target({ kind: 'host', containerName: null }), { sessionId: 1, cols: 80, rows: 24, socketFactory: f.socketFactory });
    expect(h.ops[0]!.params).toEqual({ kind: 'host', cols: 80, rows: 24, sessionId: 1 });
    expect(f.made[0]!.url).toBe(`ws://[fd00::5]:4600${AGENT_TERMINAL_PATH}`);
    expect(tty.mode).toBe('host');
  });

  it('a database client checks its capability and sends the prepared client with a 60 s budget', async () => {
    const f = factory();
    const databaseClient = { databaseId: 9, containerId: 'f'.repeat(64), input: { engine: 'postgres' } };
    await openNodeTerminalTty(dbWith(server), target({ kind: 'database', containerName: 'nd-db-orders', databaseClient }), { sessionId: 2, cols: 80, rows: 24, socketFactory: f.socketFactory });
    expect(h.clientChecks).toEqual([3]);
    expect(h.ops[0]).toEqual({
      serverId: 3,
      op: 'terminal.open',
      params: { kind: 'database', cols: 80, rows: 24, sessionId: 2, container: 'nd-db-orders', databaseId: 9, containerId: 'f'.repeat(64), client: { engine: 'postgres' } },
      opts: { timeoutMs: 60_000 },
    });
    h.answer = { exitCode: 1, lines: [ndTerminal()] };
    await expect(
      openNodeTerminalTty(dbWith(server), target({ kind: 'database', containerName: 'nd-db-orders', databaseClient }), { sessionId: 2, cols: 80, rows: 24, socketFactory: f.socketFactory }),
    ).rejects.toThrow('The node did not open the database client channel');
    // A plain database shell (no prepared client) is a container exec.
    h.answer = { exitCode: 0, lines: [ndTerminal()] };
    await openNodeTerminalTty(dbWith(server), target({ kind: 'database', containerName: 'nd-db-orders' }), { sessionId: 3, cols: 80, rows: 24, socketFactory: f.socketFactory });
    expect(h.ops.at(-1)!.params).toEqual({ kind: 'container', cols: 80, rows: 24, sessionId: 3, container: 'nd-db-orders' });
  });

  it('refuses before any op: no node, a panel target kind, a deleted node, the clear transport, a misplaced client, no container', async () => {
    const opts = { sessionId: 1, cols: 80, rows: 24, socketFactory: factory().socketFactory };
    await expect(openNodeTerminalTty(dbWith(server), target({ serverId: null }), opts)).rejects.toThrow('not a node target');
    await expect(openNodeTerminalTty(dbWith(server), target({ kind: 'container' }), opts)).rejects.toThrow('container targets do not run on nodes');
    await expect(openNodeTerminalTty(dbWith(undefined), target(), opts)).rejects.toThrow('node #3 no longer exists');
    h.sealed = false;
    await expect(openNodeTerminalTty(dbWith(server), target(), opts)).rejects.toThrow('the panel reaches node "edge-1" only over the unencrypted transport');
    h.sealed = true;
    await expect(openNodeTerminalTty(dbWith(server), target({ databaseClient: { databaseId: 1, containerId: 'x', input: {} } }), opts)).rejects.toThrow(
      'A database client needs a database target',
    );
    await expect(openNodeTerminalTty(dbWith(server), target({ containerName: null }), opts)).rejects.toThrow('the target has no container');
    expect(h.ops).toEqual([]);
    expect(h.clientChecks).toEqual([]);
  });

  it('refuses an answer without a channel before connecting', async () => {
    h.answer = { exitCode: 0, lines: ['ok'] };
    const f = factory();
    await expect(openNodeTerminalTty(dbWith(server), target(), { sessionId: 1, cols: 80, rows: 24, socketFactory: f.socketFactory })).rejects.toThrow(
      'the agent on node "edge-1" answered terminal.open without a channel',
    );
    expect(f.made).toEqual([]);
  });

  it('a socket error or close before open rejects and closes the socket', async () => {
    const err = factory((s) =>
      queueMicrotask(() => {
        s.throwOnClose = true;
        s.emit('error');
        s.emit('open');
      }),
    );
    await expect(openNodeTerminalTty(dbWith(server), target(), { sessionId: 1, cols: 80, rows: 24, socketFactory: err.socketFactory })).rejects.toThrow(
      'could not connect to the terminal channel on node "edge-1"',
    );
    expect(err.made[0]!.closes).toEqual([undefined]);
    const refused = factory((s) => queueMicrotask(() => s.emit('close')));
    await expect(openNodeTerminalTty(dbWith(server), target(), { sessionId: 1, cols: 80, rows: 24, socketFactory: refused.socketFactory })).rejects.toThrow(
      'the agent on node "edge-1" refused the terminal channel',
    );
    expect(refused.made[0]!.closes).toEqual([undefined]);
  });

  it('gives up when the channel does not open within 10 s', async () => {
    vi.useFakeTimers();
    const silent = factory(() => undefined);
    const opening = openNodeTerminalTty(dbWith(server), target(), { sessionId: 1, cols: 80, rows: 24, socketFactory: silent.socketFactory });
    const settled = opening.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toMatchObject({ message: 'the agent on node "edge-1" did not open the terminal channel in time' });
    expect(silent.made[0]!.closes).toEqual([undefined]);
  });
});
