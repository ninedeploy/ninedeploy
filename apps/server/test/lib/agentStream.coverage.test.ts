import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DB, servers } from '@ninedeploy/db';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';

/**
 * Panel side of the sealed stream channel (lib/agentStream.ts): the open-time
 * refusals, the connect handshake, and every frame path of an attached
 * channel. The socket is a fake and the test plays the agent with the real
 * frame cipher; nothing reaches the network.
 */

const h = vi.hoisted(() => ({
  sealed: true,
  caller: null as null | ((op: string, params: Record<string, unknown>) => Promise<{ exitCode: number; lines: string[] }>),
}));
vi.mock('../../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentClient.js')>()),
  agentTransportSealed: async () => h.sealed,
  agentOp: async (_db: unknown, _server: number, op: string, params: Record<string, unknown>) => {
    if (!h.caller) throw new Error('no caller');
    return h.caller(op, params);
  },
}));

const cipher = await import('../../src/lib/agentFrameCipher.js');
const { AgentStreamError, openAgentStream, parseStreamChannel, streamMaxBytes, STREAM_HARD_CAP_MS, STREAM_MAX_BYTES_CEILING, STREAM_MAX_BYTES_DEFAULT } =
  await import('../../src/lib/agentStream.js');
const { resetNodeCapabilityCache } = await import('../../src/lib/agentCapabilities.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { HttpError } = await import('../../src/lib/errors.js');

const TOKEN = 'stream-coverage-token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const SALT = Buffer.alloc(32, 9);
const CHANNEL = 'a'.repeat(32);
const KEY = cipher.deriveFrameKey(TOKEN_HASH, SALT, cipher.STREAM_HKDF_INFO);
const T = cipher.STREAM_FRAME_TYPE;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pingLine = (caps: string[], version = '0.16.0') => `ND-AGENT ${JSON.stringify({ version, caps })}`;
const ALL_CAPS = ['stream', 'image.manage', 'volume.manage', 'db.manage'];
const channelLine = `ND-STREAM ${JSON.stringify({ channel: CHANNEL, salt: SALT.toString('base64') })}`;

let db: DB;
let serverId: number;

beforeEach(async () => {
  h.sealed = true;
  h.caller = null;
  resetNodeCapabilityCache();
  db = await migratedDb();
  serverId = (await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt(TOKEN), status: 'online' }).returning())[0]!.id;
});

afterEach(() => {
  vi.useRealTimers();
  closeMigratedDb(db);
});

type Listener = (ev?: unknown) => void;

/** The writable of an upload handle (narrowing does not survive into callbacks). */
function wr(handle: Awaited<ReturnType<typeof openAgentStream>>) {
  if (handle.direction !== 'panel-to-agent') throw new Error('direction');
  return handle.writable;
}

/** The panel's socket, with the test playing the agent. */
function fakeSocket(opts: { autoOpen?: 'open' | 'error' | 'close' | null; closeThrows?: boolean; sendThrows?: boolean } = {}) {
  const listeners: Record<string, Listener[]> = {};
  const sent: Buffer[] = [];
  const closes: Array<number | undefined> = [];
  const auto = opts.autoOpen === undefined ? 'open' : opts.autoOpen;
  let scheduled = false;
  const s = {
    readyState: 1,
    bufferedAmount: 0,
    binaryType: '',
    send: (d: Uint8Array) => {
      if (opts.sendThrows) throw new Error('send failed');
      sent.push(Buffer.from(d));
    },
    close: (code?: number) => {
      closes.push(code);
      if (opts.closeThrows) throw new Error('close failed');
      s.readyState = 3;
    },
    addEventListener: (type: string, cb: Listener) => {
      listeners[type] = [...(listeners[type] ?? []), cb];
      // The connect handshake registers open, error, close in that order: answer once it listens.
      if (type === 'close' && !scheduled && auto) {
        scheduled = true;
        queueMicrotask(() => s.emit(auto));
      }
    },
    emit: (type: string, ev?: unknown) => {
      for (const cb of listeners[type] ?? []) cb(ev);
    },
    sent,
    closes,
  };
  return s;
}
type FakeSocket = ReturnType<typeof fakeSocket>;

