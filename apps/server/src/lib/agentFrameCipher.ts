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
 */

/** HKDF context string: domain-separates this key from the sealed envelope's. */
export const FRAME_HKDF_INFO = 'ninedeploy-agent-terminal-v1';
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
const KNOWN_TYPES = new Set<number>(Object.values(FRAME_TYPE));

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

/** The channel key. `sharedTokenHash` is the hex sha256 of the agent token (what both ends hold). */
export function deriveFrameKey(sharedTokenHash: string, salt: Buffer): Buffer {
  if (!sharedTokenHash) throw new Error('Cannot derive a terminal key without the shared secret');
  if (salt.length !== FRAME_SALT_BYTES) throw new Error('Invalid terminal channel salt');
  return Buffer.from(hkdfSync('sha256', Buffer.from(sharedTokenHash, 'utf8'), salt, Buffer.from(FRAME_HKDF_INFO, 'utf8'), 32));
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

  seal(type: FrameType, payload: Buffer = Buffer.alloc(0)): Buffer {
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

  /** `from` is the direction of the sender (the agent opens `'panel'` frames). */
  constructor(
    private readonly key: Buffer,
    private readonly from: FrameDirection,
  ) {}

  open(frame: Buffer): { type: FrameType; payload: Buffer } {
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
      if (!KNOWN_TYPES.has(type)) throw new FrameCipherError('unknown_type');
      this.expected += 1n;
      return { type: type as FrameType, payload: pt.subarray(1) };
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
