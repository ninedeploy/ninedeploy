import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Agent side of the sealed stream channel (agentOps/stream.ts), driven
 * directly: `stream.open` through the op module, then `attachStreamChannel`
 * on a fake socket with the test playing the panel under the real frame
 * cipher. Each kind's `prepare` is replaced by a spy, so no Docker command is
 * ever built or run; transfer files live in a per-test temp directory.
 */

vi.mock('../../src/lib/spawnValidated.js', async (importOriginal) => ({
  BINARIES: (await importOriginal<typeof import('../../src/lib/spawnValidated.js')>()).BINARIES,
  spawnValidated: vi.fn(async () => {
    throw new Error('no docker in this test');
  }),
  spawnValidatedStream: vi.fn(() => {
    throw new Error('no docker in this test');
  }),
}));

const stream = await import('../../src/agentOps/stream.js');
const cipher = await import('../../src/lib/agentFrameCipher.js');
const { parseStreamChannel } = await import('../../src/lib/agentStream.js');

const TOKEN_HASH = createHash('sha256').update('agent-stream-coverage').digest('hex');
const T = cipher.STREAM_FRAME_TYPE;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type Params = Record<string, unknown>;
type Prepared = Awaited<ReturnType<(typeof stream.STREAM_KIND_HANDLERS)['image.save']['prepare']>>;

let work: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
const transferDir = () => path.join(work, '.agent-work', '.transfer');

beforeEach(() => {
  stream._resetAgentStreams();
  work = mkdtempSync(path.join(os.tmpdir(), 'nd-stream-cov-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(work);
});

afterEach(async () => {
  vi.useRealTimers();
  await stream.closeAllStreamChannels();
  stream._resetAgentStreams();
  vi.restoreAllMocks();
  cwdSpy.mockRestore();
  rmSync(work, { recursive: true, force: true });
  delete process.env['NINEDEPLOY_AGENT_DATABASES'];
});

const openOp = (params: Params, onLine: (l: string) => void = () => undefined) =>
  stream.streamOps.ops['stream.open']!.run(params as never, onLine, { sealed: true });

/** Replace one kind's prepare; returns the spy. */
function prepareAs(kind: keyof typeof stream.STREAM_KIND_HANDLERS, prepared: Prepared | (() => Promise<Prepared>)) {
  return vi
    .spyOn(stream.STREAM_KIND_HANDLERS[kind], 'prepare')
    .mockImplementation(typeof prepared === 'function' ? prepared : async () => prepared);
}

/** Open a channel and answer its id and salt. */
async function openChannel(params: Params) {
  const lines: string[] = [];
  expect(await openOp(params, (l) => lines.push(l))).toBe(0);
  const ch = parseStreamChannel(lines);
  if (!ch) throw new Error('no channel');
  return ch;
}

/** The parts of a `ws` socket the bridge uses, with the test playing the panel. */
function fakeSocket(opts: { sendThrows?: boolean; closeThrows?: boolean } = {}) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const sent: Buffer[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  const s = {
    readyState: 1,
    bufferedAmount: 0,
    send: (d: Buffer) => {
      if (opts.sendThrows) throw new Error('send failed');
      sent.push(Buffer.from(d));
    },
    close: (code?: number, reason?: string) => {
      closes.push([code, reason]);
      if (opts.closeThrows) throw new Error('close failed');
      s.readyState = 3;
    },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      listeners[event] = [...(listeners[event] ?? []), cb];
      return s;
    },
    emit: (event: string, ...a: unknown[]) => {
      for (const cb of listeners[event] ?? []) cb(...a);
    },
    sent,
    closes,
  };
  return s;
}
type FakeSocket = ReturnType<typeof fakeSocket>;

/** Attach a socket to a channel and return the panel's helpers. */
function attach(ch: { channel: string; salt: Buffer }, socket: FakeSocket = fakeSocket()) {
  stream.attachStreamChannel(socket as never, `ninedeploy.agent-stream.${ch.channel}`, TOKEN_HASH);
  const key = cipher.deriveFrameKey(TOKEN_HASH, ch.salt, cipher.STREAM_HKDF_INFO);
  const tx = new cipher.FrameSealer(key, 'panel');
  const toAgent = (type: number, payload?: Buffer) => socket.emit('message', tx.seal(type as never, payload), true);
  const frames = () => {
    const rx = new cipher.FrameOpener(key, 'agent', cipher.STREAM_FRAME_TYPES);
    return socket.sent.map((f) => rx.open(f));
  };
  const lastError = () => {
    const last = frames().at(-1);
    return last?.type === T.error ? cipher.decodeStreamError(last.payload) : null;
  };
  return { socket, tx, toAgent, frames, lastError };
}

/** A controllable agent→panel source. */
function source(result: Record<string, unknown> = { ok: true }) {
  const out = new PassThrough();
  let resolveDone!: (r: Record<string, unknown>) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<Record<string, unknown>>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  done.catch(() => undefined);
  const abort = vi.fn();
  return { src: { stream: out, done, abort }, out, finish: () => resolveDone(result), fail: (e: unknown) => rejectDone(e), abort };
}

const until = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true), { timeout: 5_000, interval: 5 });

