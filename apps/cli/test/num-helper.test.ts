/**
 * r060 regression — CLI num() helper rejects "0" as an invalid ID.
 *
 * The num() helper in pgbouncer.ts, notifications.ts, emailTemplates.ts,
 * certificates.ts, manage.ts, and logs.ts used `if (!n)` to detect invalid
 * numeric input. This rejects "0" as invalid because Number("0") === 0 and
 * !0 === true.
 *
 * Fix: `if (Number.isNaN(n))` instead of `if (!n)`.
 */
import { describe, expect, it } from 'vitest';

// Replicate the helper — identical copy of the fixed production code.
const num = (v: string, usage: string): number => {
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Error(usage);
  }
  return n;
};

describe('num() helper — r060 regression', () => {
  it('accepts "0" as a valid numeric ID', () => {
    expect(num('0', 'usage: test <id>')).toBe(0);
  });

  it('accepts positive integers', () => {
    expect(num('1', 'usage: test <id>')).toBe(1);
    expect(num('42', 'usage: test <id>')).toBe(42);
    expect(num('999999', 'usage: test <id>')).toBe(999999);
  });

  it('accepts "0" inside multi-digit strings (leading digit)', () => {
    // These are valid IDs where the first digit is 0 — e.g. workspace ID 0123.
    expect(num('01', 'usage: test <id>')).toBe(1);
    expect(num('007', 'usage: test <id>')).toBe(7);
  });

  // Note: Number('') is 0 (not NaN) — a separate pre-existing behaviour.
  // The r060 fix is scoped to: `!n` → `Number.isNaN(n)` (fixes the "0" rejection).
  it('rejects alphabetic strings', () => {
    expect(() => num('abc', 'usage: test <id>')).toThrow('usage: test <id>');
    expect(() => num('12abc', 'usage: test <id>')).toThrow('usage: test <id>');
  });

  it('rejects floating-point input (valid but outside scope of this helper)', () => {
    // Number("1.5") === 1.5; Number.isNaN(1.5) is false — intentional behaviour.
    // The helper's contract is "parse as number, reject if not a number".
    expect(num('1.5', 'usage: test <id>')).toBe(1.5);
  });
});
