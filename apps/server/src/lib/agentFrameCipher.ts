import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

/**
 * The frame cipher of a node terminal channel (0.15, DESIGN §1.5).
 *
 * A node terminal is opened with the sealed `terminal.open` agent op, which
 * answers a channel id and a fresh 32-byte salt INSIDE the sealed reply. The
 * panel then connects `GET /agent/terminal` (a WebSocket) and every binary
 * frame on it, in both directions, is authenticated encryption under a key
 * only the two ends can derive:
 *
 *   key   = HKDF-SHA256(sharedTokenHash, salt, 'ninedeploy-agent-terminal-v1', 32)
 *   iv    = dir(1B: 0x01 panel→agent, 0x02 agent→panel) ‖ 0x000000 ‖ counter(8B BE)
 *   frame = counter(8B BE) ‖ AES-256-GCM(key, iv, type(1B) ‖ payload) ‖ tag(16B)
 *
 * - The shared secret is the one the sealed `/agent/exec` envelope already
 *   uses (the sha256 of the agent token; see lib/agentSeal.ts), so nothing new
 *   has to be distributed. The salt is per channel, so every channel has its
 *   own key: a captured stream can be neither replayed into another channel
 *   nor spliced with one.
 * - Each direction counts from 0 and must increase by exactly 1. A gap, a
 *   reused counter, a frame from the wrong direction (its IV differs) or a
 *   failed tag is fatal: the opener refuses that frame and every later one,
 *   and the caller closes the socket.
 * - The counter travels in clear only so a receiver can tell "out of order"
 *   from "forged"; it is also inside the IV, so editing it fails the tag.
 *
 * `agentSeal.ts` is deliberately untouched: its envelope (JSON, timestamped,
 * per-message salt) suits one request and one reply, not a byte stream.
 *
 * Multi-node (design §1.4): the sealed stream channel (`stream.open`,
 * `GET /agent/stream`) uses the same frames under a key derived with a
 * different HKDF `info` ({@link STREAM_HKDF_INFO}), so a terminal key can
 * never open a stream frame and vice versa. The terminal derivation is
 * unchanged byte for byte (the default `info`).
 */

/** HKDF context string: domain-separates this key from the sealed envelope's. */
export const FRAME_HKDF_INFO = 'ninedeploy-agent-terminal-v1';
/** Multi-node: the stream channel's HKDF context string (never a terminal key). */
export const STREAM_HKDF_INFO = 'ninedeploy-agent-stream-v1';
/** Salt length the agent generates per channel. */
export const FRAME_SALT_BYTES = 32;

/** Who SENT a frame. The receiver opens with the other side's direction. */
export type FrameDirection = 'panel' | 'agent';
const DIR_BYTE: Record<FrameDirection, number> = { panel: 0x01, agent: 0x02 };

/** Plaintext frame types. */
export const FRAME_TYPE = {
  /** Terminal bytes (stdin panel→agent, output agent→panel). */
  data: 0,
  /** `{"cols","rows"}` JSON (panel→agent). The panel's first frame is always one: it authenticates the channel. */
  resize: 1,
  /** `{"code": number|null}` JSON (agent→panel): the process ended. */
  exit: 2,
  /** The sender is closing the channel; payload: an optional UTF-8 reason. */
  close: 3,
  /** Flow control (panel→agent): stop reading the process's output. */
  pause: 4,
  /** Flow control (panel→agent): resume reading it. */
  resume: 5,
} as const;
export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];
const KNOWN_TYPES: ReadonlySet<number> = new Set<number>(Object.values(FRAME_TYPE));

/**
 * Multi-node: the stream channel's frame types. data, close, pause and resume
 * keep the terminal's numbers; `end` and `error` are new. A terminal opener
 * still refuses 6 and 7 (`unknown_type`), as it always did.
 */
