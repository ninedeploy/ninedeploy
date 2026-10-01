import { describe, expect, it } from 'vitest';
import { webhookCreate } from '../src/index.js';

/** The watchPaths refine (management.webhookCreate — the service.ts twin was
 *  removed in r473 as dead, drifted code)
 *  guards the deploy-trigger glob list: bounded count, bounded pattern
 *  length, bounded `**` recursion and bounded wildcard density — a hostile
 *  .manifest or API payload must not hand the matcher a pathological glob. */
describe('watchPaths glob guard', () => {
  const base = { branch: 'main', active: true, url: 'https://x' };

  it.each([webhookCreate])('%j accepts safe glob lists', (schema) => {
    expect(schema.safeParse({ ...base, watchPaths: 'src/**/*.ts, Dockerfile' }).success).toBe(true);
    // Empty/whitespace entries are dropped before the limits apply.
    expect(schema.safeParse({ ...base, watchPaths: '' }).success).toBe(true);
    expect(schema.safeParse({ ...base, watchPaths: '  \n  , ,src/a.ts,' }).success).toBe(true);
    // Optional: absent is fine.
    expect(schema.safeParse({ ...base }).success).toBe(true);
  });

  it.each([webhookCreate])('%j rejects more than 32 patterns', (schema) => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `p${i}`).join('\n');
    expect(schema.safeParse({ ...base, watchPaths: tooMany }).success).toBe(false);
    expect(schema.safeParse({ ...base, watchPaths: Array.from({ length: 32 }, (_, i) => `p${i}`).join('\n') }).success).toBe(true);
  });

  it.each([webhookCreate])('%j rejects a pattern longer than 256 chars', (schema) => {
    expect(schema.safeParse({ ...base, watchPaths: 'a'.repeat(257) }).success).toBe(false);
    expect(schema.safeParse({ ...base, watchPaths: 'a'.repeat(256) }).success).toBe(true);
  });

  it.each([webhookCreate])('%j rejects more than 4 ** segments', (schema) => {
    const fiveRecursions = ['**/**/**/**/**'].join(',');
    expect(schema.safeParse({ ...base, watchPaths: fiveRecursions }).success).toBe(false);
    expect(schema.safeParse({ ...base, watchPaths: 'a/**/b/**/c/**/d/**/e.ts' }).success).toBe(true);
  });

  it.each([webhookCreate])('%j rejects more than 16 wildcard characters', (schema) => {
    expect(schema.safeParse({ ...base, watchPaths: '?'.repeat(17) }).success).toBe(false);
    expect(schema.safeParse({ ...base, watchPaths: '?'.repeat(16) }).success).toBe(true);
  });
});
