import { describe, expect, it } from 'vitest';
import { isENOENT } from '../../src/lib/fsErrors.js';

describe('isENOENT', () => {
  it('returns true for an Error with code === "ENOENT"', () => {
    expect(isENOENT({ code: 'ENOENT' })).toBe(true);
  });

  it('returns true for a NodeJS.ErrnoException', () => {
    const err = new Error('no such file or directory') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    err.errno = -4058;
    err.path = '/nope';
    err.syscall = 'open';
    expect(isENOENT(err)).toBe(true);
  });

  it('returns false for a generic Error', () => {
    expect(isENOENT(new Error('boom'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isENOENT(null)).toBe(false);
    expect(isENOENT(undefined)).toBe(false);
    expect(isENOENT('ENOENT')).toBe(false);
    expect(isENOENT(42)).toBe(false);
  });

  it('returns false for other fs error codes', () => {
    expect(isENOENT({ code: 'EACCES' })).toBe(false);
    expect(isENOENT({ code: 'EISDIR' })).toBe(false);
  });
});
