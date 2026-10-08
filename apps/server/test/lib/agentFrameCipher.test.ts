import { describe, expect, it } from 'vitest';
import {
  decodeExit,
  decodeResize,
  deriveFrameKey,
  encodeExit,
  encodeResize,
  FRAME_DATA_CHUNK,
  FRAME_TYPE,
  FrameCipherError,
  frameIv,
  FrameOpener,
  FrameSealer,
} from '../../src/lib/agentFrameCipher.js';

/**
 * 0.15 (T2b): the node terminal channel's frame cipher (DESIGN §1.5). The
 * vector below was computed independently with node:crypto (HKDF-SHA256 +
 * AES-256-GCM) from the construction in the module header, so a change to
 * the key derivation, IV layout or framing fails here.
 */
const SECRET = 'a'.repeat(64);
const SALT = Buffer.alloc(32, 7);
const KEY_HEX = '5f3d21d9ba8c4c1d2ba96b4542c11b6c21a566d9f568d5fe5ff12cd05e55a946';
const FRAME0_HEX = '0000000000000000d11381e1a214aa997ad320bc4fedcde15c2b31cc'; // panel → agent, counter 0, data "ls\r"

const key = () => deriveFrameKey(SECRET, SALT);
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof FrameCipherError ? err.code : `other: ${String(err)}`;
  }
  return 'no error';
};

describe('agent frame cipher', () => {
  it('matches the known vector (key derivation, IV and framing)', () => {
    expect(key().toString('hex')).toBe(KEY_HEX);
    expect(frameIv('panel', 0n).toString('hex')).toBe('010000000000000000000000');
    expect(frameIv('agent', 258n).toString('hex')).toBe('020000000000000000000102');
    const frame = new FrameSealer(key(), 'panel').seal(FRAME_TYPE.data, Buffer.from('ls\r'));
    expect(frame.toString('hex')).toBe(FRAME0_HEX);
    expect(new FrameOpener(key(), 'panel').open(Buffer.from(FRAME0_HEX, 'hex'))).toEqual({ type: FRAME_TYPE.data, payload: Buffer.from('ls\r') });
  });

  it('round-trips every frame type in order, both directions', () => {
    const toAgent = new FrameSealer(key(), 'panel');
    const atAgent = new FrameOpener(key(), 'panel');
    const toPanel = new FrameSealer(key(), 'agent');
    const atPanel = new FrameOpener(key(), 'agent');
    expect(atAgent.open(toAgent.seal(FRAME_TYPE.resize, encodeResize(120, 32)))).toMatchObject({ type: FRAME_TYPE.resize });
    expect(atAgent.open(toAgent.seal(FRAME_TYPE.pause)).type).toBe(FRAME_TYPE.pause);
    expect(atAgent.open(toAgent.seal(FRAME_TYPE.resume)).type).toBe(FRAME_TYPE.resume);
    expect(atPanel.open(toPanel.seal(FRAME_TYPE.data, Buffer.from('$ '))).payload.toString()).toBe('$ ');
    const exit = atPanel.open(toPanel.seal(FRAME_TYPE.exit, encodeExit(3)));
    expect(decodeExit(exit.payload)).toBe(3);
    expect(atPanel.open(toPanel.seal(FRAME_TYPE.close)).type).toBe(FRAME_TYPE.close);
  });

  it('a counter gap closes the channel', () => {
    const tx = new FrameSealer(key(), 'panel');
    const rx = new FrameOpener(key(), 'panel');
    tx.seal(FRAME_TYPE.data, Buffer.from('dropped'));
    expect(code(() => rx.open(tx.seal(FRAME_TYPE.data, Buffer.from('x'))))).toBe('out_of_order');
  });

  it('a replayed (reused) frame closes the channel, and the opener stays poisoned', () => {
    const tx = new FrameSealer(key(), 'panel');
    const rx = new FrameOpener(key(), 'panel');
    const f0 = tx.seal(FRAME_TYPE.data, Buffer.from('rm -rf /tmp/x\r'));
    rx.open(f0);
    expect(code(() => rx.open(f0))).toBe('out_of_order');
    expect(code(() => rx.open(tx.seal(FRAME_TYPE.data, Buffer.from('ok'))))).toBe('poisoned');
  });

  it('a frame from the wrong direction (reflected back at its sender) fails authentication', () => {
    const fromPanel = new FrameSealer(key(), 'panel').seal(FRAME_TYPE.data, Buffer.from('id\r'));
    expect(code(() => new FrameOpener(key(), 'agent').open(fromPanel))).toBe('auth');
  });

  it('a tampered tag, ciphertext or counter header fails', () => {
    const fresh = () => new FrameSealer(key(), 'panel').seal(FRAME_TYPE.data, Buffer.from('whoami\r'));
    const tag = fresh();
    tag[tag.length - 1] = (tag[tag.length - 1] as number) ^ 1;
    expect(code(() => new FrameOpener(key(), 'panel').open(tag))).toBe('auth');
    const body = fresh();
    body[9] = (body[9] as number) ^ 1;
    expect(code(() => new FrameOpener(key(), 'panel').open(body))).toBe('auth');
    const header = fresh();
    header[7] = 1; // counter 1 where 0 is expected
    expect(code(() => new FrameOpener(key(), 'panel').open(header))).toBe('out_of_order');
    expect(code(() => new FrameOpener(key(), 'panel').open(Buffer.alloc(10)))).toBe('malformed');
  });

  it('another channel (salt) or another secret cannot open the frame: no splicing across channels', () => {
    const frame = new FrameSealer(key(), 'panel').seal(FRAME_TYPE.data, Buffer.from('x'));
    expect(code(() => new FrameOpener(deriveFrameKey(SECRET, Buffer.alloc(32, 8)), 'panel').open(frame))).toBe('auth');
    expect(code(() => new FrameOpener(deriveFrameKey('b'.repeat(64), SALT), 'panel').open(frame))).toBe('auth');
    expect(() => deriveFrameKey(SECRET, Buffer.alloc(16))).toThrow(/salt/);
    expect(() => deriveFrameKey('', SALT)).toThrow(/shared secret/);
  });

  it('refuses an unknown frame type even when it authenticates', () => {
    const tx = new FrameSealer(key(), 'panel');
    expect(code(() => new FrameOpener(key(), 'panel').open(tx.seal(9 as never)))).toBe('unknown_type');
  });

  it('splits long data into chunks that stay in order', () => {
    const tx = new FrameSealer(key(), 'agent');
    const rx = new FrameOpener(key(), 'agent');
    const big = Buffer.alloc(FRAME_DATA_CHUNK * 2 + 5, 0x61);
    const frames = tx.sealData(big);
    expect(frames).toHaveLength(3);
    expect(Buffer.concat(frames.map((f) => rx.open(f).payload)).equals(big)).toBe(true);
  });

  it('validates resize and exit payloads', () => {
    expect(decodeResize(encodeResize(80, 24))).toEqual({ cols: 80, rows: 24 });
    expect(decodeResize(encodeResize(9, 24))).toBeNull();
    expect(decodeResize(encodeResize(80, 201))).toBeNull();
    expect(decodeResize(Buffer.from('nope'))).toBeNull();
    expect(decodeExit(encodeExit(null))).toBeNull();
    expect(decodeExit(Buffer.from('{'))).toBeNull();
  });
});
