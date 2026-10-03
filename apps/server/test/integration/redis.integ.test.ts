/**
 * Integration test: Redis backup path against a live container through the real
 * engine/database.ts code (redis-cli SAVE + docker cp of dump.rdb). Redis has
 * no restore path by design (see engine/database.ts), so this verifies the
 * backup half plus at-rest encryption. Gated on RUN_INTEGRATION=1 + Docker.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { Database } from '@ninedeploy/db';
import { encrypt } from '../../src/lib/crypto.js';
import { backupDatabase } from '../../src/engine/database.js';
import { capture } from '../../src/lib/exec.js';

const ENABLED = process.env.RUN_INTEGRATION === '1';
// Managed databases always carry a password (the engine decrypts it for
// `redis-cli -a`), so the fixture models one: requirepass in the container,
// its encrypted envelope in the row.
const PASSWORD = `integ-${process.pid}-${Math.random().toString(36).slice(2)}`;

describe.skipIf(!ENABLED)('database backup (real Redis container)', () => {
  let container: StartedTestContainer;
  let db: Pick<Database, 'engine' | 'containerName' | 'passwordEncrypted'>;
  let dumpFile: string;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7')
      .withCommand(['redis-server', '--appendonly', 'no', '--requirepass', PASSWORD])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    db = { engine: 'redis', containerName: container.getName().replace(/^\//, ''), passwordEncrypted: encrypt(PASSWORD) };
    dumpFile = path.join(os.tmpdir(), `nd-integ-redis-${process.pid}-${Date.now()}.rdb`);
  }, 240_000);

  afterAll(async () => {
    if (dumpFile && existsSync(dumpFile)) rmSync(dumpFile, { force: true });
    if (container) await container.stop();
  });

  it('persists keys into an encrypted dump.rdb backup', async () => {
    const set = await capture('docker', ['exec', db.containerName, 'redis-cli', '-a', PASSWORD, '--no-auth-warning', 'SET', 'integ:key', 'roundtrip']);
    expect(set.trim()).toBe('OK');

    await backupDatabase(db as never, dumpFile, () => undefined);
    expect(existsSync(dumpFile)).toBe(true);
    // The RDB is ENCRYPTED at rest under the streamed NDBK1 header — the
    // AT-REST file must not contain the literal value in binary form.
    const atRest = readFileSync(dumpFile, 'utf8');
    expect(/^NDBK1:v\d+:/.test(atRest)).toBe(true);
    expect(atRest).not.toContain('roundtrip');
  }, 120_000);
});