/** An agent caller that answers the ping and `stream.open`. */
function caller(over: { caps?: string[]; version?: string; streamLines?: string[]; pingThrows?: boolean } = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const fn = async (op: string, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'agent.ping') {
      if (over.pingThrows) throw new Error('connection refused');
      return { exitCode: 0, lines: [pingLine(over.caps ?? ALL_CAPS, over.version)] };
    }
    return { exitCode: 0, lines: over.streamLines ?? [channelLine] };
  };
  return { fn, calls };
}

/** Open a stream on a fake socket; returns the handle, the socket and the agent's sealer. */
async function openWith(kind: 'image.save' | 'image.load', socket: FakeSocket = fakeSocket(), maxBytes?: number) {
  const agent = caller();
  const handle = await openAgentStream(db, serverId, kind, { x: 1 }, { agent: agent.fn, socketFactory: () => socket as never, ...(maxBytes ? { maxBytes } : {}) });
  const tx = new cipher.FrameSealer(KEY, 'agent');
  const rx = new cipher.FrameOpener(KEY, 'panel', cipher.STREAM_FRAME_TYPES);
  const toAgent = (type: number, payload?: Buffer) => socket.emit('message', { data: new Uint8Array(tx.seal(type as never, payload)) });
  const sentTypes = () => {
    const opener = new cipher.FrameOpener(KEY, 'panel', cipher.STREAM_FRAME_TYPES);
    return socket.sent.map((f) => opener.open(f));
  };
  return { handle, socket, tx, rx, toAgent, sentTypes, agent };
}

describe('streamMaxBytes and parseStreamChannel', () => {
  it('reads NINEDEPLOY_STREAM_MAX_BYTES, falls back on nonsense and caps at 1 TiB', () => {
    expect(streamMaxBytes({})).toBe(STREAM_MAX_BYTES_DEFAULT);
    expect(streamMaxBytes({ NINEDEPLOY_STREAM_MAX_BYTES: ' 4096 ' })).toBe(4096);
    for (const bad of ['0', '-5', 'abc', '1.5', '']) expect(streamMaxBytes({ NINEDEPLOY_STREAM_MAX_BYTES: bad }), bad).toBe(STREAM_MAX_BYTES_DEFAULT);
    expect(streamMaxBytes({ NINEDEPLOY_STREAM_MAX_BYTES: String(2 ** 45) })).toBe(STREAM_MAX_BYTES_CEILING);
  });

  it('accepts exactly one well-formed ND-STREAM line', () => {
    expect(parseStreamChannel(['noise', channelLine])).toEqual({ channel: CHANNEL, salt: SALT });
    expect(parseStreamChannel([])).toBeNull();
    expect(parseStreamChannel(['ND-STREAM {not json'])).toBeNull();
    expect(parseStreamChannel([`ND-STREAM ${JSON.stringify({ channel: 'XYZ', salt: SALT.toString('base64') })}`])).toBeNull();
    expect(parseStreamChannel([`ND-STREAM ${JSON.stringify({ channel: CHANNEL, salt: 5 })}`])).toBeNull();
    expect(parseStreamChannel([`ND-STREAM ${JSON.stringify({ channel: CHANNEL, salt: Buffer.alloc(8).toString('base64') })}`])).toBeNull();
  });
});

