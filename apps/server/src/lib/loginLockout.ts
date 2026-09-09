/**
 * Failed-login tracking (in-memory — resets on restart, which is acceptable:
 * the goal is stopping online brute-force, not forensic record).
 *
 * Two tiers, because a single per-account lock is a denial-of-service lever:
 * anyone who knows a victim's email could send 5 wrong passwords and keep the
 * real owner locked out forever.
 *
 *   • per (account, IP) pair: 5 failures lock THAT pair for 15 minutes — the
 *     attacker locks themselves out, the real user (from their own IP) is
 *     untouched. This is the tier a password-guessing script actually hits.
 *   • per account: 25 failures from ANY mix of sources lock the account for
 *     15 minutes — a distributed brute-force still trips a lock, but it costs
 *     5× the work and lands in the audit log (`auth.lockout`).
 *
 * Complements the per-IP route rate limit, which one attacker with rotating
 * IPs can sidestep.
 */

const MAX_FAILURES_PER_IP = 5;
const MAX_FAILURES_PER_ACCOUNT = 25;
const LOCK_MS = 15 * 60 * 1000;

interface Entry {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

/** Idle entries are dropped after one lock period so the map cannot grow unbounded. */
const IDLE_TTL_MS = LOCK_MS;

/** Keyed by `email`, then by ip (or '*' when the caller had no IP). */
const entries = new Map<string, Map<string, Entry>>();

function accountEntries(email: string): Map<string, Entry> {
  const key = email.toLowerCase();
  let m = entries.get(key);
  if (!m) {
    m = new Map();
    entries.set(key, m);
  }
  return m;
}

function totalFailures(m: Map<string, Entry>): number {
  let total = 0;
  for (const e of m.values()) total += e.failures;
  return total;
}

/** Prune expired locks and idle entries so the map cannot grow unbounded. */
function sweep(now: number): void {
  for (const [key, m] of entries) {
    for (const [ip, e] of m) {
      if (e.lockedUntil < now && (e.failures === 0 || e.lastSeen < now - IDLE_TTL_MS)) m.delete(ip);
    }
    if (m.size === 0) entries.delete(key);
  }
}

export function isLocked(email: string, ip = '*'): boolean {
  const m = entries.get(email.toLowerCase());
  if (!m) return false;
  const now = Date.now();
  const pair = m.get(ip);
  if (pair && pair.lockedUntil > now) return true;
  // The account-wide lock is stored under the '*' pseudo-source.
  const account = m.get('*');
  return !!account && account.lockedUntil > now;
}

/** Record a failed attempt; returns true when this attempt caused a lock. */
export function recordFailure(email: string, ip = '*'): boolean {
  // Sweep BEFORE accountEntries: the sweep prunes empty per-account maps, so
  // creating the map first would get it deleted here and every counter would
  // restart from zero on the orphaned reference (the lock would never trip).
  sweep(Date.now());
  const m = accountEntries(email);
  const now = Date.now();

  const e = m.get(ip) ?? { failures: 0, lockedUntil: 0, lastSeen: now };
  e.failures += 1;
  e.lastSeen = now;

  let locked = false;
  if (e.failures >= MAX_FAILURES_PER_IP) {
    // This source locked itself out; the real user is unaffected.
    e.lockedUntil = now + LOCK_MS;
    e.failures = 0;
    locked = true;
  }
  m.set(ip, e);

  // Account-wide tier: only meaningful when failures arrive from MORE than
  // one source — a single IP already trips the pair lock above without
  // touching the victim's own access.
  if (m.size > 1 && totalFailures(m) >= MAX_FAILURES_PER_ACCOUNT) {
    const account = m.get('*') ?? { failures: 0, lockedUntil: 0, lastSeen: now };
    account.lockedUntil = now + LOCK_MS;
    account.lastSeen = now;
    m.set('*', account);
    locked = true;
  }
  return locked;
}

/** Successful login clears any pending failure count (locks stay until expiry). */
export function recordSuccess(email: string): void {
  entries.delete(email.toLowerCase());
}

/** Test hook: reset all state between cases. */
export function _resetLoginLockoutForTests(): void {
  entries.clear();
}
