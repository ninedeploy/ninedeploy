import { describe, expect, it } from 'vitest';
import { confirmedNodeProbe } from '../../src/lib/nodeProbeReceipt.js';

describe('node probe evidence', () => {
  it('accepts exactly one successful response for the requested protocol', () => {
    expect(confirmedNodeProbe(['ND-PROBE {"ready":true,"protocol":"http","status":204}'], 0, 'http')).toBe(true);
    expect(confirmedNodeProbe(['ND-PROBE {"ready":true,"protocol":"tcp"}'], 0, 'tcp')).toBe(true);
  });
  it.each([
    [], ['ND-PROBE {'], ['ND-PROBE null'], ['ND-PROBE []'],
    ['ND-PROBE {"ready":true,"protocol":"http"}'],
    ['ND-PROBE {"ready":true,"protocol":"http","status":503}'],
    ['ND-PROBE {"ready":true,"protocol":"tcp"}'],
    ['ND-PROBE {"ready":true,"protocol":"http","status":200}', 'ND-PROBE {"ready":true,"protocol":"http","status":200}'],
    [`ND-PROBE ${'x'.repeat(16_384)}`],
  ].map(lines => ({ lines })))('rejects missing, malformed or contradictory HTTP evidence: %j', ({ lines }) => {
    expect(confirmedNodeProbe(lines, 0, 'http')).toBe(false);
  });
  it('rejects a successful-looking receipt from a failed operation', () => {
    expect(confirmedNodeProbe(['ND-PROBE {"ready":true,"protocol":"tcp"}'], 1, 'tcp')).toBe(false);
  });
});
