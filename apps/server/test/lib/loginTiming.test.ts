import { beforeEach, describe, expect, it, vi } from 'vitest';

// r504: the login route used to skip argon2 entirely for an unknown email
// (and fail instantly on SCIM's non-argon2 random secret), so the response
// time told an anonymous caller which addresses have an account. These cases
// pin that every miss now pays one real argon2 verify.
const argon = vi.hoisted(() => ({
  hash: vi.fn(async (pw: string) => `$argon2id$v=19$m=19456,t=2,p=1$dummy$${pw.length}`),
  verify: vi.fn(async () => true),
}));
vi.mock('@node-rs/argon2', () => argon);

const { verifyPassword } = await import('../../src/lib/crypto.js');

describe('verifyPassword timing equalisation (r504)', () => {
  beforeEach(() => {
    argon.verify.mockClear();
    argon.verify.mockResolvedValue(true);
  });

  it('runs a full argon2 verify for an unknown account (empty hash) and still answers false', async () => {
    await expect(verifyPassword('', 'guess')).resolves.toBe(false);
    expect(argon.verify).toHaveBeenCalledTimes(1);
    // Against the process-wide dummy hash, not the empty string.
    expect(String((argon.verify.mock.calls[0] as unknown[])[0])).toMatch(/^\$argon2/);
  });

  it('treats a non-argon2 stored value (SCIM random secret) the same way', async () => {
    await expect(verifyPassword('0b6f…-random-uuid-pair', 'guess')).resolves.toBe(false);
    expect(argon.verify).toHaveBeenCalledTimes(1);
  });

  it('computes the dummy hash once and reuses it', async () => {
    await verifyPassword('', 'a');
    await verifyPassword('', 'b');
    expect(argon.hash.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('verifies a real argon2 hash as before', async () => {
    await expect(verifyPassword('$argon2id$real', 'pw')).resolves.toBe(true);
    expect(argon.verify).toHaveBeenCalledWith('$argon2id$real', 'pw');
    argon.verify.mockResolvedValueOnce(false);
    await expect(verifyPassword('$argon2id$real', 'nope')).resolves.toBe(false);
  });

  it('answers false (never throws) when argon2 rejects', async () => {
    argon.verify.mockRejectedValueOnce(new Error('bad hash'));
    await expect(verifyPassword('$argon2id$broken', 'pw')).resolves.toBe(false);
  });
});