describe('stream.open', () => {
  it('refuses a missing or inherited kind name', async () => {
    await expect(openOp({ maxBytes: 10 })).rejects.toThrow('Invalid stream kind');
    await expect(openOp({ kind: 'toString', maxBytes: 10 })).rejects.toThrow('Invalid stream kind');
  });

  it("refuses a kind whose capability is switched off on this node", async () => {
    process.env['NINEDEPLOY_AGENT_DATABASES'] = 'off';
    const spy = prepareAs('db.dump', { direction: 'agent-to-panel', start: async () => source().src });
    await expect(openOp({ kind: 'db.dump', maxBytes: 10 })).rejects.toThrow('Stream kind db.dump is not available on this node');
    expect(spy).not.toHaveBeenCalled();
  });

  it('counts channels still being prepared against the limit, and a failed prepare frees its slot', async () => {
    const gates: Array<() => void> = [];
    prepareAs('volume.export', () => new Promise<Prepared>((resolve) => gates.push(() => resolve({ direction: 'agent-to-panel', start: async () => source().src }))));
    const pending = Array.from({ length: stream.STREAM_MAX_CHANNELS }, () => openOp({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 }));
    await until(() => gates.length === stream.STREAM_MAX_CHANNELS);
    await expect(openOp({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 })).rejects.toThrow('Too many open streams on this node (at most 4)');
    for (const g of gates) g();
    await Promise.all(pending);
    expect(stream.streamChannelCount()).toBe(4);
    await stream.closeAllStreamChannels();
    expect(stream.streamChannelCount()).toBe(0);

    prepareAs('volume.export', async () => {
      throw new Error('Volume nd-svc-a does not exist on this node');
    });
    for (let i = 0; i < 5; i++) await expect(openOp({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 })).rejects.toThrow(/does not exist/);
    prepareAs('volume.export', { direction: 'agent-to-panel', start: async () => source().src });
    await openChannel({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 });
    expect(stream.streamChannelCount()).toBe(1);
  });
});

