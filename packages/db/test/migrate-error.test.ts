import { describe, expect, it, vi } from 'vitest';

// Make every existence probe fail so resolveMigrationsFolder genuinely finds no
// candidate folder (all internal calls are real — only existsSync is stubbed).
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: vi.fn(() => false) };
});

vi.mock('drizzle-orm/libsql/migrator', () => ({ migrate: vi.fn() }));

import { runMigrations } from '../src/migrate.js';

describe('runMigrations folder resolution failure', () => {
  it('throws when no migrations folder can be located', async () => {
    await expect(runMigrations({} as never)).rejects.toThrow(
      'Drizzle migrations folder not found — set NINEDEPLOY_MIGRATIONS_DIR',
    );
  });
});
