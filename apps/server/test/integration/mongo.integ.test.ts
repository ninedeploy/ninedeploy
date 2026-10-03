/**
 * Integration test: MongoDB backup/restore round-trip against a live container
 * through the real engine/database.ts code path (mongodump archive → mongorestore).
 * Gated on RUN_INTEGRATION=1 + Docker.
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
const PASSWORD = process.env['INTEG_MONGO_PASSWORD'] ?? `integ-${process.pid}-${Math.random().toString(36).slice(2)}`;

describe.skipIf(!ENABLED)('database backup/restore (real MongoDB container)', () => {
  let container: StartedTestContainer;
  let db: Pick<Database, 'engine' | 'containerName' | 'passwordEncrypted'>;
  let dumpFile: string;

  beforeAll(async () => {
    container = await new GenericContainer('mongo:7')
      .withEnvironment({ MONGO_INITDB_ROOT_USERNAME: 'nine', MONGO_INITDB_ROOT_PASSWORD: PASSWORD })
      .withExposedPorts(27017)
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/, 2))
      .start();
    // The user is created during the init phase; poll until auth works.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ok = await capture('docker', [
        'exec', container.getName().replace(/^\//, ''),
        'mongosh', '-u', 'nine', '-p', PASSWORD, '--authenticationDatabase', 'admin', '--quiet', '--eval', 'db.adminCommand({ping: 1}).ok',
      ]).then((out) => out.includes('1')).catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error('mongo never accepted the root user');
      await new Promise((r) => setTimeout(r, 1000));
    }
    db = { engine: 'mongo', containerName: container.getName().replace(/^\//, ''), passwordEncrypted: encrypt(PASSWORD) };
    dumpFile = path.join(os.tmpdir(), `nd-integ-mongo-${process.pid}-${Date.now()}.archive`);
  }, 240_000);

  afterAll(async () => {
    if (dumpFile && existsSync(dumpFile)) rmSync(dumpFile, { force: true });
    if (container) await container.stop();
  });

  const execMongo = (js: string) =>
    capture('docker', [
      'exec', db.containerName,
      'mongosh', '-u', 'nine', '-p', PASSWORD, '--authenticationDatabase', 'admin', '--quiet', '--eval', js,
    ]);

  it('round-trips a document through mongodump and mongorestore', async () => {
    const inserted = await execMongo('db.getSiblingDB("app").integ.insertOne({label: "roundtrip"}); db.getSiblingDB("app").integ.countDocuments()');
    expect(inserted.trim()).toBe('1');

    await backupDatabase(db as never, dumpFile, () => undefined);
    expect(existsSync(dumpFile)).toBe(true);
    // Encrypted at rest under the streamed NDBK1 header — the document value
    // must not appear in the file.
    const atRest = readFileSync(dumpFile, 'utf8');
    expect(/^NDBK1:v\d+:/.test(atRest)).toBe(true);
    expect(atRest).not.toContain('roundtrip');

    // Wipe the collection, then restore the archive with --drop.
    await execMongo('db.getSiblingDB("app").integ.drop()');

    await restoreDatabase(db as never, dumpFile, () => undefined);

    const out = await execMongo('db.getSiblingDB("app").integ.findOne().label');
    expect(out.trim()).toBe('roundtrip');
  }, 180_000);
});