describe('agentStreamChannelId and attachStreamChannel', () => {
  it('reads the id from a header string or list, and only a 32-hex id', () => {
    const id = 'ab'.repeat(16);
    expect(stream.agentStreamChannelId(`other, ninedeploy.agent-stream.${id}`)).toBe(id);
    expect(stream.agentStreamChannelId(['x', `ninedeploy.agent-stream.${id}`])).toBe(id);
    expect(stream.agentStreamChannelId(undefined)).toBeNull();
    expect(stream.agentStreamChannelId('ninedeploy.agent-stream.ABC')).toBeNull();
    expect(stream.agentStreamChannelId('ninedeploy.terminal.x')).toBeNull();
  });

  it('an unknown channel closes 1008 (a throwing close is tolerated); a channel is consumed by the first socket', async () => {
    const s = fakeSocket({ closeThrows: true });
    stream.attachStreamChannel(s as never, undefined, TOKEN_HASH);
    expect(s.closes).toEqual([[1008, 'unknown stream channel']]);
    prepareAs('volume.export', { direction: 'agent-to-panel', start: async () => source().src });
    const ch = await openChannel({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 });
    attach(ch);
    const second = fakeSocket();
    stream.attachStreamChannel(second as never, `ninedeploy.agent-stream.${ch.channel}`, TOKEN_HASH);
    expect(second.closes).toEqual([[1008, 'unknown stream channel']]);
  });

  it('a socket that never authenticates is closed 1008 after 10 s and the channel is gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const start = vi.fn(async () => source().src);
    prepareAs('volume.export', { direction: 'agent-to-panel', start });
    const ch = await openChannel({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 });
    const { socket } = attach(ch);
    vi.advanceTimersByTime(stream.STREAM_AUTH_TIMEOUT_MS - 1);
    expect(socket.closes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.closes).toEqual([[1008, 'channel not authenticated']]);
    expect(stream.streamChannelCount()).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('text frames and undecryptable frames close 1008 before anything starts', async () => {
    const start = vi.fn(async () => source().src);
    prepareAs('volume.export', { direction: 'agent-to-panel', start });
    const a = attach(await openChannel({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 }));
    a.socket.emit('message', Buffer.from('hi'), false);
    expect(a.socket.closes).toEqual([[1008, 'text frames are not part of this protocol']]);
    a.socket.emit('message', Buffer.from('ignored'), true); // finished: ignored
    const b = attach(await openChannel({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 }));
    b.socket.emit('message', new Uint8Array(40).buffer, true);
    expect(b.socket.closes).toEqual([[1008, 'bad frame']]);
    expect(start).not.toHaveBeenCalled();
    expect(stream.streamChannelCount()).toBe(0);
  });
});

describe('agent → panel', () => {
  async function download(maxBytes = 1_000_000, socket?: FakeSocket) {
    const s = source({ imageId: 'sha256:x' });
    const start = vi.fn(async () => s.src);
    prepareAs('image.save', { direction: 'agent-to-panel', start });
    const ch = await openChannel({ kind: 'image.save', image: 'x', maxBytes });
    return { ...attach(ch, socket), s, start };
  }

  it('streams the source after the first frame; the end frame carries bytes, sha256 and the result', async () => {
    const d = await download();
    // A fragmented first frame (a list of buffers) authenticates too.
    const first = d.tx.seal(T.resume);
    d.socket.emit('message', [first.subarray(0, 10), first.subarray(10)], true);
    await until(() => d.start.mock.calls.length === 1);
    const a = Buffer.alloc(cipher.FRAME_DATA_CHUNK + 5, 1);
    const b = Buffer.from('tail');
    d.s.out.write(a);
    d.s.out.end(b);
    d.s.finish();
    await until(() => d.socket.closes.length === 1);
    const frames = d.frames();
    expect(frames.map((f) => f.type)).toEqual([T.data, T.data, T.data, T.end]);
    const all = Buffer.concat([a, b]);
    expect(Buffer.concat(frames.slice(0, 3).map((f) => f.payload)).equals(all)).toBe(true);
    expect(cipher.decodeStreamEnd(frames[3]!.payload)).toEqual({ bytes: all.length, sha256: sha(all), result: { imageId: 'sha256:x' } });
    expect(d.socket.closes).toEqual([[1000, 'stream complete']]);
    expect(stream.streamChannelCount()).toBe(0);
  });

  it("the panel's pause and resume pause and resume the source", async () => {
    const d = await download();
    d.toAgent(T.resume);
    await until(() => d.start.mock.calls.length === 1);
    await until(() => !d.s.out.isPaused());
    d.toAgent(T.pause);
    expect(d.s.out.isPaused()).toBe(true);
    d.toAgent(T.resume);
    expect(d.s.out.isPaused()).toBe(false);
    d.toAgent(T.close);
    expect(d.socket.closes).toEqual([[1000, 'closed by the panel']]);
    expect(d.s.abort).toHaveBeenCalled();
  });

  it('a full socket buffer pauses the source until it drains', async () => {
    const d = await download();
    d.toAgent(T.resume);
    await until(() => d.start.mock.calls.length === 1);
    d.socket.bufferedAmount = 64 * 1024 * 1024;
    d.s.out.write(Buffer.from('x'));
    await until(() => d.frames().length === 1);
    expect(d.s.out.isPaused()).toBe(true);
    d.socket.bufferedAmount = 0;
    await until(() => !d.s.out.isPaused());
    d.toAgent(T.close);
  });

  it('a source that fails to start, errors, overruns or exits badly sends the error frame and closes 1011', async () => {
    prepareAs('image.save', {
      direction: 'agent-to-panel',
      start: async () => {
        throw new Error('No such image: x');
      },
    });
    const a = attach(await openChannel({ kind: 'image.save', image: 'x', maxBytes: 10 }));
    a.toAgent(T.resume);
    await until(() => a.socket.closes.length === 1);
    expect(a.lastError()).toBe('No such image: x');
    expect(a.socket.closes).toEqual([[1011, 'stream failed']]);

    const b = await download();
    b.toAgent(T.resume);
    await until(() => b.start.mock.calls.length === 1);
    b.s.out.destroy(new Error('EPIPE'));
    await until(() => b.socket.closes.length === 1);
    expect(b.lastError()).toBe('reading the stream source failed: EPIPE');

    const c = await download(4);
    c.toAgent(T.resume);
    await until(() => c.start.mock.calls.length === 1);
    c.s.out.write(Buffer.from('12345'));
    await until(() => c.socket.closes.length === 1);
    expect(c.lastError()).toBe('the stream exceeded its 4-byte limit');
    expect(c.s.abort).toHaveBeenCalled();
    expect(c.frames().map((f) => f.type)).toEqual([T.error]); // no byte past the limit was sent

    const e = await download();
    e.toAgent(T.resume);
    await until(() => e.start.mock.calls.length === 1);
    e.s.out.end();
    e.s.fail('docker save exited with 1');
    await until(() => e.socket.closes.length === 1);
    expect(e.lastError()).toBe('docker save exited with 1');
  });

  it('a socket that closes while the source starts aborts the source', async () => {
    const s = source();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    prepareAs('image.save', {
      direction: 'agent-to-panel',
      start: async () => {
        await gate;
        return s.src;
      },
    });
    const d = attach(await openChannel({ kind: 'image.save', image: 'x', maxBytes: 10 }));
    d.toAgent(T.resume);
    d.socket.emit('close');
    expect(stream.streamChannelCount()).toBe(0);
    release();
    await until(() => s.abort.mock.calls.length === 1);
  });

  it('data, end and error frames from the panel are refused on a download', async () => {
    for (const [type, message] of [
      [T.data, 'unexpected data frame'],
      [T.end, 'unexpected end frame'],
      [T.error, 'unexpected frame'],
    ] as const) {
      const d = await download();
      d.toAgent(T.resume);
      d.toAgent(type, type === T.end ? cipher.encodeStreamEnd({ bytes: 0, sha256: sha(Buffer.alloc(0)) }) : Buffer.from('x'));
      expect(d.lastError(), message).toBe(message);
      expect(d.socket.closes).toEqual([[1011, 'stream failed']]);
    }
  });

  it('a socket error ends the channel; sends to a closed or throwing socket are dropped', async () => {
    const d = await download(1_000_000, fakeSocket({ sendThrows: true }));
    d.toAgent(T.resume);
    await until(() => d.start.mock.calls.length === 1);
    d.s.out.write(Buffer.from('x')); // send throws: swallowed
    d.socket.emit('error');
    expect(d.socket.closes).toEqual([[1011, '']]);
    expect(d.s.abort).toHaveBeenCalled();

    const e = await download();
    e.toAgent(T.resume);
    await until(() => e.start.mock.calls.length === 1);
    e.socket.readyState = 3;
    e.s.out.write(Buffer.from('x'));
    await new Promise((r) => setImmediate(r));
    expect(e.socket.sent).toEqual([]);
    e.socket.emit('close');
    expect(e.socket.closes).toEqual([]); // not OPEN: never closed again
    expect(stream.streamChannelCount()).toBe(0);
  });

  it('the 6 h cap on an attached channel sends the error frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = await download();
    d.toAgent(T.resume);
    await vi.waitFor(() => expect(d.start).toHaveBeenCalled());
    vi.advanceTimersByTime(6 * 3600 * 1000);
    expect(d.lastError()).toBe('the stream hit its 6 h limit');
    expect(d.socket.closes).toEqual([[1011, 'stream failed']]);
  });
});

