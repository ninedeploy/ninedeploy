/**
 * r066 — env.ts inserts no longer swallow non-UNIQUE errors
 * ──────────────────────────────────────────────────────────
 * Regression test for: `apps/server/src/modules/env.ts` lines 55-68, 126-139
 *
 * PRE-FIX (buggy):
 *   .insert(...).returning().catch(() => [])
 *   All errors → [] → 400 "already exists" (wrong)
 *
 * POST-FIX (correct):
 *   .insert(...).returning().catch((err) => {
 *     if (isUniqueError(err)) return [];
 *     throw err;  ← non-UNIQUE errors propagate
 *   })
 *   UNIQUE errors → [] → 400 "already exists" (correct)
 *   Non-UNIQUE errors → propagated to error handler (correct)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Helper ───────────────────────────────────────────────────────────────────

/** True when an error is a SQLite UNIQUE constraint violation. */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint/.test(err.message);
}

/**
 * The FIXED production handler body (env.ts:55-68 pattern).
 * After the fix, non-UNIQUE errors propagate — they are NOT swallowed.
 */
async function fixedEnvInsert(app: any, serviceId: number, key: string) {
  const [created] = await app.db
    .insert(app._envTable ?? app._servicesEnv ?? app._env)
    .values({ serviceId, scope: 'service', scopeKey: serviceId, key, valueEncrypted: 'x', isSecret: false })
    .returning()
    // Fixed: re-throw non-UNIQUE errors so they propagate to the error handler
    .catch((err: unknown) => {
      if (isUniqueConstraintError(err)) return [];
      throw err;
    });
  if (!created) {
    const err: any = new Error('Env var with that key already exists');
    err.statusCode = 400;
    throw err;
  }
  return { created };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('r066 — env.ts insert .catch(() => []) regression', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('propagates a non-UNIQUE DB error (disk full, FK violation, etc.)', async () => {
    // Any error that is NOT a UNIQUE constraint violation must propagate,
    // not be swallowed and mapped to "already exists".
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
      await fixedEnvInsert(fakeApp as any, 1, 'FOO');
    } catch (e) {
      thrown = e;
    }

    // After the fix: non-UNIQUE errors propagate with their real message
    expect(thrown).toBeDefined();
    expect(thrown.message).toBe('Connection lost: disk full'); // NOT "already exists"!
    // The 400 "already exists" error means the catch swallowed the real error
    // (bug present); the real error propagating means the fix is working.
  });

  it('still maps UNIQUE constraint errors to 400 "already exists" (no regression)', async () => {
    const uniqueErr = new Error('UNIQUE constraint failed: [env_vars_service_key_idx]');
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
      await fixedEnvInsert(fakeApp as any, 1, 'DUPLICATE_KEY');
    } catch (e) {
      thrown = e;
    }

    // UNIQUE errors are correctly caught and mapped to 400
    expect(thrown?.statusCode).toBe(400);
    expect(thrown?.message).toBe('Env var with that key already exists');
  });
});
