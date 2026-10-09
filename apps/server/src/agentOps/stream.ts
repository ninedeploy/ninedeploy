import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import {
  decodeStreamEnd,
  deriveFrameKey,
  encodeStreamEnd,
  encodeStreamError,
  FRAME_SALT_BYTES,
  FrameOpener,
  FrameSealer,
  STREAM_FRAME_TYPE,
  STREAM_FRAME_TYPES,
  STREAM_HKDF_INFO,
} from '../lib/agentFrameCipher.js';
import {
  AGENT_STREAM_KINDS,
  AGENT_STREAM_PROTOCOL_PREFIX,
  type AgentStreamKind,
  STREAM_BACKPRESSURE_HIGH,
  STREAM_HARD_CAP_MS,
  STREAM_MAX_BYTES_CEILING,
  type StreamDirection,
} from '../lib/agentStream.js';
import { imageLoadKind, imageSaveKind } from './images.js';
import type { AgentOpModule } from './index.js';
import { intOperand, type Params, str, TRANSFER_DIR } from './operands.js';

export { TRANSFER_DIR } from './operands.js';
import { volumeExportKind, volumeImportKind } from './volumes.js';

/**
 * The sealed stream channel, agent side (multi-node, design §1.4, §1.5).
 *
 * `stream.open` (sealed only, capability `stream`) validates one KIND's params
 * — every kind maps to one fixed command template, never a caller's argv —
 * and parks a single-use channel for 30 s; the panel then connects
 * `GET /agent/stream` (agentApp.ts) with that channel and every frame is
 * encrypted and authenticated under a per-channel key with the STREAM HKDF
 * info (lib/agentFrameCipher.ts), so a terminal key cannot open it.
 *
 * - Nothing runs until the panel's first frame authenticated the channel.
 * - Agent→panel kinds stream a child's stdout; the `end` frame carries the
 *   byte count and sha256 of everything sent, and the kind's result.
 * - Panel→agent kinds buffer the bytes to `.agent-work/.transfer/<channel>`
 *   (0600) and apply them ONLY after the panel's `end {bytes, sha256}` matched
 *   what arrived — a truncated or altered stream never reaches Docker.
 * - Limits: 4 channels per agent, `maxBytes` (≤ 1 TiB) on the wire and on an
 *   unpacked archive, 6 h per stream, pause/resume at 4 MiB buffered.
 */

/** A channel nobody attached within this window is closed. */
export const STREAM_CHANNEL_TTL_MS = 30_000;
/** Channels (pending + attached) one agent holds at a time. */
export const STREAM_MAX_CHANNELS = 4;
/** The panel's first frame must arrive within this window. */
export const STREAM_AUTH_TIMEOUT_MS = 10_000;
/** The sweep removes transfer files older than this (an agent that died mid-transfer). */
export const TRANSFER_MAX_AGE_MS = STREAM_HARD_CAP_MS;
const TRANSFER_SWEEP_EVERY_MS = 10 * 60 * 1000;

/** An agent→panel source: the bytes, and the kind's result once the producer exited cleanly. */
export interface StreamSource {
  stream: Readable;
  done: Promise<Record<string, unknown>>;
  abort(): void;
}

/** A validated, not yet started, stream. */
export type PreparedStream =
  | { direction: 'agent-to-panel'; start(): Promise<StreamSource> }
  | {
      direction: 'panel-to-agent';
      /** The wire carries gzip; store it unpacked (`image.load`). */
      gunzip: boolean;
      /** Apply the verified file. Throws with the refusal or failure. */
      apply(file: string): Promise<Record<string, unknown>>;
    };

/** One stream kind on the agent: validates its params (and the node's state) before any channel exists. */
export interface StreamKindHandler {
  /** The params the kind takes besides `kind`, `direction` and `maxBytes`. */
  keys: readonly string[];
  prepare(params: Params, ctx: { maxBytes: number }): Promise<PreparedStream>;
}