describe('openAgentStream refusals before any channel exists', () => {
  it('refuses an unknown kind, a vanished node and an invalid size limit', async () => {
    await expect(openAgentStream(db, serverId, 'host.cat' as never, {})).rejects.toThrow('Unknown stream kind host.cat');
    await expect(openAgentStream(db, 999, 'image.save', {})).rejects.toThrow('node #999 no longer exists');
    for (const maxBytes of [0, 1.5, STREAM_MAX_BYTES_CEILING + 1]) {
      await expect(openAgentStream(db, serverId, 'image.save', {}, { maxBytes, agent: caller().fn }), String(maxBytes)).rejects.toThrow('Invalid stream size limit');
    }
  });

  it('an unsealed transport is refused before the agent is asked anything', async () => {
    h.sealed = false;
    const agent = caller();
    const err = await openAgentStream(db, serverId, 'image.load', {}, { agent: agent.fn }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 422, code: 'node_transport_unsealed' });
    expect((err as Error).message).toContain('receive an image is never sent in clear');
    expect(agent.calls).toEqual([]);
  });

  it('an unreachable agent is 502, an old agent 422 outdated; stream.open is never sent', async () => {
    const down = caller({ pingThrows: true });
    await expect(openAgentStream(db, serverId, 'volume.export', {}, { agent: down.fn })).rejects.toMatchObject({ statusCode: 502, code: 'node_unreachable' });
    const old = caller({ caps: ['terminal'], version: '0.15.1' });
    await expect(openAgentStream(db, serverId, 'db.dump', {}, { agent: old.fn })).rejects.toMatchObject({ statusCode: 422, code: 'node_agent_outdated' });
    expect([...down.calls, ...old.calls].map((c) => c.op)).toEqual(['agent.ping', 'agent.ping']);
  });

  it('a stream.open answer without a channel fails with a cipher error, and no socket is opened', async () => {
    const factory = vi.fn();
    const err = await openAgentStream(db, serverId, 'image.save', {}, { agent: caller({ streamLines: ['ok'] }).fn, socketFactory: factory }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentStreamError);
    expect(err).toMatchObject({ reason: 'cipher', name: 'AgentStreamError' });
    expect((err as Error).message).toBe('the agent on node "edge-1" (#1) answered stream.open without a channel');
    expect(factory).not.toHaveBeenCalled();
  });

  it('the default caller is agentOp; stream.open carries the kind, direction and size limit; IPv6 hosts are bracketed', async () => {
    await db.insert(servers).values({ name: 'v6', host: '::1', port: 4700, tokenEncrypted: encrypt(TOKEN), status: 'online' });
    const v6 = (await db.query.servers.findFirst({ where: (s, { eq }) => eq(s.name, 'v6') }))!.id;
    const agent = caller();
    h.caller = agent.fn;
    const socket = fakeSocket();
    const factory = vi.fn(() => socket as never);
    const handle = await openAgentStream(db, v6, 'volume.import', { volume: 'nd-svc-a' }, { socketFactory: factory, maxBytes: 1234 });
    expect(handle).toMatchObject({ kind: 'volume.import', direction: 'panel-to-agent' });
    expect(factory).toHaveBeenCalledWith('ws://[::1]:4700/agent/stream', [`ninedeploy.agent-stream.${CHANNEL}`]);
    expect(socket.binaryType).toBe('arraybuffer');
    expect(agent.calls.at(-1)).toEqual({ op: 'stream.open', params: { volume: 'nd-svc-a', kind: 'volume.import', direction: 'panel-to-agent', maxBytes: 1234 } });
    handle.abort();
  });
});

describe('the connect handshake', () => {
  it('an error event before open rejects (closed) and closes the socket, even if close throws', async () => {
    const socket = fakeSocket({ autoOpen: 'error', closeThrows: true });
    const err = await openAgentStream(db, serverId, 'image.save', {}, { agent: caller().fn, socketFactory: () => socket as never }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'closed', message: 'could not connect to the stream channel on node "edge-1" (#1)' });
    expect(socket.closes).toEqual([undefined]);
  });

  it('a close before open is the agent refusing the channel; later events are ignored', async () => {
    const socket = fakeSocket({ autoOpen: 'close' });
    const p = openAgentStream(db, serverId, 'image.save', {}, { agent: caller().fn, socketFactory: () => socket as never });
    await expect(p).rejects.toMatchObject({ reason: 'closed', message: 'the agent on node "edge-1" (#1) refused the stream channel' });
    socket.emit('open');
    socket.emit('error');
    expect(socket.closes).toEqual([undefined]);
  });

  it('an agent that never opens the socket times out after 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = fakeSocket({ autoOpen: null });
    let made!: () => void;
    const factoryCalled = new Promise<void>((r) => {
      made = r;
    });
    const p = openAgentStream(db, serverId, 'image.save', {}, {
      agent: caller().fn,
      socketFactory: () => {
        made();
        return socket as never;
      },
    });
    p.catch(() => undefined);
    await factoryCalled;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(socket.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await expect(p).rejects.toMatchObject({ reason: 'timeout', message: 'the agent on node "edge-1" (#1) did not open the stream in time' });
    expect(socket.closes).toEqual([undefined]);
  });
});

