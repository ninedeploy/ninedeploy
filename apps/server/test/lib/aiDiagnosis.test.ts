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
});
