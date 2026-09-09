import { describe, expect, it, vi } from 'vitest';
import { findUserByEmail } from '../../src/lib/authHelpers.js';

describe('findUserByEmail (r039 coverage)', () => {
  it('returns undefined without touching the database for a blank email', async () => {
    const findFirst = vi.fn();
    const db = { query: { users: { findFirst } } } as never;
    await expect(findUserByEmail(db, '   ')).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('looks the trimmed+lowercased email up and returns the matching user', async () => {
    const user = { id: 7, email: 'ann@example.com' };
    const findFirst = vi.fn(async () => user);
    const db = { query: { users: { findFirst } } } as never;
    await expect(findUserByEmail(db, '  Ann@Example.com ')).resolves.toBe(user);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when no user matches', async () => {
    const db = { query: { users: { findFirst: vi.fn(async () => undefined) } } } as never;
    await expect(findUserByEmail(db, 'nobody@example.com')).resolves.toBeUndefined();
  });
});
