import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetLoginLockoutForTests, isLocked, lockoutSource, recordFailure, recordSuccess } from '../../src/lib/loginLockout.js';

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
    recordSuccess('w@x.y', '10.0.0.1');
    expect(isLocked('w@x.y', '10.0.0.1')).toBe(false);
    // counting starts fresh after a success
    for (let i = 0; i < 4; i++) expect(recordFailure('w@x.y', '10.0.0.1')).toBe(false);
    expect(recordFailure('w@x.y', '10.0.0.1')).toBe(true);
  });

  it("r160: the victim's success does not reset another source's lock or counter", () => {
    for (let i = 0; i < 5; i++) recordFailure('v2@x.y', '198.51.100.7');
    expect(isLocked('v2@x.y', '198.51.100.7')).toBe(true);
    for (let i = 0; i < 3; i++) recordFailure('v2@x.y', '198.51.100.8');
    recordSuccess('v2@x.y', '203.0.113.5');
    // The attacker's pair lock survives…
    expect(isLocked('v2@x.y', '198.51.100.7')).toBe(true);
    // …and so does the other source's tally: two more failures lock it.
    expect(recordFailure('v2@x.y', '198.51.100.8')).toBe(false);
    expect(recordFailure('v2@x.y', '198.51.100.8')).toBe(true);
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

  // r500: a pair lock reset its counter to 0 and the account tier summed the
  // live counters, so exactly 5 guesses per IP never added up to anything.
  it('r500: 5 guesses from each of 5 IPs trip the account lock', () => {
    let tripped = false;
    for (let ip = 0; ip < 5; ip++) {
      for (let i = 0; i < 5; i++) tripped = recordFailure('dist@x.y', `203.0.113.${ip}`) || tripped;
    }
    expect(tripped).toBe(true);
    // Every source is refused now — including one that never failed.
    expect(isLocked('dist@x.y', '198.51.100.99')).toBe(true);
  });

  it('r500: a single noisy IP still cannot lock the real user out', () => {
    vi.useFakeTimers();
    try {
      // The attacker hammers from one address across several lock periods;
      // only its own pair locks.
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 5; i++) recordFailure('solo@x.y', '203.0.113.66');
        vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      }
      for (let i = 0; i < 5; i++) recordFailure('solo@x.y', '203.0.113.66');
      expect(isLocked('solo@x.y', '203.0.113.66')).toBe(true);
      expect(isLocked('solo@x.y', '198.51.100.7')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('r500: the account window slides — old failures age out', () => {
    vi.useFakeTimers();
    try {
      for (let ip = 0; ip < 4; ip++) {
        for (let i = 0; i < 5; i++) recordFailure('slide@x.y', `203.0.113.${ip}`);
      }
      vi.advanceTimersByTime(16 * 60 * 1000);
      // 20 old + 5 new would be 25, but the 20 are outside the window.
      for (let i = 0; i < 5; i++) recordFailure('slide@x.y', '203.0.113.200');
      expect(isLocked('slide@x.y', '198.51.100.7')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("r500: the owner's success drops their own failures from the account window", () => {
    for (let i = 0; i < 4; i++) recordFailure('own@x.y', '198.51.100.7');
    recordSuccess('own@x.y', '198.51.100.7');
    // 21 attacker failures + the 4 forgiven typos would have reached 25.
    for (let ip = 0; ip < 4; ip++) {
      for (let i = 0; i < 5; i++) recordFailure('own@x.y', `203.0.113.${ip}`);
    }
    recordFailure('own@x.y', '203.0.113.9');
    expect(isLocked('own@x.y', '198.51.100.7')).toBe(false);
  });

  it('r500: an IPv6 /64 is one source — rotating the interface id does not reset the pair', () => {
    for (let i = 1; i <= 5; i++) recordFailure('v6@x.y', `2001:db8:aa:bb::${i.toString(16)}`);
    expect(isLocked('v6@x.y', '2001:db8:aa:bb:dead:beef:0:1')).toBe(true);
    // A different /64 is a different source.
    expect(isLocked('v6@x.y', '2001:db8:aa:bc::1')).toBe(false);
  });

  it('lockoutSource buckets IPv6 to /64 and unwraps IPv4-mapped addresses', () => {
    expect(lockoutSource('203.0.113.5')).toBe('203.0.113.5');
    expect(lockoutSource('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(lockoutSource('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(lockoutSource('2001:0db8:0000:0000:1:2:3:4')).toBe('2001:db8:0:0::/64');
    expect(lockoutSource('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(lockoutSource('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(lockoutSource('::1')).toBe('0:0:0:0::/64');
    expect(lockoutSource('*')).toBe('*');
    expect(lockoutSource('not-an-ip')).toBe('not-an-ip');
  });
});
