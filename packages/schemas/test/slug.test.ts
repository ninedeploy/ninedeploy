import { describe, expect, it } from 'vitest';
import { slugifyResourceName } from '../src/index.js';

describe('slugifyResourceName', () => {
  it('derives a DNS label from any name, and does it the same way twice', () => {
    expect(slugifyResourceName('My App!')).toBe('my-app');
    expect(slugifyResourceName(slugifyResourceName('My App!'))).toBe('my-app');
    // A one-letter name is padded to the two characters a label needs.
    expect(slugifyResourceName('  --a--  ')).toBe('aa');
    expect(slugifyResourceName('!!!')).toBe('service');
    expect(slugifyResourceName('a'.repeat(70))).toBe('a'.repeat(63));
    // Cut at 63 before the trailing separator is dropped, so a label never ends with one.
    expect(slugifyResourceName('ab '.repeat(40))).toBe(`${'ab-'.repeat(20)}ab`);
  });
});
