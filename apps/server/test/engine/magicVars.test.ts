/**
 * r063 — Regression tests for `generateValue` (r027 fix verification).
 *
 * The r027 bug: `generateValue` used `randomBytes(chars / 2).toString('hex')` which
 * silently truncated odd-length secrets when `chars / 2` was fractional (floor truncation).
 *   HEX_1  (1/2 = 0.5 → floor → 0 bytes → "") produced an empty string.
 *   HEX_25 (25/2 = 12.5 → floor → 12 bytes → 24 hex chars) produced 24 chars.
 * Fix: `Math.ceil(chars / 2)` + `.slice(0, chars)` guarantees exact-length output.
 *
 * These tests call `generateValue` directly — no mocks, no injectable seam —
 * to ensure the fix is durable and not silently reverted.
 */
import { describe, expect, it } from 'vitest';
import { generateValue } from '../../src/engine/magicVars.js';

describe('generateValue hex token length (r027 regression)', () => {
  it('generates HEX_1 as exactly 1 hex char', () => {
    const value = generateValue({ raw: 'SERVICE_HEX_1', kind: 'hex', size: 1 });
    expect(value).toMatch(/^[0-9a-f]$/);
    expect(value.length).toBe(1);
  });

  it('generates HEX_3 as exactly 3 hex chars (odd-length boundary)', () => {
    const value = generateValue({ raw: 'SERVICE_HEX_3', kind: 'hex', size: 3 });
    expect(value).toMatch(/^[0-9a-f]{3}$/);
    expect(value.length).toBe(3);
  });

  it('generates HEX_25 as exactly 25 hex chars (odd-length regression)', () => {
    const value = generateValue({ raw: 'SERVICE_HEX_25', kind: 'hex', size: 25 });
    expect(value).toMatch(/^[0-9a-f]{25}$/);
    expect(value.length).toBe(25);
  });

  it('generates HEX_32 as exactly 32 hex chars (even-length sanity)', () => {
    const value = generateValue({ raw: 'SERVICE_HEX_32', kind: 'hex', size: 32 });
    expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(value.length).toBe(32);
  });

  it('generates HEX_64 as exactly 64 hex chars (large even-length)', () => {
    const value = generateValue({ raw: 'SERVICE_HEX_64', kind: 'hex', size: 64 });
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(value.length).toBe(64);
  });

  it('generates HEX_65 as exactly 65 hex chars (large odd-length)', () => {
    const value = generateValue({ raw: 'SERVICE_HEX_65', kind: 'hex', size: 65 });
    expect(value).toMatch(/^[0-9a-f]{65}$/);
    expect(value.length).toBe(65);
  });

});
