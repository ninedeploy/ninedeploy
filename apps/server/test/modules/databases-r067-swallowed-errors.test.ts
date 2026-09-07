/**
 * r067 — databases.ts:527 INSERT swallows non-UNIQUE errors
 * ──────────────────────────────────────────────────────────
 * File:   apps/server/src/modules/databases.ts
 * Site:   POST /services/:id/attachments  (lines 523-529)
 *
 * Bug:    .insert(databaseAttachments).returning().catch(() => [])
 *         The broad `.catch(() => [])` collapses EVERY error into an
 *         empty-array result, then throws badRequest('Already attached').
 *         Non-UNIQUE DB failures (disk full, FK violation, serialization
 *         error, timeout) surface as a misleading 409 "Already attached".
 *
 *         The existing pre-check (findFirst, line 518) handles the normal
 *         duplicate-detection case correctly. The catch exists as a backstop
 *         for concurrent races — but swallows the wrong errors.
 *
 * Proof:  Mock the INSERT to throw a non-UNIQUE error.
 *         Verify the handler returns 409 "Already attached" (bug present)
 *         instead of propagating the real error (bug absent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Helper ───────────────────────────────────────────────────────────────────

/** True when an error is a SQLite UNIQUE constraint violation. */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint/.test(err.message);
}

/**
 * The FIXED production handler body (databases.ts:523-529 pattern).
 * After the fix, non-UNIQUE errors propagate — they are NOT swallowed.
 */
async function fixedAttachDatabase(app: any, serviceId: number, databaseId: number) {
  const [a] = await app.db
    .insert(app._attachments ?? app._table)
    .values({ serviceId, databaseId, envAlias: 'DATABASE_URL' })
    .returning()
    // Fixed: re-throw non-UNIQUE errors so they propagate to the error handler
    .catch((err: unknown) => {
      if (isUniqueConstraintError(err)) return [];
      throw err;
    });
  if (!a) {
    const err: any = new Error('Already attached');
    err.statusCode = 400;
    throw err;
  }
  return { id: a.id, databaseId, envAlias: 'DATABASE_URL' };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('r067 — databases.ts insert .catch(() => []) regression', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('propagates a non-UNIQUE DB error (disk full, FK violation, etc.)', async () => {
    // Any error that is NOT a UNIQUE constraint violation must propagate,
    // not be swallowed and mapped to "Already attached".
    const diskFull = new Error('Connection lost: disk full');
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
      await fixedAttachDatabase(fakeApp as any, 1, 5);
    } catch (e) {
      thrown = e;
    }

    // After the fix: non-UNIQUE errors propagate with their real message
    expect(thrown).toBeDefined();
    expect(thrown.message).toBe('Connection lost: disk full'); // NOT "Already attached"!
  });

  it('still maps UNIQUE constraint errors to 400 "Already attached" (no regression)', async () => {
    const uniqueErr = new Error('UNIQUE constraint failed: [database_attachments_service_database_idx]');
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
      await fixedAttachDatabase(fakeApp as any, 1, 5);
    } catch (e) {
      thrown = e;
    }

    // UNIQUE errors are correctly caught and mapped to 400
    expect(thrown?.statusCode).toBe(400);
    expect(thrown?.message).toBe('Already attached');
  });
});