describe('agent → panel: what arrives is counted, hashed and verified', () => {
  it('data as ArrayBuffer and as a view; a matching end resolves with the result and closes 1000', async () => {
    const { handle, socket, tx, sentTypes } = await openWith('image.save');
    if (handle.direction !== 'agent-to-panel') throw new Error('direction');
    expect(sentTypes().map((f) => f.type)).toEqual([T.resume]);
    const a = Buffer.from('hello ');
    const b = Buffer.from('world');
    const fa = tx.seal(T.data, a);
    socket.emit('message', { data: fa.buffer.slice(fa.byteOffset, fa.byteOffset + fa.byteLength) });
    socket.emit('message', { data: new Uint8Array(tx.seal(T.data, b)) });
    const all = Buffer.concat([a, b]);
    socket.emit('message', { data: new Uint8Array(tx.seal(T.end, cipher.encodeStreamEnd({ bytes: all.length, sha256: sha(all), result: { imageId: 'x' } }))) });
    const got: Buffer[] = [];
    for await (const c of handle.readable) got.push(c as Buffer);
    expect(Buffer.concat(got).toString()).toBe('hello world');
    await expect(handle.done).resolves.toEqual({ bytes: 11, sha256: sha(all), result: { imageId: 'x' } });
    expect(socket.closes).toEqual([1000]);
    // Frames after the end are ignored.
    socket.emit('message', { data: 'late' });
    expect(socket.sent).toHaveLength(1);
  });

  it('an end frame without a result resolves with {}; a close that throws is tolerated', async () => {
    const { handle, toAgent } = await openWith('image.save', fakeSocket({ closeThrows: true }));
    toAgent(T.end, cipher.encodeStreamEnd({ bytes: 0, sha256: sha(Buffer.alloc(0)) }));
    await expect(handle.done).resolves.toEqual({ bytes: 0, sha256: sha(Buffer.alloc(0)), result: {} });
  });

  it('a text frame, a malformed end, an error frame and an agent close each fail the stream and send close', async () => {
    const cases: Array<[(o: Awaited<ReturnType<typeof openWith>>) => void, Record<string, unknown>]> = [
      [(o) => o.socket.emit('message', { data: 'hello' }), { reason: 'cipher', message: 'the agent sent a text frame' }],
      [(o) => o.toAgent(T.end, Buffer.from('{}')), { reason: 'cipher', message: 'the agent sent a malformed end frame' }],
      [(o) => o.toAgent(T.error, cipher.encodeStreamError('docker save failed')), { reason: 'agent', message: 'node "edge-1" (#1): docker save failed' }],
      [(o) => o.toAgent(T.close), { reason: 'closed', message: 'the agent on node "edge-1" (#1) abandoned the stream' }],
      [(o) => o.socket.emit('message', { data: new Uint8Array(Buffer.alloc(40, 1)) }), { reason: 'cipher', message: 'stream frame rejected (out_of_order)' }],
    ];
    for (const [act, expected] of cases) {
      const o = await openWith('image.save');
      if (o.handle.direction !== 'agent-to-panel') throw new Error('direction');
      o.handle.readable.on('error', () => undefined);
      act(o);
      await expect(o.handle.done).rejects.toMatchObject(expected);
      expect(o.sentTypes().map((f) => f.type)).toEqual([T.resume, T.close]);
      expect(o.socket.closes).toEqual([1000]);
      expect(o.handle.readable.destroyed).toBe(true);
    }
  });

  it('a frame that is not a FrameCipherError still names a reason', async () => {
    const o = await openWith('image.save');
    if (o.handle.direction !== 'agent-to-panel') throw new Error('direction');
    o.handle.readable.on('error', () => undefined);
    const terminal = new cipher.FrameSealer(cipher.deriveFrameKey(TOKEN_HASH, SALT), 'agent');
    o.socket.emit('message', { data: new Uint8Array(terminal.seal(T.data, Buffer.from('x'))) });
    await expect(o.handle.done).rejects.toMatchObject({ reason: 'cipher', message: 'stream frame rejected (auth)' });
  });

  it('a count or hash mismatch is an integrity failure naming what was received', async () => {
    const o = await openWith('image.save');
    if (o.handle.direction !== 'agent-to-panel') throw new Error('direction');
    o.handle.readable.on('error', () => undefined);
    o.toAgent(T.data, Buffer.from('abc'));
    o.toAgent(T.end, cipher.encodeStreamEnd({ bytes: 3, sha256: 'f'.repeat(64) }));
    const err = (await o.handle.done.catch((e: unknown) => e)) as InstanceType<typeof AgentStreamError>;
    expect(err.reason).toBe('integrity');
    expect(err.message).toBe(`the stream from node "edge-1" (#1) was truncated or altered: 3 byte(s) sha256 ${'f'.repeat(64)} announced, 3 byte(s) sha256 ${sha(Buffer.from('abc'))} received`);
  });

  it('more bytes than maxBytes is a limit failure', async () => {
    const o = await openWith('image.save', fakeSocket(), 4);
    if (o.handle.direction !== 'agent-to-panel') throw new Error('direction');
    o.handle.readable.on('error', () => undefined);
    o.toAgent(T.data, Buffer.from('abc'));
    o.toAgent(T.data, Buffer.from('de'));
    await expect(o.handle.done).rejects.toMatchObject({ reason: 'limit', message: 'the stream exceeded its 4-byte limit' });
  });

  it('pauses the agent when the readable is full and resumes when it is read', async () => {
    const o = await openWith('image.save');
    if (o.handle.direction !== 'agent-to-panel') throw new Error('direction');
    const big = Buffer.alloc(100_000, 5);
    o.toAgent(T.data, big);
    o.toAgent(T.data, big); // still paused: no second pause frame
    expect(o.sentTypes().map((f) => f.type)).toEqual([T.resume, T.pause]);
    let drained = 0;
    // read() can return one queued chunk or combine several; drain until
    // the buffer falls below its high-water mark before requesting more.
    while (o.handle.readable.readableLength > 0) {
      const chunk = o.handle.readable.read() as Buffer | null;
      if (!chunk) break;
      drained += chunk.length;
    }
    expect(drained).toBe(big.length * 2);
    o.handle.readable.read(0);
    await vi.waitFor(() => expect(o.sentTypes().map((f) => f.type)).toEqual([T.resume, T.pause, T.resume]));
    o.handle.abort();
  });

  it('a consumer that destroys the readable abandons the stream (with its own reason when it gives one)', async () => {
    const plain = await openWith('image.save');
    if (plain.handle.direction !== 'agent-to-panel') throw new Error('direction');
    plain.handle.readable.destroy();
    await expect(plain.handle.done).rejects.toMatchObject({ reason: 'closed', message: 'the stream was abandoned by the panel' });
    expect(plain.sentTypes().map((f) => f.type)).toEqual([T.resume, T.close]);

    const why = await openWith('image.save');
    if (why.handle.direction !== 'agent-to-panel') throw new Error('direction');
    why.handle.readable.on('error', () => undefined);
    why.handle.readable.destroy(new Error('consumer gave up'));
    await expect(why.handle.done).rejects.toMatchObject({ reason: 'closed', message: 'consumer gave up' });
  });

  it('abort, a socket error and a socket close fail once; nothing is sent on a closed socket or when send throws', async () => {
    const a = await openWith('image.save');
    if (a.handle.direction !== 'agent-to-panel') throw new Error('direction');
    a.handle.readable.on('error', () => undefined);
    a.handle.abort('operator cancelled');
    a.handle.abort('again');
    await expect(a.handle.done).rejects.toMatchObject({ reason: 'closed', message: 'operator cancelled' });

    const b = await openWith('image.save');
    if (b.handle.direction !== 'agent-to-panel') throw new Error('direction');
    b.handle.readable.on('error', () => undefined);
    b.socket.readyState = 3;
    b.socket.emit('error');
    await expect(b.handle.done).rejects.toMatchObject({ reason: 'closed', message: 'the stream connection to node "edge-1" (#1) failed' });
    expect(b.socket.sent).toHaveLength(1); // only the first resume
    expect(b.socket.closes).toEqual([]); // a socket-initiated failure does not close it again

    const c = await openWith('image.save', fakeSocket({ sendThrows: true }));
    if (c.handle.direction !== 'agent-to-panel') throw new Error('direction');
    c.handle.readable.on('error', () => undefined);
    c.socket.emit('close');
    await expect(c.handle.done).rejects.toMatchObject({ reason: 'closed', message: 'the agent on node "edge-1" (#1) closed the stream before its end' });
  });

  it('the 6 h hard cap fails the stream (timeout)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const o = await openWith('image.save');
    if (o.handle.direction !== 'agent-to-panel') throw new Error('direction');
    o.handle.readable.on('error', () => undefined);
    vi.advanceTimersByTime(STREAM_HARD_CAP_MS - 1);
    vi.advanceTimersByTime(1);
    await expect(o.handle.done).rejects.toMatchObject({ reason: 'timeout', message: 'the stream hit its 6 h limit' });
  });
});

