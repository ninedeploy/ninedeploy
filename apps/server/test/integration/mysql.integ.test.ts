/**
 * Integration test: MySQL backup/restore round-trip against a live container
 * through the real engine/database.ts code path. Like the Postgres suite it is
 * excluded from the default run and gated on RUN_INTEGRATION=1 + Docker.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { Database } from '@ninedeploy/db';
import { encrypt } from '../../src/lib/crypto.js';
import { backupDatabase, restoreDatabase } from '../../src/engine/database.js';
import { capture } from '../../src/lib/exec.js';

const ENABLED = process.env.RUN_INTEGRATION === '1';
// Generated per run (test-only, never reused) so no credential is hardcoded.
const PASSWORD = process.env['INTEG_MYSQL_PASSWORD'] ?? `integ-${process.pid}-${Math.random().toString(36).slice(2)}`;

describe.skipIf(!ENABLED)('database backup/restore (real MySQL container)', () => {
  let container: StartedTestContainer;
  let db: Pick<Database, 'engine' | 'containerName' | 'passwordEncrypted'>;
  let dumpFile: string;

  beforeAll(async () => {
    // The engine's mysql backup runs as root with MYSQL_ROOT_PASSWORD auth.
    container = await new GenericContainer('mysql:8')
      .withEnvironment({ MYSQL_ROOT_PASSWORD: PASSWORD })
      .withExposedPorts(3306)
      .withWaitStrategy(Wait.forLogMessage(/ready for connections/, 2))
      .start();
    // The log line can precede the root password flip by a moment — poll
    // until the credential actually works (bounded, fails fast otherwise).
    const deadline = Date.now() + 60_000;
    for (;;) {
      // NB: `mysqladmin ping` succeeds even on access denied — verify the
      // credential actually authorizes a query.
      const ok = await capture('docker', ['exec', container.getName().replace(/^\//, ''), 'mysql', '-uroot', `-p${PASSWORD}`, '-e', 'SELECT 1']).then(() => true).catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error('mysql never accepted the root password');
      await new Promise((r) => setTimeout(r, 1000));
    }
    db = { engine: 'mysql', containerName: container.getName().replace(/^\//, ''), passwordEncrypted: encrypt(PASSWORD) };
    dumpFile = path.join(os.tmpdir(), `nd-integ-mysql-${process.pid}-${Date.now()}.sql`);
  }, 240_000);

  afterAll(async () => {
    if (dumpFile && existsSync(dumpFile)) rmSync(dumpFile, { force: true });
    if (container) await container.stop();
  });

  // mysqld's init sequence can briefly refuse connections AFTER the root
  // credential starts working (observed once on CI: "Can't connect to the
  // server" 69ms into the first statement). Retry transient connection
  // errors instead of failing the whole suite on a startup blip.
  const execSql = async (sql: string): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await capture('docker', ['exec', db.containerName, 'mysql', '-uroot', `-p${PASSWORD}`, '-e', sql]);
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!/Can't connect|server has gone away|Lost connection/i.test(message)) throw err;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    throw lastError;
  };

  it('round-trips a table through mysqldump backup and mysql restore', async () => {
    await execSql('CREATE DATABASE integ; USE integ; CREATE TABLE t (id INT, label VARCHAR(64)); INSERT INTO t VALUES (1, "roundtrip");');

    await backupDatabase(db as never, dumpFile, () => undefined);
    expect(existsSync(dumpFile)).toBe(true);
    // Encrypted at rest under the streamed NDBK1 header — no plaintext leakage.
    const atRest = readFileSync(dumpFile, 'utf8');
    expect(/^NDBK1:v\d+:/.test(atRest)).toBe(true);
    expect(atRest).not.toContain('roundtrip');

    await execSql('DROP DATABASE integ;');

    await restoreDatabase(db as never, dumpFile, () => undefined);

    const out = await execSql('SELECT label FROM integ.t;');
    expect(out).toContain('roundtrip');
  }, 180_000);
});