/** Every kind's handler. Typed against `AGENT_STREAM_KINDS`, so a kind cannot exist on one side only. */
export const STREAM_KIND_HANDLERS: Readonly<Record<AgentStreamKind, StreamKindHandler>> = {
  // ── 0.16 T2 agent transport ──
  'image.save': imageSaveKind,
  'image.load': imageLoadKind,
  'volume.export': volumeExportKind,
  'volume.import': volumeImportKind,
  // ── end 0.16 T2 ──
  // ── 0.16 T6 node databases ── (db.dump, db.restore: agentOps/databases.ts)
  // ── end 0.16 T6 ──
};

interface StreamChannel {
  id: string;
  salt: Buffer;
  kind: AgentStreamKind;
  direction: StreamDirection;
  maxBytes: number;
  prepared: PreparedStream;
  state: 'pending' | 'attached' | 'closed';
  timers: NodeJS.Timeout[];
  /** Stops whatever the channel started (a child, a pending apply). */
  abort: (() => void) | null;
  /** Called when the 6 h cap fires while attached (sends the error frame). */
  onHardCap: (() => void) | null;
  file: string | null;
}

const streamChannels = new Map<string, StreamChannel>();
let opening = 0;

/** Live stream channels (pending + attached), for tests and the shutdown hook. */
export const streamChannelCount = (): number => streamChannels.size;

const transferRoot = (): string => path.resolve(process.cwd(), TRANSFER_DIR);

/** Close a channel: timers, the map, the process, the transfer file. Idempotent, never throws. */
function closeStreamChannel(ch: StreamChannel): void {
  if (ch.state === 'closed') return;
  ch.state = 'closed';
  for (const t of ch.timers) clearTimeout(t);
  streamChannels.delete(ch.id);
  try {
    ch.abort?.();
  } catch {
    /* gone already */
  }
  if (ch.file) rmSync(ch.file, { force: true });
}

/** Close every channel (agent shutdown, tests). */
export async function closeAllStreamChannels(): Promise<void> {
  for (const ch of [...streamChannels.values()]) closeStreamChannel(ch);
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/** Test hook: forget every channel without touching processes. */
export function _resetAgentStreams(): void {
  for (const ch of streamChannels.values()) for (const t of ch.timers) clearTimeout(t);
  streamChannels.clear();
  opening = 0;
}

/** Refuse params outside the kind's list: an operand nobody validates is never silently accepted. */
function assertKnownKeys(params: Params, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new Error(`Invalid stream param: ${key}`);
  }
}

/**
 * `stream.open {kind, direction?, maxBytes, …kind params}` → one line,
 * `ND-STREAM {"channel","salt"}`, inside the sealed reply. The registry
 * refuses it unless the request arrived sealed (the reply carries the key's
 * salt); the kind validates its params and the node's state here, so a
 * refusal comes back on the op, before any channel exists.
 */
