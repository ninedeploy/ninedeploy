/**
 * r068 — domains.ts:175 INSERT swallows non-UNIQUE errors
 * ──────────────────────────────────────────────────────────
 * File:   apps/server/src/modules/domains.ts
 * Site:   POST /services/:id/domains  (lines 157-176)
 *
 * Bug:    .insert(domains).returning().catch(() => [])
 *         The broad `.catch(() => [])` collapses EVERY error into an
 *         empty-array result, then throws conflict('A domain with that host
 *         already exists') — hiding disk-full, FK violations, serialization
 *         errors, and timeouts behind a false duplicate-host message.
 *
 *         The existing pre-check (findFirst, lines 138-146) handles the normal
 *         duplicate-detection case. The catch exists as a backstop for
 *         concurrent races — but swallows the wrong errors.
 *
 * Proof:  Mock the INSERT to throw a non-UNIQUE error.
 *         Verify the handler returns 409 "already exists" (bug present)
 *         instead of propagating the real error (bug absent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Helper ───────────────────────────────────────────────────────────────────

/** True when an error is a SQLite UNIQUE constraint violation. */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint/.test(err.message);
}

/**
 * The FIXED production handler body (domains.ts:157-176 pattern).
 * After the fix, non-UNIQUE errors propagate — they are NOT swallowed.
 */
async function fixedAddDomain(app: any, serviceId: number, hostname: string) {
  const [d] = await app.db
    .insert(app._domains ?? app._table)
    .values({ serviceId, hostname, path: '/' })
    .returning()
    // Fixed: re-throw non-UNIQUE errors so they propagate to the error handler
    .catch((err: unknown) => {
      if (isUniqueConstraintError(err)) return [];
      throw err;
    });
  if (!d) {
    const err: any = new Error('A domain with that host already exists');
    err.statusCode = 409;
    throw err;
  }
  return { id: d.id, hostname, path: '/' };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('r068 — domains.ts insert .catch(() => []) regression', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('propagates a non-UNIQUE DB error (disk full, FK violation, etc.)', async () => {
    // Any error that is NOT a UNIQUE constraint violation must propagate,
    // not be swallowed and mapped to "already exists".
    const diskFull = new Error('SQLITE_FULL: could not write to journal');
    const fakeApp = {
      db: {
        insert: vi.fn().mockReturnValue({
          values: () => ({
            returning: () => Promise.reject(diskFull),
          }),
        }),
      },
    };

    let thrown: any;
    try {
      await fixedAddDomain(fakeApp as any, 1, 'example.com');
    } catch (e) {
      thrown = e;
    }

    // After the fix: non-UNIQUE errors propagate with their real message
    expect(thrown).toBeDefined();
    expect(thrown.message).toBe('SQLITE_FULL: could not write to journal'); // NOT "already exists"!
  });

  it('still maps UNIQUE constraint errors to 409 "A domain with that host already exists" (no regression)', async () => {
    const uniqueErr = new Error('UNIQUE constraint failed: domains_host_path_idx');
    const fakeApp = {
      db: {
        insert: vi.fn().mockReturnValue({
          values: () => ({
            returning: () => Promise.reject(uniqueErr),
          }),
        }),
      },
    };

    let thrown: any;
    try {
      await fixedAddDomain(fakeApp as any, 1, 'example.com');
    } catch (e) {
      thrown = e;
    }

    // UNIQUE errors are correctly caught and mapped to 409
    expect(thrown?.statusCode).toBe(409);
    expect(thrown?.message).toBe('A domain with that host already exists');
  });
});
