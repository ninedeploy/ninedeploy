import { createHash, type Hash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { type DB, servers } from '@ninedeploy/db';
import type { MultiNodeCapability } from '@ninedeploy/schemas';
import { type AgentCaller, capabilityRefusal, nodeLabel } from './agentCapabilities.js';
import { agentOp, agentTransportSealed } from './agentClient.js';
import {
  decodeStreamEnd,
  decodeStreamError,
  deriveFrameKey,
  encodeStreamEnd,
  FRAME_DATA_CHUNK,
  FRAME_SALT_BYTES,
  type FrameCipherError,
  FrameOpener,
  FrameSealer,
  STREAM_FRAME_TYPE,
  STREAM_FRAME_TYPES,
  STREAM_HKDF_INFO,
  type StreamEnd,
} from './agentFrameCipher.js';
import { decrypt, sha256 } from './crypto.js';
import { HttpError } from './errors.js';

/**
 * The sealed stream channel, panel side (multi-node, design §1.4).
 *
 * One binary-safe primitive for image transfer, volume backup/restore and
 * database dumps. It generalises the 0.15 terminal channel
 * (lib/agentTerminal.ts):
 *
 *  1. the capability gate: the panel reaches the node over the SEALED
 *     transport and its agent advertises `stream` plus the kind's capability
 *     — otherwise a clean refusal (422 `node_agent_outdated` with the "update
 *     the node agent" message) and nothing but `agent.ping` is sent;
 *  2. `stream.open` through the sealed `agentOp` validates the kind's params
 *     on the node and answers a single-use channel id and a salt inside the
 *     sealed reply;
 *  3. `ws://<node>/agent/stream` with `ninedeploy.agent-stream.<id>`; every
 *     frame is AES-256-GCM under a per-channel key derived with the STREAM
 *     HKDF info (a terminal key can never open it), with strict counters;
 *  4. end to end: the sender's `end {bytes, sha256}` must match what the
 *     receiver counted and hashed, or the stream fails — GCM authenticates
 *     each frame, the end hash proves nothing was dropped or cut short.
 *
 * Limits: `maxBytes` (default `NINEDEPLOY_STREAM_MAX_BYTES`, 50 GiB) is
 * enforced on both ends; a stream lives at most 6 h; flow control is the
 * pause/resume frames at 4 MiB buffered, as for terminals.
 */

/** Agent route (see agentOps/stream.ts, which imports these). */
export const AGENT_STREAM_PATH = '/agent/stream';
/** Subprotocol carrying the channel id (`ninedeploy.agent-stream.<channelId>`). */
export const AGENT_STREAM_PROTOCOL_PREFIX = 'ninedeploy.agent-stream.';
/** Hard cap on one stream's life, on both ends. */
export const STREAM_HARD_CAP_MS = 6 * 3600 * 1000;
/** Default and largest `maxBytes`. */
export const STREAM_MAX_BYTES_DEFAULT = 50 * 1024 ** 3;
export const STREAM_MAX_BYTES_CEILING = 1024 ** 4;
/** Backpressure threshold (bytes buffered on a socket) for both ends. */
export const STREAM_BACKPRESSURE_HIGH = 4 * 1024 * 1024;

/** Which way a kind's bytes flow. */
export type StreamDirection = 'agent-to-panel' | 'panel-to-agent';

/**
 * Stream kinds: one fixed command template each on the agent
 * (agentOps/stream.ts), plus the capability that gates it. T6 adds the
 * database kinds in its block.
 */
export const AGENT_STREAM_KINDS = {
  // ── 0.16 T2 agent transport ──
  'image.save': { direction: 'agent-to-panel', cap: 'image.manage' },
  'image.load': { direction: 'panel-to-agent', cap: 'image.manage' },
  'volume.export': { direction: 'agent-to-panel', cap: 'volume.manage' },
  'volume.import': { direction: 'panel-to-agent', cap: 'volume.manage' },
  // ── end 0.16 T2 ──
  // ── 0.16 T6 node databases ── (db.dump: agent-to-panel, db.restore: panel-to-agent; cap db.manage)
  // ── end 0.16 T6 ──
} as const satisfies Record<string, { direction: StreamDirection; cap: MultiNodeCapability }>;
export type AgentStreamKind = keyof typeof AGENT_STREAM_KINDS;

/** What a refusal or failure says the stream is for ("receive an image"). */
const KIND_FEATURE: Record<AgentStreamKind, string> = {
  'image.save': 'send an image to the panel',
  'image.load': 'receive an image',
  'volume.export': 'export a volume',
  'volume.import': 'restore a volume',
};

/** `NINEDEPLOY_STREAM_MAX_BYTES`, else 50 GiB; never above 1 TiB. */
export function streamMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number((env['NINEDEPLOY_STREAM_MAX_BYTES'] ?? '').trim());
  return Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, STREAM_MAX_BYTES_CEILING) : STREAM_MAX_BYTES_DEFAULT;
}

