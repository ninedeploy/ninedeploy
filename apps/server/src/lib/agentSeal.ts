import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Sealed envelope for the agent protocol.
 *
 * The problem this solves
 * ----------------------
 * `lib/agentClient.ts` talks to remote agents over plain `http://` with the
 * shared agent token in a header, and there is no TLS option. Two things
 * therefore crossed the network in cleartext:
 *
 *   • the agent token itself, which is full remote-execution authority, and
 *   • the service's DECRYPTED secrets — the `file.writeEnv` operation ships
 *     database passwords and API keys so the remote container can be started
 *     with them.
 *
 * Anyone able to observe the link between core and agent could read both.
 *
 * Why not TLS
 * -----------
 * TLS is the obvious answer and the right long-term one, but it needs an X.509
 * certificate on every agent, and Node can parse certificates without being
 * able to generate them — so it would mean either a new dependency or
 * hand-rolled DER encoding, plus a distribution and rotation story for a
 * feature that is optional to begin with. This module gets the confidentiality
 * and integrity properties now, over the transport that already exists, using
 * the shared secret both ends already hold.
 *
 * Construction
 * ------------
 * Standard authenticated encryption, no novel cryptography:
 *
 *   key   = HKDF-SHA256(secret, salt = 16 random bytes, info = "ninedeploy-agent-v1")
 *   body  = AES-256-GCM(key, iv = 12 random bytes, aad = "1." + timestamp)
 *
 * A fresh salt per message means the key is never reused across messages, so a
 * repeated IV cannot happen even if the RNG misbehaves. The timestamp is bound
 * in as additional authenticated data, so it cannot be edited to widen the
 * replay window without failing the tag check, and `open()` refuses anything
 * outside `MAX_SKEW_MS` — a captured envelope stops being useful after five
 * minutes.
 *
 * What the shared secret is
 * -------------------------
 * The SHA-256 of the agent token, not the token itself. The core decrypts the
 * raw token from `servers.token_encrypted` and can hash it; the agent is
 * configured with the hash (`NINEDEPLOY_AGENT_TOKEN`) and never sees the raw
 * value. The hash is a 256-bit value derived from a 256-bit random token, so it
 * is a fine KDF input, and it is the only secret both ends possess.
 *
 * What this does NOT provide: protection against an attacker who has already
 * compromised the agent host (they hold the key, and they can read the env
 * files the agent writes anyway), and no forward secrecy. Agents should still
 * live on a private network.
 */

/** Envelope version. Bumped if the construction ever changes. */
export const SEAL_VERSION = 1;

/** HKDF context string — domain-separates this key from any other use. */
const HKDF_INFO = 'ninedeploy-agent-v1';

/**
 * How far a message's timestamp may be from ours. Wide enough for ordinary
 * clock drift between two hosts, narrow enough that a captured envelope is
 * useless within the hour.
 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

export interface SealedEnvelope {
  v: number;
  /** HKDF salt, base64. */
  s: string;
  /** AES-GCM IV, base64. */
  i: string;
  /** Ciphertext, base64. */
  c: string;
  /** GCM auth tag, base64. */
  t: string;
  /** Unix milliseconds, bound into the AAD. */
  ts: number;
}

/** True when a value has the shape of a sealed envelope (not that it verifies). */
export function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['v'] === 'number' &&
    typeof e['s'] === 'string' &&
    typeof e['i'] === 'string' &&
    typeof e['c'] === 'string' &&
    typeof e['t'] === 'string' &&
    typeof e['ts'] === 'number'
  );
}

/** Derive the per-message key. */
function deriveKey(secret: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), salt, Buffer.from(HKDF_INFO, 'utf8'), 32));
}

/** Additional authenticated data: version + timestamp, so neither can be edited. */
function aad(version: number, ts: number): Buffer {
  return Buffer.from(`${version}.${ts}`, 'utf8');
}

/** Thrown when an envelope cannot be opened. Never says WHY, to avoid an oracle. */
export class SealError extends Error {
  constructor(message = 'Sealed payload could not be verified') {
    super(message);
    this.name = 'SealError';
  }
}

/**
 * Seal an arbitrary JSON-serialisable payload.
 *
 * `now` is injectable so tests can drive the replay window without faking
 * timers around the whole crypto path.
 */
export function seal(secret: string, payload: unknown, now: number = Date.now()): SealedEnvelope {
  if (!secret) throw new SealError('Cannot seal without a shared secret');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(SEAL_VERSION, now));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    v: SEAL_VERSION,
    s: salt.toString('base64'),
    i: iv.toString('base64'),
    c: ct.toString('base64'),
    t: cipher.getAuthTag().toString('base64'),
    ts: now,
  };
}

/**
 * Open a sealed envelope, or throw `SealError`.
 *
 * Every failure — wrong secret, tampered ciphertext, edited timestamp, unknown
 * version, malformed field — raises the same error with the same message. A
 * caller cannot use the distinction to learn anything, and neither can an
 * attacker probing the endpoint.
 */
export function open<T = unknown>(secret: string, envelope: unknown, now: number = Date.now()): T {
  if (!secret) throw new SealError();
  if (!isSealedEnvelope(envelope)) throw new SealError();
  if (envelope.v !== SEAL_VERSION) throw new SealError();
  if (!Number.isFinite(envelope.ts) || Math.abs(now - envelope.ts) > MAX_SKEW_MS) throw new SealError();
  try {
    const salt = Buffer.from(envelope.s, 'base64');
    const iv = Buffer.from(envelope.i, 'base64');
    const tag = Buffer.from(envelope.t, 'base64');
    // Reject wrong-sized inputs explicitly: `createDecipheriv` accepts some of
    // them and fails later with a less specific error.
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new SealError();
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
    decipher.setAAD(aad(envelope.v, envelope.ts));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(Buffer.from(envelope.c, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  } catch {
    throw new SealError();
  }
}
