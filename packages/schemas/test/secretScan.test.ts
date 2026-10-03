import { describe, expect, it } from 'vitest';
// Import the source directly (not the package barrel) so vitest's v8 coverage
// tracks `src/secretScan.ts` instead of the pre-built `dist/secretScan.js`.
import { hasSecret, redact, scanForSecrets, SECRET_PATTERNS } from '../src/secretScan.js';

describe('redact', () => {
  it('keeps first 4 and last 2 chars for long inputs', () => {
    expect(redact('ghp_abcde12345xyzzyz99endXY')).toContain('ghp_');
    expect(redact('ghp_abcde12345xyzzyz99endXY')).toContain('XY');
    expect(redact('ghp_abcde12345xyzzyz99endXY')).toContain('…');
  });
  it('falls back to a length-only marker for short inputs', () => {
    expect(redact('hi')).toBe('<redacted:2>');
    expect(redact('12345678')).toBe('<redacted:8>');
  });
});

describe('hasSecret', () => {
  it('returns true when any pattern matches', () => {
    expect(hasSecret('token: AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });
  it('returns false for clean text', () => {
    expect(hasSecret('DATABASE_URL=postgres://localhost/app')).toBe(false);
    expect(hasSecret('# Routes to my application\n- host: app.example.com')).toBe(false);
  });
});

describe('scanForSecrets', () => {
  it('returns an empty array for clean text', () => {
    expect(scanForSecrets('just a normal manifest value')).toEqual([]);
  });

  it('detects an AWS access key id', () => {
    const hits = scanForSecrets('key: AKIAIOSFODNN7EXAMPLE');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('aws-access-key');
    expect(hits[0]?.redacted).toContain('AKIA');
  });

  it('detects a GitHub classic PAT', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const hits = scanForSecrets(`token = "${token}"`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('github-pat-classic');
  });

  it('detects a GitHub fine-grained PAT', () => {
    const token = `github_pat_${'a'.repeat(82)}`;
    const hits = scanForSecrets(`token = "${token}"`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('github-pat-fine-grained');
  });

  it('detects a GitLab PAT', () => {
    const token = `glpat-${'a'.repeat(24)}`;
    const hits = scanForSecrets(`x: ${token}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('gitlab-pat');
  });

  it('detects a Slack token', () => {
    const hits = scanForSecrets('token: xoxb-1234567890-abcdef');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('slack-token');
  });

  it('detects a Stripe live secret key', () => {
    const key = `sk_live_${'a'.repeat(24)}`;
    const hits = scanForSecrets(`stripe: ${key}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('stripe-live-secret');
  });

  it('detects a Stripe live restricted key', () => {
    const key = `rk_live_${'a'.repeat(24)}`;
    const hits = scanForSecrets(`stripe: ${key}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('stripe-live-restricted');
  });

  it('detects an OpenAI secret key', () => {
    const key = `sk-${'a'.repeat(48)}`;
    const hits = scanForSecrets(`openai: ${key}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('openai-secret');
  });

  it('detects the current sk-proj- OpenAI key format', () => {
    const key = `sk-proj-${'a1'.repeat(30)}`;
    const hits = scanForSecrets(`OPENAI_API_KEY: ${key}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('openai-secret');
  });

  it('reports every occurrence of a pattern, not just the first', () => {
    // Two distinct AWS keys in one manifest: both must be reported so the
    // operator sees the full redacted list, not only the first hit.
    const hits = scanForSecrets('a: AKIAIOSFODNN7EXAMPLE\nb: AKIAI44QH8DHBEXAMPLE');
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.patternId === 'aws-access-key')).toBe(true);
  });

  it('detects an Anthropic API key', () => {
    const key = `sk-ant-${'a'.repeat(40)}`;
    const hits = scanForSecrets(`anthropic: ${key}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('anthropic-key');
  });

  it('detects a Discord webhook URL', () => {
    const url = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnop_qrstuvwxyz';
    const hits = scanForSecrets(`hook: ${url}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('discord-webhook');
  });

  it('detects a database URL with embedded credentials', () => {
    const hits = scanForSecrets('DATABASE_URL: postgres://user:s3cret@db:5432/app');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('database-url-credentials');
  });

  it('detects a database URL with the mysql:// scheme', () => {
    const hits = scanForSecrets('MYSQL_URL: mysql://root:s3cret@host/db');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('database-url-credentials');
  });

  it('does NOT detect a database URL without credentials', () => {
    const hits = scanForSecrets('DATABASE_URL: postgres://db.internal/app');
    expect(hits).toEqual([]);
  });

  it('detects a PEM private key block', () => {
    const hits = scanForSecrets('key: |\n  -----BEGIN RSA PRIVATE KEY-----');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('private-key');
  });

  it('detects a Bearer JWT literal', () => {
    const hits = scanForSecrets('auth: Bearer eyJabc123def456ghi789.eyJabc123def456ghi789.sigABC123DEF456');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.patternId).toBe('jwt-bearer');
  });

  it('returns hits sorted by start position', () => {
    const text = `first: AKIAIOSFODNN7EXAMPLE
second: ghp_${'a'.repeat(36)}`;
    const hits = scanForSecrets(text);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.patternId).toBe('aws-access-key');
    expect(hits[1]?.patternId).toBe('github-pat-classic');
    expect(hits[0]!.start).toBeLessThan(hits[1]!.start);
  });

  it('exposes a non-empty pattern list', () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
    for (const p of SECRET_PATTERNS) {
      expect(p.id).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.regex).toBeInstanceOf(RegExp);
    }
  });
});