export const STREAM_FRAME_TYPE = {
  /** Stream bytes. */
  data: 0,
  /** The sender is abandoning the stream; payload: an optional UTF-8 reason. */
  close: 3,
  /** Flow control, either way: stop sending data frames. */
  pause: 4,
  /** Flow control, either way: send again. The panel's first frame is always one: it authenticates the channel. */
  resume: 5,
  /** `{"bytes","sha256","result"?}` JSON: the sender's count and sha256 of every data byte it sent (and the agent's result). */
  end: 6,
  /** `{"message"}` JSON (agent→panel): the stream failed; nothing was applied. */
  error: 7,
} as const;
export type StreamFrameType = (typeof STREAM_FRAME_TYPE)[keyof typeof STREAM_FRAME_TYPE];
/** The types a stream opener accepts. */
export const STREAM_FRAME_TYPES: ReadonlySet<number> = new Set<number>(Object.values(STREAM_FRAME_TYPE));

/** Largest data payload one frame carries; longer writes are split. */
export const FRAME_DATA_CHUNK = 32 * 1024;
const COUNTER_BYTES = 8;
const TAG_BYTES = 16;
/** Smallest valid frame: counter, one ciphertext byte (the type), tag. */
const MIN_FRAME_BYTES = COUNTER_BYTES + 1 + TAG_BYTES;
const MAX_COUNTER = (1n << 64n) - 1n;

export type FrameCipherErrorCode = 'malformed' | 'out_of_order' | 'auth' | 'unknown_type' | 'exhausted' | 'poisoned';

/** A frame that must close the channel. `code` names why (for logs and tests, never for the peer). */
export class FrameCipherError extends Error {
  constructor(readonly code: FrameCipherErrorCode) {
    super(`terminal frame rejected (${code})`);
    this.name = 'FrameCipherError';
  }
}

/**
 * The channel key. `sharedTokenHash` is the hex sha256 of the agent token
 * (what both ends hold). `info` domain-separates the channel kinds: the
 * default is the terminal's (0.15, unchanged); streams pass
 * {@link STREAM_HKDF_INFO}.
 */
export function deriveFrameKey(sharedTokenHash: string, salt: Buffer, info: string = FRAME_HKDF_INFO): Buffer {
  if (!sharedTokenHash) throw new Error('Cannot derive a terminal key without the shared secret');
  if (salt.length !== FRAME_SALT_BYTES) throw new Error('Invalid terminal channel salt');
  if (info !== FRAME_HKDF_INFO && info !== STREAM_HKDF_INFO) throw new Error('Unknown frame key domain');
  return Buffer.from(hkdfSync('sha256', Buffer.from(sharedTokenHash, 'utf8'), salt, Buffer.from(info, 'utf8'), 32));
}

/** The 12-byte GCM IV for one frame. */
export function frameIv(dir: FrameDirection, counter: bigint): Buffer {
  const iv = Buffer.alloc(12);
  iv[0] = DIR_BYTE[dir];
  iv.writeBigUInt64BE(counter, 4);
  return iv;
}

/** Seals the frames ONE side sends. */
export class FrameSealer {
  private counter = 0n;

  constructor(
    private readonly key: Buffer,
    private readonly dir: FrameDirection,
  ) {}

  seal(type: FrameType | StreamFrameType, payload: Buffer = Buffer.alloc(0)): Buffer {
    if (this.counter > MAX_COUNTER) throw new FrameCipherError('exhausted');
    const counter = this.counter;
    this.counter += 1n;
    const header = Buffer.alloc(COUNTER_BYTES);
    header.writeBigUInt64BE(counter);
    const cipher = createCipheriv('aes-256-gcm', this.key, frameIv(this.dir, counter));
    const ct = Buffer.concat([cipher.update(Buffer.from([type])), cipher.update(payload), cipher.final()]);
    return Buffer.concat([header, ct, cipher.getAuthTag()]);
  }

  /** `data` frames for `bytes`, split at {@link FRAME_DATA_CHUNK}. */
  sealData(bytes: Buffer): Buffer[] {
    const out: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += FRAME_DATA_CHUNK) out.push(this.seal(FRAME_TYPE.data, bytes.subarray(at, at + FRAME_DATA_CHUNK)));
    return out;
  }
}

/** Opens the frames the OTHER side sent, in order. Any failure poisons it for good. */
export class FrameOpener {
  private expected = 0n;
  private poisoned = false;

  /**
   * `from` is the direction of the sender (the agent opens `'panel'` frames).
   * `types` is the set of frame types the channel speaks: the terminal's by
   * default, {@link STREAM_FRAME_TYPES} for a stream.
   */
  constructor(
    private readonly key: Buffer,
    private readonly from: FrameDirection,
    private readonly types: ReadonlySet<number> = KNOWN_TYPES,
  ) {}