describe('panel → agent', () => {
  async function upload(opts: { gunzip?: boolean; maxBytes?: number; apply?: (file: string) => Promise<Record<string, unknown>> } = {}) {
    const seen: Buffer[] = [];
    const apply = vi.fn(
      opts.apply ??
        (async (file: string) => {
          seen.push(readFileSync(file));
          return { applied: true };
        }),
    );
    prepareAs('volume.import', { direction: 'panel-to-agent', gunzip: opts.gunzip ?? false, apply });
    const ch = await openChannel({ kind: 'volume.import', volume: 'nd-svc-a', maxBytes: opts.maxBytes ?? 1_000_000 });
    return { ...attach(ch), apply, seen, part: path.join(transferDir(), `${ch.channel}.part`) };
  }

  it('buffers to a 0600 .part file, verifies the end frame, applies the file and removes it', async () => {
    const u = await upload();
    u.toAgent(T.resume);
    await until(() => existsSync(u.part));
    u.toAgent(T.pause); // flow control from the panel means nothing on an upload
    u.toAgent(T.resume);
    const body = Buffer.from('volume tar bytes');
    u.toAgent(T.data, body.subarray(0, 6));
    u.toAgent(T.data, body.subarray(6));
    u.toAgent(T.end, cipher.encodeStreamEnd({ bytes: body.length, sha256: sha(body) }));
    await until(() => u.socket.closes.length === 1);
    expect(u.seen).toEqual([body]);
    expect(u.apply).toHaveBeenCalledWith(u.part);
    const last = u.frames().at(-1)!;
    expect(last.type).toBe(T.end);
    expect(cipher.decodeStreamEnd(last.payload)).toEqual({ bytes: body.length, sha256: sha(body), result: { applied: true } });
    expect(u.socket.closes).toEqual([[1000, 'stream complete']]);
    expect(existsSync(u.part)).toBe(false);
  });

  it('gunzip kinds store the archive unpacked; the unpacked size is limited too', async () => {
    const plain = Buffer.from('image tar '.repeat(50));
    const gz = gzipSync(plain);
    const u = await upload({ gunzip: true });
    u.toAgent(T.resume);
    u.toAgent(T.data, gz);
    u.toAgent(T.end, cipher.encodeStreamEnd({ bytes: gz.length, sha256: sha(gz) }));
    await until(() => u.socket.closes.length === 1);
    expect(u.seen).toEqual([plain]);

    const bomb = gzipSync(Buffer.alloc(100_000));
    const b = await upload({ gunzip: true, maxBytes: 1_000 });
    b.toAgent(T.resume);
    b.toAgent(T.data, bomb);
    await until(() => b.socket.closes.length === 1);
    expect(b.lastError()).toBe('storing the stream on the node failed: the unpacked archive exceeded its 1000-byte limit');
    expect(b.apply).not.toHaveBeenCalled();
    expect(existsSync(b.part)).toBe(false);
  });

  it('leaves no .part behind when the channel fails before the file was opened', async () => {
    const u = await upload({ maxBytes: 3 });
    u.toAgent(T.resume);
    // No wait for the file: the write stream is still opening it when the channel fails.
    u.toAgent(T.data, Buffer.from('abcd'));
    expect(u.lastError()).toBe('the stream exceeded its 3-byte limit');
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(u.part)).toBe(false);
  });

  it('refuses bytes past maxBytes, a malformed end and a mismatched end; nothing is applied', async () => {
    // Each waits for its .part file to be open first, so the refusal happens mid-write.
    const a = await upload({ maxBytes: 3 });
    a.toAgent(T.resume);
    await until(() => existsSync(a.part));
    a.toAgent(T.data, Buffer.from('abcd'));
    expect(a.lastError()).toBe('the stream exceeded its 3-byte limit');

    const b = await upload();
    b.toAgent(T.resume);
    await until(() => existsSync(b.part));
    b.toAgent(T.end, Buffer.from('{}'));
    expect(b.lastError()).toBe('malformed end frame');

    const c = await upload();
    c.toAgent(T.resume);
    c.toAgent(T.data, Buffer.from('abc'));
    c.toAgent(T.end, cipher.encodeStreamEnd({ bytes: 2, sha256: 'f'.repeat(64) }));
    await until(() => c.socket.closes.length === 1);
    expect(c.lastError()).toBe(
      `the stream was truncated or altered: the panel sent 2 byte(s) sha256 ${'f'.repeat(64)}, the node received 3 byte(s) sha256 ${sha(Buffer.from('abc'))}`,
    );
    for (const u of [a, b, c]) {
      expect(u.apply).not.toHaveBeenCalled();
      expect(existsSync(u.part)).toBe(false);
    }
  });

  it("an apply failure is the error frame's message; the file is removed", async () => {
    const u = await upload({
      apply: async () => {
        throw new Error('Volume nd-svc-a is in use by a running container; stop it before restoring');
      },
    });
    u.toAgent(T.resume);
    u.toAgent(T.data, Buffer.from('x'));
    u.toAgent(T.end, cipher.encodeStreamEnd({ bytes: 1, sha256: sha(Buffer.from('x')) }));
    await until(() => u.socket.closes.length === 1);
    expect(u.lastError()).toMatch(/in use by a running container/);
    expect(existsSync(u.part)).toBe(false);
  });

  it('a socket closing while apply runs sends nothing after it', async () => {
    let release!: () => void;
    const u = await upload({
      apply: () =>
        new Promise((resolve) => {
          release = () => resolve({ late: true });
        }),
    });
    u.toAgent(T.resume);
    u.toAgent(T.end, cipher.encodeStreamEnd({ bytes: 0, sha256: sha(Buffer.alloc(0)) }));
    await until(() => u.apply.mock.calls.length === 1);
    u.socket.emit('close');
    const before = u.socket.sent.length;
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(u.socket.sent.length).toBe(before);
  });

  it('a slow disk pauses the panel and resumes it on drain', async () => {
    const u = await upload({ maxBytes: 10_000_000 });
    u.toAgent(T.resume);
    const big = Buffer.alloc(cipher.FRAME_DATA_CHUNK, 7);
    for (let i = 0; i < 8; i++) u.toAgent(T.data, big);
    await until(() => u.frames().some((f) => f.type === T.resume));
    const types = u.frames().map((f) => f.type);
    expect(types[0]).toBe(T.pause);
    expect(types.filter((t) => t === T.pause)).toHaveLength(types.filter((t) => t === T.resume).length);
    const all = Buffer.alloc(8 * cipher.FRAME_DATA_CHUNK, 7);
    u.toAgent(T.end, cipher.encodeStreamEnd({ bytes: all.length, sha256: sha(all) }));
    await until(() => u.socket.closes.length === 1);
    expect(u.seen[0]!.equals(all)).toBe(true);
  });

  it('a node that cannot create the transfer directory refuses the stream', async () => {
    writeFileSync(path.join(work, '.agent-work'), 'not a directory');
    const u = await upload();
    u.toAgent(T.resume);
    expect(u.lastError()).toMatch(/^could not store the stream on the node: /);
    expect(u.socket.closes).toEqual([[1011, 'stream failed']]);
  });
});

