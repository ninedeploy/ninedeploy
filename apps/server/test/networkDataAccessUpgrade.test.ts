/**
 * 0.14 upgrade compatibility for migration 0070 (`network_data_access`).
 *
 * A self-updating panel applies 0070 to a populated database. The migration
 * only creates four tables (database_public_access, tls_certificates,
 * database_imports, secret_providers) and their indexes; every existing row
 * must read back exactly as 0.13 left it, and a rollback to 0.13 must boot:
 *   1. apply every migration BEFORE 0070 to a scratch SQLite and seed it the
 *      way 0.13 writes (raw SQL against the 0.13 columns),
 *   2. apply 0070 with the server's own migrator,
 *   3. assert every pre-existing table (rows and DDL) is byte-identical,
 *   4. assert the 0070 SQL is only CREATE TABLE / CREATE [UNIQUE] INDEX,
 *   5. assert `rotateSecrets` re-encrypts the new encrypted column and
 *      settings keys onto the active key,
 *   6. run the 0.13 migrator (a journal without 0070) against the migrated
 *      database: it applies nothing and does not throw.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  type DB,
  databaseImports,
  databasePublicAccess,
  runMigrations,
  secretProviders,
  settings,
  tlsCertificates,
} from '@ninedeploy/db';

const OLD_KEY = 'ab'.repeat(32);
const NEW_KEY = 'cd'.repeat(32);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-0070-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);
vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
vi.stubEnv('NINEDEPLOY_MASTER_KEY', OLD_KEY);

const { encrypt, decrypt } = await import('../src/lib/crypto.js');

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TAG = '0070_network_data_access';
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal secret reference, not a template
const VAULT_REF_LITERAL = '${{vault:app/prod#password}}';
const NEW_TABLES = ['database_public_access', 'database_imports', 'secret_providers', 'tls_certificates'];
/** Tables later migrations add (0071, 0.15): not 0070's concern, so out of the byte-identity diff. */
const LATER_TABLES = ['access_grants', 'terminal_sessions', 'traffic_rollups'];

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

/** A copy of the migrations folder whose journal stops at 0069 — what 0.13 ships. */
function folderBefore0070(): string {
  const dir = path.join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  expect(at).toBeGreaterThan(0);
  expect(journal.entries[at - 1]!.tag).toBe('0069_github_app');
  // 0.15 appended 0071 after it; slicing here also drops every later entry.
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/**
 * A 0.13 database: an operator, a postgres and a redis database, an S3
 * destination with a backup on it, the instance vault settings, and a service
 * whose env var holds a literal `${{vault:…#…}}` string.
 */
async function populated013(): Promise<{ db: DB; client: Client }> {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderBefore0070() });
  for (const t of NEW_TABLES) {
    expect((await client!.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, args: [t] })).rows).toHaveLength(0);
  }
  await client!.execute(
    `INSERT INTO users (id, email, password_hash, name, is_instance_operator) VALUES (1, 'op@example.com', 'x', 'Op', 1)`,
  );
  await client!.execute({
    sql: `INSERT INTO databases (id, owner_user_id, name, slug, engine, version, status, container_name, internal_host, internal_port, username, password_encrypted, db_name, volume_name, initialized_at, created_at, updated_at)
          VALUES (1, 1, 'app', 'app', 'postgres', '16', 'running', 'nd-db-app', 'nd-db-app', 5432, 'nine', ?, 'app', 'nd-db-app', 1790000000, 1790000000, 1790000100)`,
    args: [encrypt('pg-secret')],
  });
  await client!.execute({
    sql: `INSERT INTO databases (id, name, slug, engine, status, password_encrypted) VALUES (2, 'cache', 'cache', 'redis', 'stopped', ?)`,
    args: [encrypt('redis-secret')],
  });
  await client!.execute({
    sql: `INSERT INTO backup_destinations (id, name, endpoint, bucket, access_key_id, secret_key_encrypted)
          VALUES (1, 's3', 'https://s3.eu-central-1.amazonaws.com', 'bk', 'AKIAIOSFODNN7EXAMPLE', ?)`,
    args: [encrypt('s3-secret')],
  });
  await client!.execute(
    `INSERT INTO backups (id, database_id, label, scope, status, path, remote_key, destination_id, size_bytes, created_at)
     VALUES (1, 1, 'manual', 'db', 'completed', '/data/backups/app-1.sql.enc', 'ninedeploy/app-1.sql.enc', 1, 2048, 1790000200)`,
  );
  await client!.execute(`INSERT INTO settings (key, value) VALUES ('vault_provider', '"infisical"')`);
  await client!.execute({ sql: `INSERT INTO settings (key, value) VALUES ('vault_token_encrypted', ?)`, args: [JSON.stringify(encrypt('st.tok'))] });
  await client!.execute(`INSERT INTO settings (key, value) VALUES ('panel_domain', '"panel.example.com"')`);
  await client!.execute(`INSERT INTO services (id, name, slug, type) VALUES (1, 'web', 'web', 'docker')`);
  await client!.execute({
    sql: `INSERT INTO env_vars (id, service_id, scope_key, key, value_encrypted) VALUES (1, 1, 1, 'DB_PASSWORD', ?)`,
    args: [encrypt(VAULT_REF_LITERAL)],
  });
  return { db, client: client! };
}

