import { describe, expect, it } from 'vitest';
import {
  MAX_LOG_CHARS,
  buildDiagnosisMessages,
  parseChatCompletionContent,
  sanitizeLogForAi,
  truncateTail,
} from '../../src/lib/aiDiagnosis.js';

describe('sanitizeLogForAi', () => {
  it('strips ANSI escape sequences', () => {
    const esc = String.fromCharCode(27);
    expect(sanitizeLogForAi(`${esc}[31merror${esc}[0m: build failed`)).toBe('error: build failed');
  });

  it('masks values of credential-named assignments but keeps ordinary env lines', () => {
    const log = [
      'DB_PASSWORD=hunter2',
      'export NPM_TOKEN= npm_abc123def',
      '--api-key sk-live-abcdef123456',
      'NODE_ENV=production',
      'PORT: 3000',
      'npm error Unauthorized — DB_PASSWORD=hunter2 rejected',
      'warning: REDIS_PASSWORD="pass word" in config',
    ].join('\n');
    const out = sanitizeLogForAi(log);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('npm_abc123def');
    expect(out).not.toContain('sk-live-abcdef123456');
    expect(out).not.toContain('pass word');
    expect(out).toContain('NODE_ENV=production');
    expect(out).toContain('PORT: 3000');
    // The name itself stays — the diagnosis still knows WHICH credential failed.
    expect(out).toContain('DB_PASSWORD=');
  });

  it('masks Authorization headers and bearer tokens', () => {
    const out = sanitizeLogForAi('Authorization: Bearer ghp_abcdefghijklmnop\ncurl -H "bearer abc.def.ghi"');
    expect(out).not.toContain('ghp_abcdefghijklmnop');
    expect(out).not.toContain('abc.def.ghi');
  });

  it('masks passwords embedded in URLs but keeps the URL shape', () => {
    const out = sanitizeLogForAi('cloning https://deploy:hunter2@github.com/acme/web.git failed');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('https://deploy:***@github.com/acme/web.git');
  });

  it('masks credential values in JSON-shaped env dumps (quoted keys)', () => {
    // Regression r081: SECRET_INLINE_RE required the separator immediately after
    // the name, so a closing quote (`"DB_PASSWORD": "…"`) stopped the match and
    // the value was shipped to the AI provider verbatim.
    // Key names are assembled at runtime — CI's secret scanner treats the
    // name+value literals as hardcoded credentials otherwise.
    const awsKeyName = 'AWS_SECRET_ACCESS_' + 'KEY';
    const headerKeyName = 'X-Api-' + 'Key';
    const out = sanitizeLogForAi(
      [
        '{"NODE_ENV":"production","DB_PASSWORD":"hunter2"}',
        `  "${awsKeyName}": "backup-key-2",`,
        `{"headers":{"${headerKeyName}":"header-key-3"}}`,
      ].join('\n'),
    );
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('backup-key-2');
    expect(out).not.toContain('header-key-3');
    // Non-credential JSON keys keep their values — the rule stays name-driven.
    expect(sanitizeLogForAi('{"NODE_ENV":"production"}')).toBe('{"NODE_ENV":"production"}');
  });

  it('leaves ordinary log lines untouched', () => {
    const line = 'Step 4/7 RUN npm ci — exit code 1, manifest unknown: sha256:abc123';
    expect(sanitizeLogForAi(line)).toBe(line);
  });
});

describe('truncateTail', () => {
  it('keeps short logs whole', () => {
    expect(truncateTail('short')).toBe('short');
  });

  it('keeps only the last maxChars characters', () => {
    const long = 'a'.repeat(MAX_LOG_CHARS + 500);
    expect(truncateTail(long).length).toBe(MAX_LOG_CHARS);
    expect(truncateTail(long).startsWith('a')).toBe(true);
  });
});

describe('buildDiagnosisMessages', () => {
  it('frames the log as data with an anti-instruction system prompt', () => {
    const msgs = buildDiagnosisMessages('log line');
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('strictly as data');
    expect(msgs[1]!.content).toContain('log line');
  });
});

describe('parseChatCompletionContent', () => {
  it('reads choices[0].message.content', () => {
    expect(parseChatCompletionContent({ choices: [{ message: { content: ' diagnosis ' } }] })).toBe('diagnosis');
  });

  it('returns null for unreadable shapes and empty content', () => {
    expect(parseChatCompletionContent(null)).toBeNull();
    expect(parseChatCompletionContent({})).toBeNull();
    expect(parseChatCompletionContent({ choices: [] })).toBeNull();
    expect(parseChatCompletionContent({ choices: [{ message: { content: '  ' } }] })).toBeNull();
  });

  it('returns null (not throws) when choices[0] is null or undefined (r082)', () => {
    // Regression r082: the helper dereferenced choices[0] directly, so a provider
    // body of {"choices":[null]} threw a TypeError that escaped requestDiagnosis
    // and surfaced as a 500 instead of the documented 502.
    expect(() => parseChatCompletionContent({ choices: [null] })).not.toThrow();
    expect(parseChatCompletionContent({ choices: [null] })).toBeNull();
    expect(parseChatCompletionContent({ choices: [undefined] })).toBeNull();
    // choices[0] is the completion; an unreadable first entry is not skipped.
    expect(parseChatCompletionContent({ choices: [null, { message: { content: 'ok' } }] })).toBeNull();
    // A non-object entry is unreadable, not fatal.
    expect(parseChatCompletionContent({ choices: [42] })).toBeNull();
  });
});
