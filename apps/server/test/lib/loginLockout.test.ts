import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetLoginLockoutForTests, isLocked, recordFailure, recordSuccess } from '../../src/lib/loginLockout.js';

describe('loginLockout', () => {
  afterEach(() => _resetLoginLockoutForTests());

  it('does not lock before 5 consecutive failures from one source', () => {
    for (let i = 0; i < 4; i++) {
      expect(recordFailure('u@x.y', '10.0.0.1')).toBe(false);
      expect(isLocked('u@x.y', '10.0.0.1')).toBe(false);
    }
  });

  it('locks the (account, IP) pair on the 5th failure', () => {
    for (let i = 0; i < 4; i++) recordFailure('v@x.y', '10.0.0.1');
    expect(recordFailure('v@x.y', '10.0.0.1')).toBe(true);
    expect(isLocked('v@x.y', '10.0.0.1')).toBe(true);
  });

  it("a locked source stays locked even though failures restart", () => {
    for (let i = 0; i < 5; i++) recordFailure('v@x.y', '10.0.0.2');
    expect(isLocked('v@x.y', '10.0.0.2')).toBe(true);
    recordFailure('v@x.y', '10.0.0.2');
    expect(isLocked('v@x.y', '10.0.0.2')).toBe(true);
  });

  it("a source locking itself out does NOT lock the victim's other sources (DoS fix)", () => {
    // The old per-account-only lock let anyone who knew an email hold the
    // real user out with 5 wrong passwords. Now the guesser's IP locks; the
    // legitimate user keeps logging in.
    for (let i = 0; i < 6; i++) recordFailure('victim@x.y', '203.0.113.10');
    expect(isLocked('victim@x.y', '203.0.113.10')).toBe(true);
    expect(isLocked('victim@x.y', '198.51.100.7')).toBe(false);
  });

  it('still locks the whole account after 25 failures spread across sources', () => {
    // Distributed brute-force: each source stays under 5, but the account
    // tier trips at the aggregate and every source is refused.
    for (let i = 0; i < 13; i++) recordFailure('v@x.y', `203.0.113.${i}`);
    expect(isLocked('v@x.y', '203.0.113.0')).toBe(false); // pair tier not hit
    for (let i = 13; i < 25; i++) recordFailure('v@x.y', `198.51.100.${i}`);
    expect(isLocked('v@x.y', '203.0.113.0')).toBe(true);
    expect(isLocked('v@x.y', '198.51.100.13')).toBe(true);
  });

  it('success clears pending failures', () => {
    for (let i = 0; i < 3; i++) recordFailure('w@x.y', '10.0.0.1');
    recordSuccess('w@x.y');
    expect(isLocked('w@x.y', '10.0.0.1')).toBe(false);
    // counting starts fresh after a success
    for (let i = 0; i < 4; i++) expect(recordFailure('w@x.y', '10.0.0.1')).toBe(false);
    expect(recordFailure('w@x.y', '10.0.0.1')).toBe(true);
  });

  it('matches emails case-insensitively', () => {
    for (let i = 0; i < 5; i++) recordFailure('MiXeD@x.y', '10.0.0.1');
    expect(isLocked('mixed@x.y', '10.0.0.1')).toBe(true);
    expect(isLocked('other@x.y', '10.0.0.1')).toBe(false);
  });

  it('unlocks after the 15-minute window and sweeps the entry', () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) recordFailure('tmp@x.y', '10.0.0.1');
      expect(isLocked('tmp@x.y', '10.0.0.1')).toBe(true);
      vi.advanceTimersByTime(16 * 60 * 1000);
      expect(isLocked('tmp@x.y', '10.0.0.1')).toBe(false);
      // The expired entry is swept by the next failure elsewhere (map stays bounded).
      recordFailure('other2@x.y', '10.0.0.1');
      expect(isLocked('tmp@x.y', '10.0.0.1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
