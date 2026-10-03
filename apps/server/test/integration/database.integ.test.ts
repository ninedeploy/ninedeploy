/**
 * Integration test: verifies the real database.ts backup/restore path against a
 * live PostgreSQL container (the exact code that previously had ZERO end-to-end
 * verification — only mocked argv assertions).
 *
 * These tests are EXCLUDED from the default `vitest run` (see vitest.config
 * `exclude: ['test/integration/**']`) and require a reachable Docker daemon.
 *
 * Run them locally / in CI with:
 *   RUN_INTEGRATION=1 pnpm --filter @ninedeploy/server exec vitest run test/integration --no-coverage
 *
 * They are also guarded by `describe.skipIf` so they no-op when the flag is unset.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Database } from '@ninedeploy/db';
import { backupDatabase, restoreDatabase } from '../../src/engine/database.js';
import { capture } from '../../src/lib/exec.js';

const ENABLED = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!ENABLED)('database backup/restore (real PostgreSQL container)', () => {
  let container: StartedPostgreSqlContainer;
  // database.ts only reads engine + containerName for postgres backup/restore.
  let db: Pick<Database, 'engine' | 'containerName' | 'passwordEncrypted'>;
  let dumpFile: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withUsername('nine') // matches ENGINES.postgres.username()
      .withDatabase('app') // matches ENGINES.postgres.dbName()
      // NOTE: no leading/trailing spaces — the image's pg_isready health check
      // authenticates with this password and fails to become healthy otherwise.
      .withPassword('integ-test-pw!9')
      .start();
    db = { engine: 'postgres', containerName: container.getName().replace(/^\//, ''), passwordEncrypted: '' };
    dumpFile = path.join(os.tmpdir(), `nd-integ-${process.pid}-${Date.now()}.sql`);
  }, 180_000);

  afterAll(async () => {
    if (dumpFile && existsSync(dumpFile)) rmSync(dumpFile, { force: true });
    if (container) await container.stop();
  });

  const execSql = (sql: string) =>
    capture('docker', ['exec', db.containerName, 'psql', '-U', 'nine', '-d', 'app', '-v', 'ON_ERROR_STOP=1', '-c', sql]);

  it('round-trips a table through pg_dump backup and psql restore', async () => {
    await execSql("CREATE TABLE integ (id int, label text); INSERT INTO integ VALUES (1, 'roundtrip');");

    await backupDatabase(db as never, dumpFile, () => undefined);
    expect(existsSync(dumpFile)).toBe(true);
    // The dump is ENCRYPTED at rest: the streamed `NDBK1:v<version>:<iv>`
    // header followed by AES-GCM body, not plaintext.
    const atRest = readFileSync(dumpFile, 'utf8');
    expect(/^NDBK1:v\d+:/.test(atRest)).toBe(true);
    expect(atRest).not.toContain('roundtrip');

    // r165: restore INTO the live database — the realistic case. This used
    // to DROP the table first because a plain dump could only be restored
    // into an empty database ("relation already exists").
    await execSql("UPDATE integ SET label = 'changed-after-backup';");

    await restoreDatabase(db as never, dumpFile, () => undefined);

    const out = await execSql('SELECT label FROM integ;');
    expect(out).toContain('roundtrip');
  }, 120_000);
});