/** The `ND-STREAM {"channel","salt"}` line of a `stream.open` answer. */
export function parseStreamChannel(lines: string[]): { channel: string; salt: Buffer } | null {
  for (const line of lines) {
    if (!line.startsWith('ND-STREAM ')) continue;
    try {
      const v = JSON.parse(line.slice('ND-STREAM '.length)) as { channel?: unknown; salt?: unknown };
      if (typeof v.channel !== 'string' || !/^[0-9a-f]{32}$/.test(v.channel) || typeof v.salt !== 'string') return null;
      const salt = Buffer.from(v.salt, 'base64');
      return salt.length === FRAME_SALT_BYTES ? { channel: v.channel, salt } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The parts of a WHATWG WebSocket the channel uses (Node's global one; a fake in tests). */
export interface StreamSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', cb: () => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}
export type StreamSocketFactory = (url: string, protocols: string[]) => StreamSocket;

const defaultSocketFactory: StreamSocketFactory = (url, protocols) => new WebSocket(url, protocols) as unknown as StreamSocket;
const OPEN = 1;
/** How long the panel waits for the agent's WebSocket to open. */
const CONNECT_TIMEOUT_MS = 10_000;

const agentStreamUrl = (host: string, port: number): string => `ws://${isIPv6(host) ? `[${host}]` : host}:${port}${AGENT_STREAM_PATH}`;

function messageBytes(data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** How a finished stream ended: what crossed the wire, and the agent's result. */
export interface StreamDone {
  bytes: number;
  sha256: string;
  result: Record<string, unknown>;
}

/** Thrown (and passed to the stream's `error`) when a stream fails. */
export class AgentStreamError extends Error {
  constructor(
    message: string,
    /** Why: `agent` (the agent's error frame), `integrity` (count/hash mismatch), `limit`, `cipher`, `closed`. */
    readonly reason: 'agent' | 'integrity' | 'limit' | 'cipher' | 'closed' | 'timeout',
  ) {
    super(message);
    this.name = 'AgentStreamError';
  }
}

/**
 * One attached stream, panel side. The first frame (always `resume`) proves to
 * the agent that the panel holds the channel key, and starts the flow.
 */
class StreamChannel {
  private readonly tx: FrameSealer;
  private readonly rx: FrameOpener;
  private readonly hash: Hash = createHash('sha256');
  private bytes = 0;
  private finished = false;
  private peerPaused = false;
  private readonly waiters: Array<() => void> = [];
  private readonly hardCap: NodeJS.Timeout;
  readonly done: Promise<StreamDone>;
  private resolveDone!: (d: StreamDone) => void;
  private rejectDone!: (e: AgentStreamError) => void;
  /** Agent→panel: the bytes, as they arrive and verify. */
  readonly readable: Readable | null;
  /** Panel→agent: write the bytes here; `end()` sends the `end` frame. */
  readonly writable: Writable | null;
  private localPaused = false;
  /** Panel→agent: the `end` frame was sent. */
  private sentEnd = false;

  constructor(
    private readonly socket: StreamSocket,
    key: Buffer,
    readonly direction: StreamDirection,
    private readonly maxBytes: number,
    private readonly label: string,
  ) {
    this.tx = new FrameSealer(key, 'panel');
    this.rx = new FrameOpener(key, 'agent', STREAM_FRAME_TYPES);
    this.done = new Promise<StreamDone>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // Whoever awaits `done` sees the rejection; nobody listening is no crash.
    this.done.catch(() => undefined);
    this.readable =
      direction === 'agent-to-panel'
        ? new Readable({
            read: () => {
              if (this.localPaused && !this.finished) {
                this.localPaused = false;
                this.send(this.tx.seal(STREAM_FRAME_TYPE.resume));
              }
            },
            destroy: (err, cb) => {
              if (!this.finished) this.fail(new AgentStreamError(err?.message ?? 'the stream was abandoned by the panel', 'closed'), true);
              cb(null);
            },
          })
        : null;
    this.writable =
      direction === 'panel-to-agent'
        ? new Writable({
            write: (chunk: Buffer, _enc, cb) => {
              void this.writeData(chunk).then(() => cb(), (err: Error) => cb(err));
            },
            final: (cb) => {
              if (this.finished) return cb(new AgentStreamError('the stream already ended', 'closed'));
              this.sentEnd = true;
              this.send(this.tx.seal(STREAM_FRAME_TYPE.end, encodeStreamEnd({ bytes: this.bytes, sha256: this.digest() })));
              cb();
            },
            destroy: (err, cb) => {
              // autoDestroy after `final`: the end frame is out, the agent's answer settles `done`.
              if (!this.finished && (err || !this.sentEnd)) {
                this.fail(new AgentStreamError(err?.message ?? 'the stream was abandoned by the panel', 'closed'), true);
              }
              cb(null);
            },
          })
        : null;
    this.hardCap = setTimeout(() => this.fail(new AgentStreamError('the stream hit its 6 h limit', 'timeout'), true), STREAM_HARD_CAP_MS);
    this.hardCap.unref?.();
    socket.addEventListener('message', (ev) => this.onMessage(ev.data));
    socket.addEventListener('close', () => this.fail(new AgentStreamError(`the agent on node ${label} closed the stream before its end`, 'closed')));
    socket.addEventListener('error', () => this.fail(new AgentStreamError(`the stream connection to node ${label} failed`, 'closed')));
  }

  /** Send the first frame. */
  start(): void {
    this.send(this.tx.seal(STREAM_FRAME_TYPE.resume));
  }

  private digestValue: string | null = null;
  private digest(): string {
    this.digestValue ??= this.hash.digest('hex');
    return this.digestValue;
  }

  private send(frame: Buffer): void {
    if (this.socket.readyState !== OPEN) return;
    try {
      this.socket.send(frame);
    } catch {
      /* closing: the close event fails the stream */
    }
  }

  private count(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) throw new AgentStreamError(`the stream exceeded its ${this.maxBytes}-byte limit`, 'limit');
    this.hash.update(chunk);
  }

  /** Panel→agent data, respecting the agent's pause and the socket's buffer. */
  private async writeData(chunk: Buffer): Promise<void> {
    if (this.finished) throw new AgentStreamError('the stream already ended', 'closed');
    try {
      this.count(chunk);
    } catch (err) {
      this.fail(err as AgentStreamError, true);
      throw err;
    }
    for (let at = 0; at < chunk.length; at += FRAME_DATA_CHUNK) {
      this.send(this.tx.seal(STREAM_FRAME_TYPE.data, chunk.subarray(at, at + FRAME_DATA_CHUNK)));
    }
    while (!this.finished && (this.peerPaused || this.socket.bufferedAmount > STREAM_BACKPRESSURE_HIGH)) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        const t = setTimeout(resolve, 50);
        t.unref?.();
      });
    }
    if (this.finished && !this.ended) throw new AgentStreamError('the stream failed', 'closed');
  }

  private ended = false;

  private onMessage(data: unknown): void {
    if (this.finished) return;
    const bytes = messageBytes(data);
    if (!bytes) {
      this.fail(new AgentStreamError('the agent sent a text frame', 'cipher'), true);
      return;
    }
    let frame: { type: number; payload: Buffer };
    try {
      frame = this.rx.open(bytes);
    } catch (err) {
      this.fail(new AgentStreamError(`stream frame rejected (${(err as FrameCipherError).code ?? 'malformed'})`, 'cipher'), true);
      return;
    }
    switch (frame.type) {
      case STREAM_FRAME_TYPE.data: {
        if (this.direction !== 'agent-to-panel' || !this.readable) {
          this.fail(new AgentStreamError('unexpected data frame', 'cipher'), true);
          return;
        }
        try {
          this.count(frame.payload);
        } catch (err) {
          this.fail(err as AgentStreamError, true);
          return;
        }
        if (!this.readable.push(frame.payload) && !this.localPaused) {
          this.localPaused = true;
          this.send(this.tx.seal(STREAM_FRAME_TYPE.pause));
        }
        return;
      }
      case STREAM_FRAME_TYPE.pause:
        this.peerPaused = true;
        return;
      case STREAM_FRAME_TYPE.resume:
        this.peerPaused = false;
        for (const w of this.waiters.splice(0)) w();
        return;
      case STREAM_FRAME_TYPE.end:
        this.onEnd(frame.payload);
        return;
      case STREAM_FRAME_TYPE.error:
        this.fail(new AgentStreamError(`node ${this.label}: ${decodeStreamError(frame.payload)}`, 'agent'), true);
        return;
      default:
        // `close` from the agent means it abandoned the stream.
        this.fail(new AgentStreamError(`the agent on node ${this.label} abandoned the stream`, 'closed'), true);
        return;
    }
  }

  private onEnd(payload: Buffer): void {
    const end: StreamEnd | null = decodeStreamEnd(payload);
    if (!end) {
      this.fail(new AgentStreamError('the agent sent a malformed end frame', 'cipher'), true);
      return;
    }
    // agent→panel: what we counted and hashed must be what the agent sent.
    // panel→agent: the agent echoes what IT received, which must be what we sent.
    const mine = { bytes: this.bytes, sha256: this.digest() };
    if (end.bytes !== mine.bytes || end.sha256 !== mine.sha256) {
      this.fail(
        new AgentStreamError(
          `the stream from node ${this.label} was truncated or altered: ${end.bytes} byte(s) sha256 ${end.sha256} announced, ` +
            `${mine.bytes} byte(s) sha256 ${mine.sha256} ${this.direction === 'agent-to-panel' ? 'received' : 'sent'}`,
          'integrity',
        ),
        true,
      );
      return;
    }
    this.finished = true;
    this.ended = true;
    clearTimeout(this.hardCap);
    for (const w of this.waiters.splice(0)) w();
    this.readable?.push(null);
    this.resolveDone({ bytes: mine.bytes, sha256: mine.sha256, result: end.result ?? {} });
    try {
      this.socket.close(1000);
    } catch {
      /* already closing */
    }
  }

  /** Fail once: reject `done`, error the stream, and (when we initiate it) tell the agent and close. */
  fail(err: AgentStreamError, closeSocket = false): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.hardCap);
    for (const w of this.waiters.splice(0)) w();
    this.rejectDone(err);
    if (closeSocket) {
      this.send(this.tx.seal(STREAM_FRAME_TYPE.close));
      try {
        this.socket.close(1000);
      } catch {
        /* already closing */
      }
    }
    if (this.readable && !this.readable.destroyed) this.readable.destroy(err);
    if (this.writable && !this.writable.destroyed) this.writable.destroy(err);
  }
}