async function streamOpenOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const kind = str(params, 'kind');
  if (kind === undefined || !Object.hasOwn(STREAM_KIND_HANDLERS, kind)) throw new Error('Invalid stream kind');
  const spec = AGENT_STREAM_KINDS[kind as AgentStreamKind];
  const handler = STREAM_KIND_HANDLERS[kind as AgentStreamKind];
  const direction = params['direction'];
  if (direction !== undefined && direction !== spec.direction) throw new Error('Invalid stream direction');
  const maxBytes = intOperand(params['maxBytes'], 1, STREAM_MAX_BYTES_CEILING, 'maxBytes');
  assertKnownKeys(params, ['kind', 'direction', 'maxBytes', ...handler.keys]);
  // The kind's own capability must be advertised (and not switched off) too.
  const { registeredCapabilities, capabilityKillSwitch } = await import('./index.js');
  if (!registeredCapabilities().includes(spec.cap) || capabilityKillSwitch(spec.cap) !== null) {
    throw new Error(`Stream kind ${kind} is not available on this node`);
  }
  if (streamChannels.size + opening >= STREAM_MAX_CHANNELS) {
    throw new Error(`Too many open streams on this node (at most ${STREAM_MAX_CHANNELS})`);
  }
  opening += 1;
  let prepared: PreparedStream;
  try {
    prepared = await handler.prepare(params, { maxBytes });
  } finally {
    opening -= 1;
  }
  const ch: StreamChannel = {
    id: randomBytes(16).toString('hex'),
    salt: randomBytes(FRAME_SALT_BYTES),
    kind: kind as AgentStreamKind,
    direction: spec.direction,
    maxBytes,
    prepared,
    state: 'pending',
    timers: [],
    abort: null,
    onHardCap: null,
    file: null,
  };
  const unref = (timer: NodeJS.Timeout) => {
    timer.unref?.();
    return timer;
  };
  ch.timers.push(
    unref(
      setTimeout(() => {
        if (ch.state === 'pending') closeStreamChannel(ch);
      }, STREAM_CHANNEL_TTL_MS),
    ),
    unref(
      setTimeout(() => {
        if (ch.onHardCap) ch.onHardCap();
        else closeStreamChannel(ch);
      }, STREAM_HARD_CAP_MS),
    ),
  );
  streamChannels.set(ch.id, ch);
  onLine(`ND-STREAM ${JSON.stringify({ channel: ch.id, salt: ch.salt.toString('base64') })}`);
  return 0;
}

export const streamOps: AgentOpModule = {
  name: 'agentOps/stream.ts',
  caps: ['stream'],
  ops: {
    'stream.open': { cap: 'stream', sealedOnly: true, run: (params, onLine) => streamOpenOp(params, onLine) },
  },
};

/** The parts of a `ws` socket the bridge uses. */
export interface AgentStreamSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close' | 'error', cb: () => void): unknown;
}

/** The channel id a handshake offers, or null. */
export function agentStreamChannelId(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const entry = raw
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith(AGENT_STREAM_PROTOCOL_PREFIX));
  const id = entry?.slice(AGENT_STREAM_PROTOCOL_PREFIX.length) ?? '';
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

/** The WebSocket handler of `GET /agent/stream`: anything but a pending channel closes 1008. */
export function attachStreamChannel(socket: AgentStreamSocket, protocolHeader: string | string[] | undefined, tokenHash: string): void {
  const id = agentStreamChannelId(protocolHeader);
  const ch = id === null ? undefined : streamChannels.get(id);
  if (!ch || ch.state !== 'pending') {
    try {
      socket.close(1008, 'unknown stream channel');
    } catch {
      /* already closed */
    }
    return;
  }
  // Consumed: a second connection with the same id finds nothing.
  ch.state = 'attached';
  bridgeStreamChannel(socket, ch, tokenHash);
}

const OPEN = 1;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Bridge one attached channel. The panel's first frame authenticates it
 * (anyone can race a WebSocket to the channel id; only the panel can derive
 * the key); nothing starts before that. Any bad frame, the socket closing or
 * the 6 h cap ends the channel, kills what it started and removes its file.
 */
