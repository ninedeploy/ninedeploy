import { describe, expect, it } from 'vitest';
import { iso, isoDate, listResponse } from '../src/lib/serialize.js';

describe('iso', () => {
  it('serializes a Date to an ISO string', () => {
    const d = new Date('2026-08-15T10:30:00.000Z');
    expect(iso(d)).toBe('2026-08-15T10:30:00.000Z');
  });

  it('passes null and undefined through as null', () => {
    expect(iso(null)).toBeNull();
    expect(iso(undefined)).toBeNull();
  });
});

describe('isoDate', () => {
  it('truncates to the date part', () => {
    expect(isoDate(new Date('2026-11-02T23:59:59.000Z'))).toBe('2026-11-02');
  });

  it('returns null for missing dates', () => {
    expect(isoDate(null)).toBeNull();
    expect(isoDate(undefined)).toBeNull();
  });
});

describe('listResponse', () => {
  it('wraps items with an implicit count', () => {
    expect(listResponse([1, 2, 3])).toEqual({ items: [1, 2, 3], total: 3 });
  });

  it('accepts an explicit total for paginated queries', () => {
    expect(listResponse([1], 42)).toEqual({ items: [1], total: 42 });
  });

  it('handles empty lists', () => {
    expect(listResponse([])).toEqual({ items: [], total: 0 });
  });
});
