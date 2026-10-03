/**
 * Minimal glob → RegExp conversion for webhook watch paths.
 * Supported syntax: `*` (any chars except `/`), `**` (any chars incl. `/`),
 * `?` (single char). Patterns match relative paths; a leading `/` is stripped.
 * No regex metacharacters in the pattern are honored (they are escaped).
 */

export function globToRegExp(pattern: string): RegExp {
  const src = pattern.replace(/^\/+/, '');
  let re = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '*') {
      if (src[i + 1] === '*') {
        // `**` — match across path separators. Consume a following slash so
        // `a/**/b` also matches `a/b`.
        re += '(?:.*)';
        i += 2;
        if (src[i] === '/') i += 1;
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^(?:${re})$`);
}

/** Keep user-supplied globs within a linear, bounded matching budget. */
export function isSafeWatchPath(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 256) return false;
  const deepStars = (pattern.match(/\*\*/g) ?? []).length;
  const wildcards = (pattern.match(/[?*]/g) ?? []).length;
  return deepStars <= 4 && wildcards <= 16;
}

// ── bounded matcher ─────────────────────────────────────────────────────────
//
// matchesAny used to execute globToRegExp(...).test(path) directly. With two or
// more `**` in one pattern the compiled regex carries that many independent
// `.*` loops, and on a non-matching input the engine backtracks O(n^k) in the
// path length — `apps/**/a**b` against a 200 KB changed-file path (webhook
// payloads arrive JSON-parsed with only the body limit as a bound) never
// returns, hanging the event loop on a single verified push event.
// isSafeWatchPath cannot close this: its budget bounds the pattern, not the
// input, and a length cap tight enough to bound backtracking (n < ~100) would
// silently drop legitimate paths. So the matcher itself is bounded:
// globMatches() evaluates the same token language over a rolling boolean DP in
// O(tokens × path length) — flat where the regex was exponential.

type GlobToken = { kind: 'lit'; ch: string } | { kind: 'any1' } | { kind: 'star1' } | { kind: 'star2' };

// Tokenize with the exact folding rules globToRegExp applies (kept in lockstep:
// `**` consumes one following slash so `a/**/b` also matches `a/b`;
// `*`/`?` never match `/`).
function tokenizeGlob(src: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '*') {
      if (src[i + 1] === '*') {
        tokens.push({ kind: 'star2' });
        i += 2;
        if (src[i] === '/') i += 1;
      } else {
        tokens.push({ kind: 'star1' });
        i += 1;
      }
    } else if (ch === '?') {
      tokens.push({ kind: 'any1' });
      i += 1;
    } else {
      tokens.push({ kind: 'lit', ch });
      i += 1;
    }
  }
  return tokens;
}

/**
 * Full-string glob match without regex backtracking.
 * dp[k][j] = "tokens[k..] match text[j..]", computed bottom-right with one
 * rolling row: stars extend-or-skip in place, literals and `?` consume one char.
 */
function globMatches(pattern: string, text: string): boolean {
  const tokens = tokenizeGlob(pattern);
  const n = text.length;
  // next[j] — do tokens[k+1..] match text[j..]? Row m (past the last token)
  // matches only the empty remainder.
  let next = new Array<boolean>(n + 1).fill(false);
  next[n] = true;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const tok = tokens[k]!;
    const cur = new Array<boolean>(n + 1).fill(false);
    if (tok.kind === 'star2' || tok.kind === 'star1') {
      for (let j = n; j >= 0; j--) {
        cur[j] =
          next[j]! || (j < n && (tok.kind === 'star2' || text[j] !== '/') && cur[j + 1]!);
      }
    } else {
      for (let j = n; j >= 0; j--) {
        cur[j] =
          j < n &&
          (tok.kind === 'lit' ? text[j] === tok.ch : text[j] !== '/') &&
          next[j + 1]!;
      }
    }
    next = cur;
  }
  return next[0]!;
}

/**
 * Over-long inputs are treated as a HIT (fail-open) rather than matched:
 * the cap keeps worst-case work at tokens × 4096 (~1 ms), and both callers'
 * semantics prefer a redundant action over a silent skip — hooks.ts deploys
 * anyway at the commit-list cap for exactly this reason, and no on-disk
 * relative path can exceed the OS PATH_MAX this bound mirrors.
 */
const MAX_MATCH_INPUT = 4096;

/** True when `path` matches ANY of the glob patterns. */
export function matchesAny(path: string, patterns: string[]): boolean {
  const clean = path.replace(/^\/+/, '');
  if (clean.length > MAX_MATCH_INPUT) return true;
  return patterns.some((p) => isSafeWatchPath(p) && globMatches(p.replace(/^\/+/, ''), clean));
}

/** Split a raw watchPaths field (newline or comma separated) into patterns. */
export function parseWatchPaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(isSafeWatchPath)
    .slice(0, 32);
}
