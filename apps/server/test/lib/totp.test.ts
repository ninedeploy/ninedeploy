import { describe, expect, it } from 'vitest';
import {
  base32Decode, base32Encode, generateSecret, hotp, otpauthUri, totpAt, verifyTotp,
} from '../../src/lib/totp.js';

describe('base32', () => {
  it('round-trips buffers', () => {
    const buf = Buffer.from('hello ninedeploy');
    expect(base32Decode(base32Encode(buf)).toString()).toBe('hello ninedeploy');
  });

  it('decodes the RFC 4226 test vector secret', () => {
    // "12345678901234567890" → GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString()).toBe('12345678901234567890');
  });

  it('ignores lowercase, spaces and padding in input', () => {
    expect(base32Decode('gezd gnbv').toString()).toBe(base32Decode('GEZDGNBV').toString());
  });
});

describe('hotp (RFC 4226 test vectors)', () => {
  const secret = Buffer.from('12345678901234567890');
  it('produces the documented codes for counters 0..4', () => {
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 1)).toBe('287082');
    expect(hotp(secret, 2)).toBe('359152');
    expect(hotp(secret, 3)).toBe('969429');
    expect(hotp(secret, 4)).toBe('338314');
  });
});

describe('totpAt / verifyTotp', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const t = 59_000; // RFC 6238 SHA-1 test time → 94287082 → code 287082

  it('produces the RFC 6238 code at t=59s', () => {
    expect(totpAt(secret, t)).toBe('287082');
  });

  it('verifies the current code', () => {
    const code = totpAt(secret, Date.now());
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('accepts codes from the ±1 step window', () => {
    const now = Date.now();
    const prev = totpAt(secret, now - 30_000);
    const next = totpAt(secret, now + 30_000);
    expect(verifyTotp(secret, prev, now)).toBe(true);
    expect(verifyTotp(secret, next, now)).toBe(true);
  });

  it('rejects wrong, malformed and out-of-window codes', () => {
    const now = Date.now();
    expect(verifyTotp(secret, '000000', now)).toBe(false);
    expect(verifyTotp(secret, 'abc', now)).toBe(false);
    expect(verifyTotp(secret, '', now)).toBe(false);
    const far = totpAt(secret, now + 120_000);
    expect(verifyTotp(secret, far, now)).toBe(false);
  });
});

describe('generateSecret / otpauthUri', () => {
  it('generates a fresh, verifiable 32-char secret', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
    const code = totpAt(a, Date.now());
    expect(verifyTotp(a, code)).toBe(true);
  });

  it('builds a standard otpauth URI', () => {
    const uri = otpauthUri('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'ada@example.com');
    expect(uri).toBe(
      'otpauth://totp/NineDeploy%3Aada%40example.com' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=NineDeploy&algorithm=SHA1&digits=6&period=30',
    );
  });
});
