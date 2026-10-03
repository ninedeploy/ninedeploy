import { isIPv6 } from 'node:net';

/**
 * Failed-login tracking (in-memory — resets on restart, which is acceptable:
 * the goal is stopping online brute-force, not forensic record).
 *
 * Two tiers, because a single per-account lock is a denial-of-service lever:
 * anyone who knows a victim's email could send 5 wrong passwords and keep the
 * real owner locked out forever.
 *
 *   • per (account, source) pair: 5 failures lock THAT pair for 15 minutes —
 *     the attacker locks themselves out, the real user (from their own IP) is
 *     untouched. This is the tier a password-guessing script actually hits.
 *     A source is one IPv4 address, or one IPv6 /64 (a single host is
 *     routinely handed a whole /64, so per-address keys would give it 2^64
 *     fresh pairs).
 *   • per account: 25 failures inside a sliding 15-minute window, from more
 *     than one source, lock the account for 15 minutes — a distributed
 *     brute-force still trips a lock, but it costs 5× the work and lands in
 *     the audit log (`auth.lockout`). One noisy source cannot trip it on its
 *     own: its pair lock caps it at 5 failures per lock period.
 *
 * r500: the account tier used to SUM the live per-pair counters — and a pair
 * that locked reset its counter to 0. An attacker spending exactly 5 guesses
 * per IP therefore never contributed anything to the account tally, and the
 * account lock could not trip at all. Failures now land in a per-account
 * window that a pair lock does not erase.
 *
 * Complements the per-IP route rate limit, which one attacker with rotating
 * IPs can sidestep.
 */

const MAX_FAILURES_PER_IP = 5;
const MAX_FAILURES_PER_ACCOUNT = 25;
const LOCK_MS = 15 * 60 * 1000;
/** The account tier counts failures inside this sliding window. */
const ACCOUNT_WINDOW_MS = LOCK_MS;

interface SourceEntry {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

interface AccountState {
  sources: Map<string, SourceEntry>;
  /** Every failure inside the window, from any source — locked ones included. */
  recent: Array<{ at: number; source: string }>;
  lockedUntil: number;
}

/** Idle entries are dropped after one lock period so the map cannot grow unbounded. */
const IDLE_TTL_MS = LOCK_MS;

/** Keyed by lower-cased email. */
const accounts = new Map<string, AccountState>();

/**
 * The lockout key of a client address: IPv4 as-is (IPv4-mapped IPv6 unwrapped
 * to it), IPv6 bucketed to its /64. `'*'` (no address known) stays `'*'`.
 * Exported for tests.
 */
export function lockoutSource(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const addr = ip.split('%')[0]!.toLowerCase();
  const doubleColon = addr.indexOf('::');
  let groups: string[];
  if (doubleColon === -1) {
    groups = addr.split(':');
  } else {
    const head = addr.slice(0, doubleColon).split(':').filter(Boolean);
    const tail = addr.slice(doubleColon + 2).split(':').filter(Boolean);
    // A dotted-quad tail occupies two groups; it never reaches the /64 prefix
    // except as zero padding, so counting it as one only shifts zeros.
    groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  }
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

function prune(state: AccountState, now: number): void {
  const cutoff = now - ACCOUNT_WINDOW_MS;
  while (state.recent.length > 0 && state.recent[0]!.at <= cutoff) state.recent.shift();
}

/** Prune expired locks and idle entries so the map cannot grow unbounded. */
function sweep(now: number): void {
  for (const [key, state] of accounts) {
    prune(state, now);
    for (const [source, e] of state.sources) {
      if (e.lockedUntil < now && (e.failures === 0 || e.lastSeen < now - IDLE_TTL_MS)) state.sources.delete(source);
    }
    if (state.sources.size === 0 && state.recent.length === 0 && state.lockedUntil < now) accounts.delete(key);
  }
}

export function isLocked(email: string, ip = '*'): boolean {
  const state = accounts.get(email.toLowerCase());
  if (!state) return false;
  const now = Date.now();
  if (state.lockedUntil > now) return true;
  const pair = state.sources.get(lockoutSource(ip));
  return !!pair && pair.lockedUntil > now;
}

/** Record a failed attempt; returns true when this attempt caused a lock. */
export function recordFailure(email: string, ip = '*'): boolean {
  // Sweep BEFORE looking the account up: the sweep prunes empty accounts, so
  // creating the state first would get it deleted here and every counter
  // would restart from zero on the orphaned reference (the lock would never trip).
  const now = Date.now();
  sweep(now);
  const key = email.toLowerCase();
  let state = accounts.get(key);
  if (!state) {
    state = { sources: new Map(), recent: [], lockedUntil: 0 };
    accounts.set(key, state);
  }
  const source = lockoutSource(ip);

  const e = state.sources.get(source) ?? { failures: 0, lockedUntil: 0, lastSeen: now };
  e.failures += 1;
  e.lastSeen = now;
  let locked = false;
  if (e.failures >= MAX_FAILURES_PER_IP) {
    // This source locked itself out; the real user is unaffected. The pair's
    // own counter restarts, but its failures stay in the account window.
    e.lockedUntil = now + LOCK_MS;
    e.failures = 0;
    locked = true;
  }
  state.sources.set(source, e);

  // Account-wide tier (r500): counted from the window, which a pair lock does
  // not reset. Only the newest MAX entries are ever needed.
  state.recent.push({ at: now, source });
  if (state.recent.length > MAX_FAILURES_PER_ACCOUNT) state.recent.shift();
  if (state.recent.length >= MAX_FAILURES_PER_ACCOUNT && new Set(state.recent.map((r) => r.source)).size > 1) {
    state.lockedUntil = now + LOCK_MS;
    // The tally starts over once the lock runs out.
    state.recent = [];
    locked = true;
  }
  return locked;
}

/**
 * A successful login clears the failure count of the source it came from —
 * and only that source. r160: this used to drop the whole account map, so the
 * victim logging in from home wiped the attacker's (account, IP) lock and the
 * distributed-failure tally, handing the attacker a fresh batch of guesses
 * after every legitimate login. Other sources' counters, locks and window
 * entries now run to their own expiry; the account lock is never lifted early.
 */
export function recordSuccess(email: string, ip = '*'): void {
  const key = email.toLowerCase();
  const state = accounts.get(key);
  if (!state) return;
  const source = lockoutSource(ip);
  const e = state.sources.get(source);
  if (e && e.lockedUntil <= Date.now()) {
    state.sources.delete(source);
    // The owner's own typos from this source no longer count against them.
    state.recent = state.recent.filter((r) => r.source !== source);
  }
  if (state.sources.size === 0 && state.recent.length === 0 && state.lockedUntil <= Date.now()) accounts.delete(key);
}

/** Test hook: reset all state between cases. */
export function _resetLoginLockoutForTests(): void {
  accounts.clear();
}