function bridgeStreamChannel(socket: AgentStreamSocket, ch: StreamChannel, tokenHash: string): void {
  const key = deriveFrameKey(tokenHash, ch.salt, STREAM_HKDF_INFO);
  const rx = new FrameOpener(key, 'panel', STREAM_FRAME_TYPES);
  const tx = new FrameSealer(key, 'agent');
  const hash = createHash('sha256');
  let bytes = 0;
  let authed = false;
  let finished = false;
  const send = (frame: Buffer) => {
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(frame);
    } catch {
      /* closed: the close handler ends the channel */
    }
  };
  const finish = (code: number, reason: string) => {
    if (finished) return;
    finished = true;
    try {
      if (socket.readyState === OPEN) socket.close(code, reason);
    } catch {
      /* already closed */
    }
    closeStreamChannel(ch);
  };
  /** Tell the panel why (never anything secret: our own messages and a command's stderr tail), then close. */
  const failWith = (message: string) => {
    if (finished) return;
    send(tx.seal(STREAM_FRAME_TYPE.error, encodeStreamError(message)));
    finish(1011, 'stream failed');
  };
  ch.onHardCap = () => failWith('the stream hit its 6 h limit');
  const authTimer = setTimeout(() => {
    if (!authed) finish(1008, 'channel not authenticated');
  }, STREAM_AUTH_TIMEOUT_MS);
  authTimer.unref?.();
  ch.timers.push(authTimer);

  // ── agent → panel ─────────────────────────────────────────────────────────
  let source: StreamSource | null = null;
  let panelPaused = false;
  let pressurePaused = false;
  let drain: NodeJS.Timeout | undefined;
  const applyPause = () => {
    if (!source) return;
    if (panelPaused || pressurePaused) source.stream.pause();
    else source.stream.resume();
  };
  const startDownload = async (prepared: Extract<PreparedStream, { direction: 'agent-to-panel' }>) => {
    try {
      source = await prepared.start();
    } catch (err) {
      return failWith(errorMessage(err));
    }
    const src = source;
    ch.abort = () => {
      clearInterval(drain);
      src.abort();
    };
    if (finished) return src.abort();
    src.stream.on('data', (chunk: Buffer) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > ch.maxBytes) {
        src.abort();
        return failWith(`the stream exceeded its ${ch.maxBytes}-byte limit`);
      }
      hash.update(chunk);
      for (const frame of tx.sealData(chunk)) send(frame);
      if (!pressurePaused && socket.bufferedAmount > STREAM_BACKPRESSURE_HIGH) {
        pressurePaused = true;
        applyPause();
        drain = setInterval(() => {
          if (socket.readyState !== OPEN || socket.bufferedAmount <= STREAM_BACKPRESSURE_HIGH / 4) {
            clearInterval(drain);
            pressurePaused = false;
            applyPause();
          }
        }, 50);
        drain.unref?.();
      }
    });
    src.stream.on('error', (err) => failWith(`reading the stream source failed: ${errorMessage(err)}`));
    src.stream.on('end', () => {
      void src.done.then(
        (result) => {
          if (finished) return;
          send(tx.seal(STREAM_FRAME_TYPE.end, encodeStreamEnd({ bytes, sha256: hash.digest('hex'), result })));
          finish(1000, 'stream complete');
        },
        (err: unknown) => failWith(errorMessage(err)),
      );
    });
    applyPause();
  };

  // ── panel → agent ─────────────────────────────────────────────────────────
  let sink: Writable | null = null;
  let written: Promise<void> | null = null;
  let peerPaused = false;
  const startUpload = (prepared: Extract<PreparedStream, { direction: 'panel-to-agent' }>) => {
    const dir = transferRoot();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${ch.id}.part`);
    ch.file = file;
    const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    const head = prepared.gunzip ? createGunzip() : new PassThrough();
    let unpacked = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        unpacked += chunk.length;
        if (unpacked > ch.maxBytes) cb(new Error(`the unpacked archive exceeded its ${ch.maxBytes}-byte limit`));
        else cb(null, chunk);
      },
    });
    sink = head;
    written = pipeline(head, limiter, out);
    written.catch((err: unknown) => failWith(`storing the stream on the node failed: ${errorMessage(err)}`));
    ch.abort = () => {
      head.destroy();
    };
  };
  const onUploadEnd = async (payload: Buffer, prepared: Extract<PreparedStream, { direction: 'panel-to-agent' }>) => {
    const end = decodeStreamEnd(payload);
    if (!end || !sink || !written || !ch.file) return failWith('malformed end frame');
    sink.end();
    try {
      await written;
    } catch {
      return; // failWith already ran
    }
    const sha256 = hash.digest('hex');
    if (end.bytes !== bytes || end.sha256 !== sha256) {
      return failWith(
        `the stream was truncated or altered: the panel sent ${end.bytes} byte(s) sha256 ${end.sha256}, the node received ${bytes} byte(s) sha256 ${sha256}`,
      );
    }
    let result: Record<string, unknown>;
    try {
      result = await prepared.apply(ch.file);
    } catch (err) {
      return failWith(errorMessage(err));
    }
    if (finished) return;
    send(tx.seal(STREAM_FRAME_TYPE.end, encodeStreamEnd({ bytes, sha256, result })));
    finish(1000, 'stream complete');
  };

  socket.on('message', (data, isBinary) => {
    if (finished) return;
    if (!isBinary) return finish(1008, 'text frames are not part of this protocol');
    const raw = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data as Buffer[]) : Buffer.from(data as ArrayBuffer);
    let frame: { type: number; payload: Buffer };
    try {
      frame = rx.open(raw);
    } catch {
      return finish(1008, 'bad frame');
    }
    const prepared = ch.prepared;
    if (!authed) {
      authed = true;
      clearTimeout(authTimer);
      if (prepared.direction === 'agent-to-panel') void startDownload(prepared);
      else {
        try {
          startUpload(prepared);
        } catch (err) {
          return failWith(`could not store the stream on the node: ${errorMessage(err)}`);
        }
      }
    }
    switch (frame.type) {
      case STREAM_FRAME_TYPE.pause:
        if (prepared.direction === 'agent-to-panel') {
          panelPaused = true;
          applyPause();
        }
        return;
      case STREAM_FRAME_TYPE.resume:
        if (prepared.direction === 'agent-to-panel') {
          panelPaused = false;
          applyPause();
        }
        return;
      case STREAM_FRAME_TYPE.close:
        return finish(1000, 'closed by the panel');
      case STREAM_FRAME_TYPE.data: {
        if (prepared.direction !== 'panel-to-agent' || !sink) return failWith('unexpected data frame');
        bytes += frame.payload.length;
        if (bytes > ch.maxBytes) return failWith(`the stream exceeded its ${ch.maxBytes}-byte limit`);
        hash.update(frame.payload);
        const target = sink;
        if (!target.write(frame.payload) && !peerPaused) {
          peerPaused = true;
          send(tx.seal(STREAM_FRAME_TYPE.pause));
          target.once('drain', () => {
            peerPaused = false;
            send(tx.seal(STREAM_FRAME_TYPE.resume));
          });
        }
        return;
      }
      case STREAM_FRAME_TYPE.end:
        if (prepared.direction !== 'panel-to-agent') return failWith('unexpected end frame');
        void onUploadEnd(frame.payload, prepared);
        return;
      default:
        // `error` is the agent's to send.
        return failWith('unexpected frame');
    }
  });
  socket.on('close', () => finish(1000, ''));
  socket.on('error', () => finish(1011, ''));
}

// ── transfer directory hygiene (design §1.5) ─────────────────────────────────

let sweepTimer: NodeJS.Timeout | undefined;

/**
 * Remove transfer files older than {@link TRANSFER_MAX_AGE_MS} that no live
 * channel owns. A missing directory is nothing to do (it is never created
 * here). Returns how many files were removed.
 */
export function sweepTransferDir(dir: string = transferRoot(), now: number = Date.now()): number {
  if (!existsSync(dir)) return 0;
  const live = new Set([...streamChannels.values()].map((c) => c.file).filter((f): f is string => f !== null));
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (live.has(file)) continue;
    try {
      if (now - statSync(file).mtimeMs > TRANSFER_MAX_AGE_MS) {
        rmSync(file, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* raced with another remover */
    }
  }
  return removed;
}

/** Sweep at agent boot, then every 10 minutes (idempotent; the timer never holds the process open). */
export function startTransferSweep(): void {
  try {
    sweepTransferDir();
  } catch {
    /* best effort */
  }
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepTransferDir();
    } catch {
      /* best effort */
    }
  }, TRANSFER_SWEEP_EVERY_MS);
  sweepTimer.unref?.();
}
