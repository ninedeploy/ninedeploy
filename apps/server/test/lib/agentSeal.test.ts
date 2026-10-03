/**
 * The sealed envelope is the only thing standing between an on-path observer
 * and (a) the agent token, which is unrestricted remote execution on the agent
 * host, and (b) the DECRYPTED service secrets that `file.writeEnv` ships so the
 * remote container can start with them. There is no TLS on this transport.
 *
 * So the tests that matter here are the negative ones: every way an attacker
 * might try to bend an envelope must fail, and must fail identically — a
 * distinguishable error would turn `/agent/exec` into a decryption oracle.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SKEW_MS,
  SEAL_VERSION,
  SealError,
  isSealedEnvelope,
  open,
  seal,
} from '../../src/lib/agentSeal.js';

const SECRET = 'a'.repeat(64); // shaped like sha256(token)
const PAYLOAD = { op: 'file.writeEnv', params: { content: 'DB_PASSWORD=hunter2' } };

/** Fail the way `open` fails: same class, same message, every time. */
function expectSealFailure(fn: () => unknown) {
  expect(fn).toThrow(SealError);
  expect(fn).toThrow('Sealed payload could not be verified');
}

describe('seal / open round trip', () => {
  it('returns exactly what went in', () => {
    expect(open(SECRET, seal(SECRET, PAYLOAD))).toEqual(PAYLOAD);
  });

  it('carries the secrets in the ciphertext, not in the envelope', () => {
    const env = seal(SECRET, PAYLOAD);
    expect(JSON.stringify(env)).not.toContain('hunter2');
    expect(JSON.stringify(env)).not.toContain('file.writeEnv');
  });

  it('never repeats an envelope for the same payload', () => {
    // Fresh salt AND fresh IV per message, so identical plaintexts are not
    // linkable and an IV can never repeat under one key.
    const a = seal(SECRET, PAYLOAD);
    const b = seal(SECRET, PAYLOAD);
    expect(a.c).not.toBe(b.c);
    expect(a.s).not.toBe(b.s);
    expect(a.i).not.toBe(b.i);
  });

  it('handles payloads the protocol actually sends', () => {
    for (const p of [null, 0, '', [], { lines: [], exitCode: 0, envFile: null }]) {
      expect(open(SECRET, seal(SECRET, p))).toEqual(p);
    }
  });

  it('refuses to seal without a secret', () => {
    expect(() => seal('', PAYLOAD)).toThrow(SealError);
  });
});

describe('open rejects tampering', () => {
  it('rejects a wrong secret', () => {
    expectSealFailure(() => open('b'.repeat(64), seal(SECRET, PAYLOAD)));
  });

  it('rejects an empty secret', () => {
    expectSealFailure(() => open('', seal(SECRET, PAYLOAD)));
  });

  it('rejects flipped ciphertext', () => {
    const env = seal(SECRET, PAYLOAD);
    const ct = Buffer.from(env.c, 'base64');
    ct[0] = (ct[0] as number) ^ 0x01;
    expectSealFailure(() => open(SECRET, { ...env, c: ct.toString('base64') }));
  });

  it('rejects a swapped auth tag', () => {
    const env = seal(SECRET, PAYLOAD);
    const other = seal(SECRET, PAYLOAD);
    expectSealFailure(() => open(SECRET, { ...env, t: other.t }));
  });

  it('rejects a salt from a different message', () => {
    // The salt selects the key, so swapping it is a key-confusion attempt.
    const env = seal(SECRET, PAYLOAD);
    const other = seal(SECRET, PAYLOAD);
    expectSealFailure(() => open(SECRET, { ...env, s: other.s }));
  });

  it('rejects a swapped IV', () => {
    const env = seal(SECRET, PAYLOAD);
    const other = seal(SECRET, PAYLOAD);
    expectSealFailure(() => open(SECRET, { ...env, i: other.i }));
  });

  it('rejects a spliced envelope built from two valid ones', () => {
    const a = seal(SECRET, { op: 'docker.stop', params: { name: 'web' } });
    const b = seal(SECRET, { op: 'docker.run', params: { name: 'evil' } });
    expectSealFailure(() => open(SECRET, { ...a, c: b.c, t: b.t }));
  });
});

describe('open rejects replay and downgrade', () => {
  it('rejects an envelope older than the skew window', () => {
    const now = 1_800_000_000_000;
    const env = seal(SECRET, PAYLOAD, now);
    expect(open(SECRET, env, now + MAX_SKEW_MS - 1)).toEqual(PAYLOAD);
    expectSealFailure(() => open(SECRET, env, now + MAX_SKEW_MS + 1));
  });

  it('rejects an envelope from too far in the future', () => {
    const now = 1_800_000_000_000;
    const env = seal(SECRET, PAYLOAD, now + MAX_SKEW_MS + 1);
    expectSealFailure(() => open(SECRET, env, now));
  });

  it('rejects a timestamp edited to widen the window', () => {
    // The timestamp is bound in as AAD precisely so this cannot work: an
    // attacker holding a captured envelope cannot make it fresh again.
    const now = 1_800_000_000_000;
    const env = seal(SECRET, PAYLOAD, now);
    const stale = now + MAX_SKEW_MS + 60_000;
    expectSealFailure(() => open(SECRET, { ...env, ts: stale }, stale));
  });

  it('rejects a non-finite timestamp', () => {
    const env = seal(SECRET, PAYLOAD);
    expectSealFailure(() => open(SECRET, { ...env, ts: Number.NaN }));
  });

  it('rejects an unknown envelope version', () => {
    const env = seal(SECRET, PAYLOAD);
    expectSealFailure(() => open(SECRET, { ...env, v: SEAL_VERSION + 1 }));
    expectSealFailure(() => open(SECRET, { ...env, v: 0 }));
  });
});

describe('open rejects malformed input', () => {
  it('rejects anything that is not an envelope', () => {
    for (const bad of [undefined, null, 0, 'x', [], {}, { v: 1 }]) {
      expectSealFailure(() => open(SECRET, bad));
    }
  });

  it('rejects wrong field sizes rather than letting the cipher decide', () => {
    const env = seal(SECRET, PAYLOAD);
    expectSealFailure(() => open(SECRET, { ...env, s: Buffer.alloc(8).toString('base64') }));
    expectSealFailure(() => open(SECRET, { ...env, i: Buffer.alloc(16).toString('base64') }));
    expectSealFailure(() => open(SECRET, { ...env, t: Buffer.alloc(8).toString('base64') }));
  });

  it('rejects fields that are not base64 at all', () => {
    const env = seal(SECRET, PAYLOAD);
    expectSealFailure(() => open(SECRET, { ...env, c: '!!!not base64!!!' }));
  });

  it('rejects truncated ciphertext', () => {
    const env = seal(SECRET, PAYLOAD);
    expectSealFailure(() => open(SECRET, { ...env, c: env.c.slice(0, -8) }));
  });
});

describe('isSealedEnvelope', () => {
  it('accepts a real envelope and rejects near-misses', () => {
    expect(isSealedEnvelope(seal(SECRET, PAYLOAD))).toBe(true);
    expect(isSealedEnvelope(null)).toBe(false);
    expect(isSealedEnvelope('nope')).toBe(false);
    expect(isSealedEnvelope({ v: '1', s: 'a', i: 'a', c: 'a', t: 'a', ts: 1 })).toBe(false);
    expect(isSealedEnvelope({ v: 1, s: 'a', i: 'a', c: 'a', t: 'a' })).toBe(false);
  });
});