/** Every user table (rows sorted canonically) plus the DDL of every object, keyed by name. */
async function snapshot(client: Client, exclude: string[] = []): Promise<Record<string, unknown>> {
  const objects = (await client.execute(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name`)).rows.map((r) => ({
    type: r['type'],
    name: r['name'],
    tbl: r['tbl_name'],
    sql: r['sql'],
  }));
  const out: Record<string, unknown> = {};
  for (const o of objects) {
    if (exclude.includes(String(o.tbl))) continue;
    out[`ddl:${String(o.name)}`] = o.sql;
    if (o.type === 'table') {
      const rows = (await client.execute(`SELECT * FROM "${String(o.name)}"`)).rows.map((r) => JSON.stringify(r));
      out[`rows:${String(o.name)}`] = rows.sort();
    }
  }
  return out;
}

describe('migration 0070 upgrade compatibility', () => {
  it('is purely additive: four CREATE TABLEs and their indexes, nothing else', () => {
    const sqlText = readFileSync(path.join(migrationsFolder, `${TAG}.sql`), 'utf8');
    expect(sqlText).not.toMatch(/__new_|\bDROP\b|\bRENAME\b|\bALTER\b|INSERT INTO|^\s*UPDATE |DELETE FROM|PRAGMA/im);
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) {
      expect(s, s).toMatch(/^(CREATE TABLE `[a-z_]+` \(|CREATE (UNIQUE )?INDEX `[a-z0-9_]+` ON `[a-z_]+` \([`a-z0-9_,]+\);?$)/);
    }
    const created = statements.filter((s) => s.startsWith('CREATE TABLE')).map((s) => /^CREATE TABLE `([a-z_]+)`/.exec(s)![1]);
    expect(created.sort()).toEqual([...NEW_TABLES].sort());
    // Every index lands on one of the new tables.
    for (const s of statements.filter((x) => x.includes(' INDEX '))) {
      expect(NEW_TABLES).toContain(/ ON `([a-z_]+)`/.exec(s)![1]);
    }
  });

  it('leaves every 0.13 table byte-identical (rows and DDL) and creates the new tables empty', async () => {
    const { db, client } = await populated013();
    const before = await snapshot(client, ['__drizzle_migrations']);

    await runMigrations(db, migrationsFolder);

    const after = await snapshot(client, ['__drizzle_migrations', ...NEW_TABLES, ...LATER_TABLES]);
    expect(after).toEqual(before);
    for (const t of NEW_TABLES) {
      expect((await client.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!['n'], t).toBe(0);
    }
    // The 0.13 rows still read through the 0.14 schema, secrets intact.
    const pg = await db.query.databases.findFirst({ where: (d, { eq: e }) => e(d.id, 1) });
    expect(pg).toMatchObject({ slug: 'app', engine: 'postgres', status: 'running' });
    expect(decrypt(pg!.passwordEncrypted)).toBe('pg-secret');
    const env = await db.query.envVars.findFirst();
    expect(decrypt(env!.valueEncrypted)).toBe(VAULT_REF_LITERAL);
  });

  it('accepts rows with the declared defaults, enforces the uniques and cascades / nulls like the schema says', async () => {
    const { db, client } = await populated013();
    await runMigrations(db, migrationsFolder);
    await client.execute('PRAGMA foreign_keys = ON');

    const [pa] = await db.insert(databasePublicAccess).values({ databaseId: 1, publicPort: 15432 }).returning();
    expect(pa).toMatchObject({
      enabled: false,
      tlsMode: 'none',
      tlsHostname: null,
      ipAllowlist: [],
      containerName: null,
      appliedAt: null,
      lastError: null,
      createdByUserId: null,
    });
    expect(pa!.createdAt).toBeInstanceOf(Date);
    await expect(db.insert(databasePublicAccess).values({ databaseId: 2, publicPort: 15432 })).rejects.toThrow();
    await db.insert(databasePublicAccess).values({ databaseId: 2, publicPort: 16379, createdByUserId: 1 });

    const [cert] = await db
      .insert(tlsCertificates)
      .values({
        name: 'wildcard',
        certPem: '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----',
        keyEncrypted: encrypt('key-pem'),
        fingerprintSha256: 'ab'.repeat(32),
        notBefore: new Date('2026-01-01T00:00:00Z'),
        notAfter: new Date('2099-01-01T00:00:00Z'),
        createdByUserId: 1,
      })
      .returning();
    expect(cert).toMatchObject({ hostnames: [], subject: null, issuer: null });
    expect(cert!.notAfter.toISOString()).toBe('2099-01-01T00:00:00.000Z');
    await expect(
      db.insert(tlsCertificates).values({
        name: 'dup',
        certPem: 'x',
        keyEncrypted: 'y',
        fingerprintSha256: 'ab'.repeat(32),
        notBefore: new Date(),
        notAfter: new Date(),
      }),
    ).rejects.toThrow();

    const [imp] = await db
      .insert(databaseImports)
      .values({ databaseId: 1, source: 's3', destinationId: 1, objectKey: 'ninedeploy/app.dump', safetyBackupId: 1, createdByUserId: 1 })
      .returning();
    expect(imp).toMatchObject({
      status: 'uploading',
      format: null,
      sizeBytes: 0,
      receivedBytes: 0,
      chunkSize: 0,
      options: {},
      startedAt: null,
      completedAt: null,
    });

    const [sp] = await db.insert(secretProviders).values({ kind: 'vault', credentialEncrypted: encrypt('{"token":"t"}') }).returning();
    expect(sp).toMatchObject({ enabled: true, configJson: {}, lastTestedAt: null, lastTestError: null });
    await expect(db.insert(secretProviders).values({ kind: 'vault', credentialEncrypted: 'x' })).rejects.toThrow();

    // SET NULL: backup, destination and user deletes keep the rows.
    await client.execute('DELETE FROM backups WHERE id = 1');
    await client.execute('DELETE FROM backup_destinations WHERE id = 1');
    const impAfter = await db.query.databaseImports.findFirst({ where: eq(databaseImports.id, imp!.id) });
    expect(impAfter).toMatchObject({ safetyBackupId: null, destinationId: null, createdByUserId: 1 });
    await client.execute('DELETE FROM users WHERE id = 1');
    expect((await db.query.tlsCertificates.findFirst())!.createdByUserId).toBeNull();
    expect((await db.query.databaseImports.findFirst())!.createdByUserId).toBeNull();
    // CASCADE: deleting a database removes its public access row and imports.
    await client.execute('DELETE FROM databases WHERE id = 1');
    expect((await client.execute('SELECT database_id FROM database_public_access')).rows.map((r) => r['database_id'])).toEqual([2]);
    expect((await client.execute('SELECT COUNT(*) AS n FROM database_imports')).rows[0]!['n']).toBe(0);
  });

  it('rotateSecrets re-encrypts the certificate key, provider credentials and custom Traefik config settings', async () => {
    const { db, client } = await populated013();
    await runMigrations(db, migrationsFolder);
    await db.insert(tlsCertificates).values({
      name: 'c',
      certPem: 'pem',
      keyEncrypted: encrypt('key-pem'),
      fingerprintSha256: 'cd'.repeat(32),
      notBefore: new Date(),
      notAfter: new Date('2099-01-01T00:00:00Z'),
    });
    await db.insert(secretProviders).values({ kind: 'aws', credentialEncrypted: encrypt('{"accessKeyId":"AKIA"}') });
    await db.insert(settings).values([
      { key: 'traefik_custom_config_encrypted', value: encrypt('{"content":"http: {}"}') },
      { key: 'traefik_custom_config_last_good_encrypted', value: encrypt('{"content":"tcp: {}"}') },
    ]);
    const v0 = (await client.execute(`SELECT key_encrypted AS v FROM tls_certificates`)).rows[0]!['v'];
    expect(String(v0)).toMatch(/^v0:/);

    // Add key version 1 and rotate, as the documented procedure does.
    vi.resetModules();
    vi.stubEnv('NINEDEPLOY_MASTER_KEYS', `0:${OLD_KEY},1:${NEW_KEY}`);
    const crypto1 = await import('../src/lib/crypto.js');
    const rotation1 = await import('../src/lib/keyRotation.js');
    expect(crypto1.activeKeyVersion()).toBe(1);
    expect(await rotation1.rotateSecrets(db)).toBeGreaterThanOrEqual(4);

    const cert = await db.query.tlsCertificates.findFirst();
    const provider = await db.query.secretProviders.findFirst();
    expect(cert!.keyEncrypted).toMatch(/^v1:/);
    expect(provider!.credentialEncrypted).toMatch(/^v1:/);
    expect(crypto1.decrypt(cert!.keyEncrypted)).toBe('key-pem');
    expect(crypto1.decrypt(provider!.credentialEncrypted)).toBe('{"accessKeyId":"AKIA"}');
    for (const key of ['traefik_custom_config_encrypted', 'traefik_custom_config_last_good_encrypted']) {
      const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
      expect(String(row!.value), key).toMatch(/^v1:/);
    }
    // The 0.13 secrets moved too (sanity: the registry walk ran end to end).
    const pg = await db.query.databases.findFirst({ where: (d, { eq: e }) => e(d.id, 1) });
    expect(crypto1.decrypt(pg!.passwordEncrypted)).toBe('pg-secret');
    expect(pg!.passwordEncrypted).toMatch(/^v1:/);
  });

  it('the 0.13 migrator (journal without 0070) applies nothing to a 0.14 database and does not throw', async () => {
    const { db, client } = await populated013();
    await runMigrations(db, migrationsFolder);
    await db.insert(databasePublicAccess).values({ databaseId: 1, publicPort: 15432, enabled: true, ipAllowlist: ['203.0.113.0/24'] });
    const before = await snapshot(client);
    const journalRows = (await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')).rows[0]!['n'];

    await expect(runMigrations(db, folderBefore0070())).resolves.toBeTypeOf('string');

    expect((await client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')).rows[0]!['n']).toBe(journalRows);
    expect(await snapshot(client)).toEqual(before);
    // The 0.14 table and its row are simply left alone for a later re-upgrade.
    expect((await db.query.databasePublicAccess.findFirst())!.publicPort).toBe(15432);
  });
});