  open(frame: Buffer): { type: FrameType | StreamFrameType; payload: Buffer } {
    if (this.poisoned) throw new FrameCipherError('poisoned');
    try {
      if (frame.length < MIN_FRAME_BYTES) throw new FrameCipherError('malformed');
      const counter = frame.readBigUInt64BE(0);
      if (counter !== this.expected) throw new FrameCipherError('out_of_order');
      let pt: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.key, frameIv(this.from, counter));
        decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
        pt = Buffer.concat([decipher.update(frame.subarray(COUNTER_BYTES, frame.length - TAG_BYTES)), decipher.final()]);
      } catch {
        throw new FrameCipherError('auth');
      }
      const type = pt[0] as number;
      if (!this.types.has(type)) throw new FrameCipherError('unknown_type');
      this.expected += 1n;
      return { type: type as FrameType | StreamFrameType, payload: pt.subarray(1) };
    } catch (err) {
      this.poisoned = true;
      throw err instanceof FrameCipherError ? err : new FrameCipherError('malformed');
    }
  }
}

// ── payload codecs ──────────────────────────────────────────────────────────

/** Terminal size bounds (the browser protocol's: cols 10–500, rows 5–200). */
export const TERMINAL_COLS = [10, 500] as const;
export const TERMINAL_ROWS = [5, 200] as const;

const inRange = (n: unknown, [min, max]: readonly [number, number]): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

export const encodeResize = (cols: number, rows: number): Buffer => Buffer.from(JSON.stringify({ cols, rows }), 'utf8');

/** Null when the payload is not a valid size. */
export function decodeResize(payload: Buffer): { cols: number; rows: number } | null {
  try {
    const v = JSON.parse(payload.toString('utf8')) as { cols?: unknown; rows?: unknown };
    return inRange(v.cols, TERMINAL_COLS) && inRange(v.rows, TERMINAL_ROWS) ? { cols: v.cols, rows: v.rows } : null;
  } catch {
    return null;
  }
}

export const encodeExit = (code: number | null): Buffer => Buffer.from(JSON.stringify({ code }), 'utf8');

export function decodeExit(payload: Buffer): number | null {
  try {
    const v = JSON.parse(payload.toString('utf8')) as { code?: unknown };
    return typeof v.code === 'number' && Number.isInteger(v.code) ? v.code : null;
  } catch {
    return null;
  }
}

// ── stream payload codecs (multi-node) ──────────────────────────────────────

/** What an `end` frame carries. `result` is the agent's answer (an image id, a volume name). */
export interface StreamEnd {
  bytes: number;
  sha256: string;
  result?: Record<string, unknown>;
}

export const encodeStreamEnd = (end: StreamEnd): Buffer => Buffer.from(JSON.stringify(end), 'utf8');

/** Null when the payload is not a valid `end`. */
export function decodeStreamEnd(payload: Buffer): StreamEnd | null {
  try {
    const v = JSON.parse(payload.toString('utf8')) as { bytes?: unknown; sha256?: unknown; result?: unknown };
    if (typeof v.bytes !== 'number' || !Number.isSafeInteger(v.bytes) || v.bytes < 0) return null;
    if (typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) return null;
    if (v.result !== undefined && (typeof v.result !== 'object' || v.result === null || Array.isArray(v.result))) return null;
    return v.result === undefined ? { bytes: v.bytes, sha256: v.sha256 } : { bytes: v.bytes, sha256: v.sha256, result: v.result as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Longest error message a stream carries. */
const STREAM_ERROR_MAX = 1000;

export const encodeStreamError = (message: string): Buffer =>
  Buffer.from(JSON.stringify({ message: message.slice(0, STREAM_ERROR_MAX) }), 'utf8');

/** The message of an `error` frame; a malformed one still reads as a failure. */
export function decodeStreamError(payload: Buffer): string {
  try {
    const v = JSON.parse(payload.toString('utf8')) as { message?: unknown };
    if (typeof v.message === 'string' && v.message !== '') return v.message.slice(0, STREAM_ERROR_MAX);
  } catch {
    /* fall through */
  }
  return 'the agent reported a stream error';
}
