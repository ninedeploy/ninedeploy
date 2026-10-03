/**
 * Secret-pattern scanner for `.ninedeploy` manifests.
 *
 * The manifest is committed to the repo, so it must NEVER carry real
 * credentials, tokens or connection strings. This module is a defensive net:
 * patterns are matched against the raw text, and any hit fails the load.
 *
 * The list is intentionally explicit (named patterns) rather than a generic
 * entropy heuristic — false positives are user-hostile (legitimate values
 * that look credential-like should pass). Every regex is also bounded to
 * avoid runaway matching on long inputs.
 *
 * Lives in `@ninedeploy/schemas` (not in `@ninedeploy/server`) because the
 * CLI also needs to run the scan in `ninedeploy manifest validate`. Anything
 * that loads a manifest — server, CLI, future MCP tool — should reuse this.
 */

/** A single rule: a human-readable name plus a regex that MUST match the
 *  *beginning* of a credential — anchoring left keeps the regex from firing
 *  on substrings inside longer strings. */
export interface SecretPattern {
  readonly id: string;
  readonly description: string;
  readonly regex: RegExp;
}

export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    id: 'aws-access-key',
    description: 'AWS access key id (AKIA…)',
    regex: /AKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'github-pat-classic',
    description: 'GitHub personal access token (ghp_…)',
    regex: /\bghp_[A-Za-z0-9]{36}\b/,
  },
  {
    id: 'github-pat-fine-grained',
    description: 'GitHub fine-grained PAT (github_pat_…)',
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  },
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token (glpat-…)',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'slack-token',
    description: 'Slack token (xox[baprs]-…)',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: 'stripe-live-secret',
    description: 'Stripe live secret key (sk_live_…)',
    regex: /\bsk_live_[A-Za-z0-9]{24,}\b/,
  },
  {
    id: 'stripe-live-restricted',
    description: 'Stripe live restricted key (rk_live_…)',
    regex: /\brk_live_[A-Za-z0-9]{24,}\b/,
  },
  {
    id: 'openai-secret',
    description: 'OpenAI API key (sk-… / sk-proj-…)',
    // `(?!ant-)` keeps Anthropic keys single-matched under the anthropic-key
    // rule; `proj-` is the current project-key prefix whose character set
    // includes `-`/`_`.
    regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}\b/,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic API key (sk-ant-…)',
    regex: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/,
  },
  {
    id: 'discord-webhook',
    description: 'Discord webhook URL (discord…/api/webhooks/…)',
    regex: /https?:\/\/(?:[A-Za-z0-9-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/,
  },
  {
    id: 'database-url-credentials',
    description: 'Database URL with embedded credentials (scheme://user:pass@…)',
    // The password class accepts either non-special chars or `%XX` percent-
    // encoded triplets: a literal '@' in the password cannot appear (it is
    // the user/host delimiter), but the URL-encoded form `%40` can — and
    // tools that build connection strings from user input routinely emit
    // `%40` instead of escaping it themselves. The `{3,}` minimum is
    // measured in raw characters (not encoded triplets) to keep the
    // "obviously not a secret" guardrail a real password still satisfies.
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^\s:@'"]+:(?:[^\s@'"]|%[0-9A-Fa-f]{2}){3,}@/i,
  },
  {
    id: 'private-key',
    description: 'PEM private key block',
    regex: /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  },
  {
    id: 'jwt-bearer',
    description: 'Bearer JWT in a literal value',
    regex: /\bBearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

/** A single secret-pattern hit in scanned text. */
export interface SecretHit {
  patternId: string;
  description: string;
  /** Index in the original text where the match starts. */
  start: number;
  /** Index in the original text where the match ends. */
  end: number;
  /** A redacted preview of the matched text (first 4 chars + … + last 2). */
  redacted: string;
}

// The scan appends the `g` flag to every pattern — a pattern that already
// declared it would produce `gg` and throw Invalid flag at scan time. Fail
// at import instead, where a developer sees it immediately.
for (const p of SECRET_PATTERNS) {
  /* v8 ignore next 3 — developer-error guard, not reachable via valid patterns */
  if (p.regex.flags.includes('g')) {
    throw new Error(`secret pattern "${p.id}" must not declare the g flag (the scanner adds it)`);
  }
}

/**
 * Run every secret pattern across `text` and return every hit.
 *
 * The scan is non-overlapping and bounded — each regex is `\b`-anchored or
 * scheme-anchored, so a single credential can never span more than one match.
 */
export function scanForSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const pattern of SECRET_PATTERNS) {
    // matchAll requires the `g` flag; build a per-call global copy so the
    // module-level regexes never carry stateful lastIndex between scans,
    // and so EVERY occurrence is reported (the contract says "every hit").
    const global = new RegExp(pattern.regex.source, `${pattern.regex.flags}g`);
    for (const match of text.matchAll(global)) {
      const start = match.index;
      const end = start + match[0].length;
      hits.push({
        patternId: pattern.id,
        description: pattern.description,
        start,
        end,
        redacted: redact(match[0]),
      });
    }
  }
  // Sort by start position so the redacted-log line reads in document order.
  return hits.sort((a, b) => a.start - b.start);
}

/** Returns true if the text contains anything that looks like a secret. */
export function hasSecret(text: string): boolean {
  return scanForSecrets(text).length > 0;
}

/**
 * Replace the middle of a string with `…` for safe logging. Keeps the first
 * 4 and last 2 characters when the input is long enough; otherwise just
 * emits `<redacted:N>` so the length is still visible.
 */
export function redact(value: string): string {
  if (value.length <= 8) return `<redacted:${value.length}>`;
  return `${value.slice(0, 4)}…${value.slice(-2)} (len=${value.length})`;
}