describe('panel → agent: what is sent is counted, framed, flow-controlled and confirmed', () => {
  it('splits writes into 32 KiB frames, ends with {bytes, sha256}, and resolves on the agent echo', async () => {
    const o = await openWith('image.load');
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    const payload = Buffer.alloc(cipher.FRAME_DATA_CHUNK + 10, 3);
    await new Promise<void>((resolve, reject) => wr(o.handle).end(payload, (err?: Error | null) => (err ? reject(err) : resolve())));
    const frames = o.sentTypes();
    expect(frames.map((f) => f.type)).toEqual([T.resume, T.data, T.data, T.end]);
    expect(frames[1]!.payload.length).toBe(cipher.FRAME_DATA_CHUNK);
    expect(frames[2]!.payload.length).toBe(10);
    expect(cipher.decodeStreamEnd(frames[3]!.payload)).toEqual({ bytes: payload.length, sha256: sha(payload) });
    o.toAgent(T.end, cipher.encodeStreamEnd({ bytes: payload.length, sha256: sha(payload), result: { tag: 't' } }));
    await expect(o.handle.done).resolves.toEqual({ bytes: payload.length, sha256: sha(payload), result: { tag: 't' } });
  });

  it("the agent's pause holds a write until its resume", async () => {
    const o = await openWith('image.load');
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    o.toAgent(T.pause);
    let written = false;
    wr(o.handle).write(Buffer.from('abc'), () => {
      written = true;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(written).toBe(false);
    o.toAgent(T.resume);
    await vi.waitFor(() => expect(written).toBe(true));
    o.handle.abort();
  });

  it('a full socket buffer holds a write until it drains', async () => {
    const o = await openWith('image.load');
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    o.socket.bufferedAmount = 64 * 1024 * 1024;
    let written = false;
    wr(o.handle).write(Buffer.from('abc'), () => {
      written = true;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(written).toBe(false);
    o.socket.bufferedAmount = 0;
    await vi.waitFor(() => expect(written).toBe(true));
    o.handle.abort();
  });

  it('a stream that fails while a write waits rejects that write', async () => {
    const o = await openWith('image.load');
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    o.toAgent(T.pause);
    const writeErr = new Promise<Error | null | undefined>((resolve) => {
      wr(o.handle).on('error', () => undefined);
      wr(o.handle).write(Buffer.from('abc'), (err) => resolve(err));
    });
    await new Promise((r) => setTimeout(r, 10));
    o.toAgent(T.error, cipher.encodeStreamError('no space left'));
    expect(await writeErr).toBeTruthy();
    await expect(o.handle.done).rejects.toMatchObject({ reason: 'agent', message: 'node "edge-1" (#1): no space left' });
  });

  it('writing past maxBytes fails the stream (limit)', async () => {
    const o = await openWith('image.load', fakeSocket(), 2);
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    wr(o.handle).on('error', () => undefined);
    const err = await new Promise<Error | null | undefined>((resolve) => wr(o.handle).write(Buffer.from('abc'), (e) => resolve(e)));
    expect(err).toMatchObject({ reason: 'limit', message: 'the stream exceeded its 2-byte limit' });
    await expect(o.handle.done).rejects.toMatchObject({ reason: 'limit' });
    expect(o.sentTypes().map((f) => f.type)).toEqual([T.resume, T.close]);
  });

  it('a data frame from the agent on an upload is refused', async () => {
    const o = await openWith('image.load');
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    wr(o.handle).on('error', () => undefined);
    o.toAgent(T.data, Buffer.from('x'));
    await expect(o.handle.done).rejects.toMatchObject({ reason: 'cipher', message: 'unexpected data frame' });
  });

  it('an agent echo that differs from what was sent is an integrity failure naming what was sent', async () => {
    const o = await openWith('image.load');
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    wr(o.handle).on('error', () => undefined);
    await new Promise<void>((resolve) => wr(o.handle).write(Buffer.from('abcd'), () => resolve()));
    o.toAgent(T.end, cipher.encodeStreamEnd({ bytes: 3, sha256: 'e'.repeat(64) }));
    await expect(o.handle.done).rejects.toMatchObject({ reason: 'integrity', message: expect.stringMatching(/3 byte\(s\) sha256 e+ announced, 4 byte\(s\) sha256 [0-9a-f]{64} sent$/) });
  });

  it('after an early agent end, writing and ending fail with "already ended"', async () => {
    const o = await openWith('image.load');
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    o.toAgent(T.end, cipher.encodeStreamEnd({ bytes: 0, sha256: sha(Buffer.alloc(0)) }));
    await expect(o.handle.done).resolves.toMatchObject({ bytes: 0 });
    wr(o.handle).on('error', () => undefined);
    const writeErr = await new Promise<Error | null | undefined>((resolve) => wr(o.handle).write(Buffer.from('x'), (e) => resolve(e)));
    expect(writeErr).toMatchObject({ reason: 'closed', message: 'the stream already ended' });
    const p = await openWith('image.load');
    if (p.handle.direction !== 'panel-to-agent') throw new Error('direction');
    p.toAgent(T.end, cipher.encodeStreamEnd({ bytes: 0, sha256: sha(Buffer.alloc(0)) }));
    await p.handle.done;
    wr(p.handle).on('error', () => undefined);
    // `final` fails; the destroy hook answers cb(null), so no 'error' event fires,
    // but the stream is errored with the refusal and end()'s callback sees it.
    const endErr = await new Promise<Error | null | undefined>((resolve) => wr(p.handle).end((e?: Error | null) => resolve(e)));
    expect(endErr).toMatchObject({ reason: 'closed', message: 'the stream already ended' });
    expect(wr(p.handle).errored).toBe(endErr);
    expect(p.sentTypes().map((f) => f.type)).toEqual([T.resume]); // no end frame went out
  });

  it('destroying the writable before end abandons the stream', async () => {
    const o = await openWith('image.load');
    if (o.handle.direction !== 'panel-to-agent') throw new Error('direction');
    wr(o.handle).destroy();
    await expect(o.handle.done).rejects.toMatchObject({ reason: 'closed', message: 'the stream was abandoned by the panel' });
    const p = await openWith('image.load');
    if (p.handle.direction !== 'panel-to-agent') throw new Error('direction');
    wr(p.handle).on('error', () => undefined);
    wr(p.handle).destroy(new Error('source failed'));
    await expect(p.handle.done).rejects.toMatchObject({ reason: 'closed', message: 'source failed' });
  });
});