describe('transfer directory hygiene', () => {
  it('the sweep keeps the file of a live channel, however old', async () => {
    prepareAs('volume.import', { direction: 'panel-to-agent', gunzip: false, apply: async () => ({}) });
    const u = attach(await openChannel({ kind: 'volume.import', volume: 'nd-svc-a', maxBytes: 100 }));
    u.toAgent(T.resume);
    const dir = transferDir();
    await until(() => readdirSync(dir).length === 1);
    writeFileSync(path.join(dir, 'orphan.part'), 'x');
    const later = Date.now() + stream.TRANSFER_MAX_AGE_MS + 60_000;
    expect(stream.sweepTransferDir(dir, later)).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir)[0]).toMatch(/^[0-9a-f]{32}\.part$/);
  });

  it('startTransferSweep sweeps at boot and every 10 minutes, once; closeAllStreamChannels stops it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = transferDir();
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - stream.TRANSFER_MAX_AGE_MS - 60_000);
    const mk = (name: string) => {
      writeFileSync(path.join(dir, name), 'x');
      utimesSync(path.join(dir, name), old, old);
    };
    mk('boot.part');
    stream.startTransferSweep();
    stream.startTransferSweep(); // idempotent: still one timer
    expect(readdirSync(dir)).toEqual([]);
    mk('later.part');
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(readdirSync(dir)).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await stream.closeAllStreamChannels();
    expect(vi.getTimerCount()).toBe(0);
  });
});
