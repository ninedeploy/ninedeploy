import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238) with zero dependencies — HMAC-SHA1 over a base32 secret,
 * 6 digits, 30-second period, ±1 step drift window. Compatible with every
 * authenticator app (Google Authenticator, 1Password, Aegis, …).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;
// NOTE: HMAC-SHA1 is the RFC 6238 standard for TOTP (required for authenticator
// app compatibility). HMAC's security does not depend on SHA-1 collision
// resistance, so this is not a weak-crypto usage.

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generate a fresh 20-byte (160-bit) secret in base32. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP for a counter value. */
export function hotp(secret: Buffer, counter: number): string {
  // The counter is an 8-byte big-endian value.
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const digest = createHmac('sha1', secret).update(buf).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The TOTP code for a unix timestamp. */
export function totpAt(secret: string, timestampMs: number): string {
  return hotp(base32Decode(secret), Math.floor(timestampMs / 1000 / PERIOD));
}

/**
 * Which time step a code belongs to, or `null` if it matches none.
 *
 * Returning the step (rather than a bare boolean) is what makes single-use
 * enforcement possible: the caller records the highest step it has accepted
 * for the account and refuses anything not strictly newer, so a code observed
 * over the shoulder or lifted by a phishing proxy cannot be replayed for the
 * rest of its ±1-step (90 s) validity window. See `consumeTotpCode` in
 * `lib/totpReplay.ts`.
 *
 * Constant-time-ish: always compares all three candidates and never
 * short-circuits on the first match.
 */
export function verifyTotpStep(secret: string, code: string, timestampMs = Date.now()): number | null {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const counter = Math.floor(timestampMs / 1000 / PERIOD);
  let matched: number | null = null;
  for (const drift of [-1, 0, 1]) {
    const step = counter + drift;
    const expected = hotp(base32Decode(secret), step);
    // XOR-fold both strings so every candidate is always fully compared.
    let diff = normalized.length ^ expected.length;
    for (let i = 0; i < Math.min(normalized.length, expected.length); i++) {
      diff |= normalized.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) matched = step;
  }
  return matched;
}

/**
 * Verify a code against the secret with a ±1 step window (handles clock
 * drift between the phone and the server).
 *
 * NOTE: this answers "is this code currently valid", not "may this code be
 * used". Anything that authenticates a user must go through `consumeTotpCode`
 * so the code is spent.
 */
export function verifyTotp(secret: string, code: string, timestampMs = Date.now()): boolean {
  return verifyTotpStep(secret, code, timestampMs) !== null;
}

/** otpauth:// URI for authenticator apps. */
export function otpauthUri(secret: string, email: string, issuer = 'NineDeploy'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