/** An open stream: the bytes (one side), and how it ended. */
export type AgentStreamHandle =
  | { kind: AgentStreamKind; direction: 'agent-to-panel'; readable: Readable; done: Promise<StreamDone>; abort: (reason?: string) => void }
  | { kind: AgentStreamKind; direction: 'panel-to-agent'; writable: Writable; done: Promise<StreamDone>; abort: (reason?: string) => void };

export interface OpenAgentStreamOptions {
  /** Default {@link streamMaxBytes}; both ends enforce it. */
  maxBytes?: number;
  socketFactory?: StreamSocketFactory;
  /** The agent caller for the capability check (default: `agentOp` on this node). */
  agent?: AgentCaller;
}

/**
 * Open a stream of `kind` on node `serverId`. Refuses with an
 * {@link HttpError} — 422 `node_transport_unsealed`, 502 `node_unreachable`,
 * 422 `node_agent_outdated` — before anything but `agent.ping` is sent; any
 * later failure throws or rejects with {@link AgentStreamError}.
 */
export async function openAgentStream(
  db: DB,
  serverId: number,
  kind: AgentStreamKind,
  params: Record<string, unknown>,
  opts: OpenAgentStreamOptions = {},
): Promise<AgentStreamHandle> {
  const spec = AGENT_STREAM_KINDS[kind];
  if (!spec) throw new Error(`Unknown stream kind ${kind}`);
  const row = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!row) throw new Error(`node #${serverId} no longer exists`);
  const label = await nodeLabel(db, serverId);
  const maxBytes = opts.maxBytes ?? streamMaxBytes();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > STREAM_MAX_BYTES_CEILING) throw new Error('Invalid stream size limit');
  const agent: AgentCaller = opts.agent ?? ((op, p, sink) => agentOp(db, serverId, op, p, sink));
  // The sealed check runs before anything is asked of the agent (as in openNodeTerminalTty).
  const sealed = await agentTransportSealed(db, serverId);
  const refusal = await capabilityRefusal(agent, label, sealed, {
    cap: ['stream', spec.cap],
    feature: KIND_FEATURE[kind],
    sealedRequired: true,
    persist: { db, serverId },
  });
  if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);

  const res = await agent('stream.open', { ...params, kind, direction: spec.direction, maxBytes }, () => undefined);
  const channel = parseStreamChannel(res.lines);
  if (!channel) throw new AgentStreamError(`the agent on node ${label} answered stream.open without a channel`, 'cipher');
  const key = deriveFrameKey(sha256(decrypt(row.tokenEncrypted)), channel.salt, STREAM_HKDF_INFO);

  const socket = (opts.socketFactory ?? defaultSocketFactory)(agentStreamUrl(row.host, row.port), [
    `${AGENT_STREAM_PROTOCOL_PREFIX}${channel.channel}`,
  ]);
  socket.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try {
          socket.close();
        } catch {
          /* never opened */
        }
        reject(err);
      } else resolve();
    };
    const timer = setTimeout(() => done(new AgentStreamError(`the agent on node ${label} did not open the stream in time`, 'timeout')), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.addEventListener('open', () => done());
    socket.addEventListener('error', () => done(new AgentStreamError(`could not connect to the stream channel on node ${label}`, 'closed')));
    socket.addEventListener('close', () => done(new AgentStreamError(`the agent on node ${label} refused the stream channel`, 'closed')));
  });
  const ch = new StreamChannel(socket, key, spec.direction, maxBytes, label);
  ch.start();
  const abort = (reason = 'aborted by the panel') => ch.fail(new AgentStreamError(reason, 'closed'), true);
  return spec.direction === 'agent-to-panel'
    ? { kind, direction: 'agent-to-panel', readable: ch.readable as Readable, done: ch.done, abort }
    : { kind, direction: 'panel-to-agent', writable: ch.writable as Writable, done: ch.done, abort };
}
