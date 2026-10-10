/**
 * 0.14 dump import, lib side: format detection (magic bytes, gzip), option
 * and engine refusals, the safety-backup skip rule, disk and S3-key checks,
 * the mysql and psql filters (each reviewer-named bypass, and real dump
 * fixtures that must still pass), the job (verify → safety backup → import →
 * credential probe; the envelope rule; failures), and the recovery,
 * expiry and retention sweeps against a real migrated SQLite.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backups, createDb, databaseImports, databases, type DB, users } from '@ninedeploy/db';

const m = vi.hoisted(() => ({
  importDatabase: vi.fn(),
  probe: vi.fn(async () => true),
  stage: vi.fn(),
  validate: vi.fn(),
  audit: vi.fn(async () => undefined),
  s3Get: vi.fn(),
}));
vi.mock('../../src/engine/database.js', async (orig) => ({
  ...(await orig<typeof import('../../src/engine/database.js')>()),
  importDatabase: m.importDatabase,
  probeDatabaseCredentials: m.probe,
  stageForRestore: m.stage,
}));
vi.mock('../../src/lib/backupDrill.js', () => ({ validateDumpFile: m.validate }));
vi.mock('../../src/lib/audit.js', () => ({ audit: m.audit }));
vi.mock('../../src/lib/s3.js', async (orig) => ({ ...(await orig<typeof import('../../src/lib/s3.js')>()), s3GetToFile: m.s3Get }));

const L = await import('../../src/lib/databaseImport.js');
const { importCommand } = await import('../../src/engine/database.js');
const { parseImportMaxBytes, DEFAULT_IMPORT_MAX_BYTES } = await import('../../src/config.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-import-lib-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const file = (content: string | Buffer, name = `f${++seq}`) => {
  const p = path.join(tmp, name);
  writeFileSync(p, content);
  return p;
};

// ── fixtures ─────────────────────────────────────────────────────────────
/** pg_dump 18 plain output (abridged): \restrict, SET lines, \connect, a dollar body, COPY with \. */
const PG_PLAIN = String.raw`--
-- PostgreSQL database dump
--

\restrict 7dW3kq9ZpL0aXb2NcVv4RtYu8Ii1Oo5Ee6Ss

-- Dumped from database version 18.0 (Debian 18.0-1.pgdg13+3)
-- Dumped by pg_dump version 18.0 (Debian 18.0-1.pgdg13+3)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

\connect app

CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
\echo a backslash line inside a dollar body is data
  NEW.note := 'x\y';
  RETURN NEW;
END
$_$;

/* a block /* nested */ comment */
CREATE TABLE public.notes (
    id integer NOT NULL,
    note text,
    CONSTRAINT notes_check CHECK ((note ~ '^\S+$'::text))
);

COMMENT ON TABLE public.notes IS 'it''s a table; \! not a command';

COPY public.notes (id, note) FROM stdin;
1	\\! data, not a command
2	\N
\.

--
-- PostgreSQL database dump complete
--

\unrestrict 7dW3kq9ZpL0aXb2NcVv4RtYu8Ii1Oo5Ee6Ss
`;

/** mysqldump 8.4 output (abridged): versioned comments, escaped quotes, a trigger under DELIMITER. `~` stands for a backtick. */
const MYSQL_DUMP = String.raw`-- MySQL dump 10.13  Distrib 8.4.3, for Linux (x86_64)
--
-- Host: localhost    Database: app
-- ------------------------------------------------------
-- Server version	8.4.3

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;

USE ~app~;
DROP TABLE IF EXISTS ~users~;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
CREATE TABLE ~users~ (
  ~id~ int NOT NULL AUTO_INCREMENT,
  ~email~ varchar(255) DEFAULT NULL, # who
  PRIMARY KEY (~id~)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
LOCK TABLES ~users~ WRITE;
INSERT INTO ~users~ VALUES (1,'root@mysql.com'),(2,'O\'Brien \\ USE mysql; mysql.user'),(3,"say \"hi\" \! no");
UNLOCK TABLES;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=~root~@~%~*/ /*!50003 TRIGGER ~t1~ BEFORE INSERT ON ~users~ FOR EACH ROW SET NEW.email = LOWER(NEW.email) */;;
DELIMITER ;
-- a comment naming mysql.user is not code
/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
-- Dump completed on 2026-10-08 12:00:00
`.replaceAll('~', '`');

const MONGO_ARCHIVE = Buffer.concat([Buffer.from([0x6d, 0xe2, 0x99, 0x81]), Buffer.from('archive body'), Buffer.from([0xff, 0xff, 0xff, 0xff])]);

// ── pure helpers ─────────────────────────────────────────────────────────
describe('format detection', () => {
  it('reads magic bytes, inside one layer of gzip too', () => {
    expect(L.sniffBytes(Buffer.from('PGDMP\x01\x0e'))).toEqual({ gzip: false, kind: 'pg_custom' });
    expect(L.sniffBytes(gzipSync(Buffer.from('PGDMP\x01\x0e')))).toEqual({ gzip: true, kind: 'pg_custom' });
    expect(L.sniffBytes(MONGO_ARCHIVE)).toEqual({ gzip: false, kind: 'mongo_archive' });
    expect(L.sniffBytes(gzipSync(MONGO_ARCHIVE))).toEqual({ gzip: true, kind: 'mongo_archive' });
    expect(L.sniffBytes(Buffer.from('REDIS0012'))).toEqual({ gzip: false, kind: 'rdb' });
    expect(L.sniffBytes(Buffer.from('VALKEY080'))).toEqual({ gzip: false, kind: 'rdb' });
    expect(L.sniffBytes(Buffer.from('NDBK1:v1:abc\n'))).toEqual({ gzip: false, kind: 'envelope' });
    expect(L.sniffBytes(Buffer.from('v3:abcdef'))).toEqual({ gzip: false, kind: 'envelope' });
    expect(L.sniffBytes(gzipSync(Buffer.from('NDBK1:v1:x')))).toEqual({ gzip: true, kind: 'envelope' });
    const tar = Buffer.alloc(512);
    tar.write('ustar', 257, 'latin1');
    tar.write('toc.dat', 0);
    expect(L.sniffBytes(tar).kind).toBe('tar');
    expect(L.sniffBytes(Buffer.from('SELECT 1;\n')).kind).toBe('text');
    expect(L.sniffBytes(Buffer.from([0x41, 0x00, 0x42])).kind).toBe('binary');
    expect(L.sniffBytes(Buffer.alloc(0)).kind).toBe('empty');
    // A truncated gzip head still classifies; garbage after the magic is binary.
    expect(L.sniffBytes(gzipSync(Buffer.from('SELECT 1;\n'.repeat(10_000))).subarray(0, 64)).kind).toBe('text');
    expect(L.sniffBytes(Buffer.from([0x1f, 0x8b, 0xff, 0xff, 0xff]))).toEqual({ gzip: true, kind: 'binary' });
  });

  it('sniffs a file by its head only', async () => {
    expect(await L.sniffFile(file(gzipSync(Buffer.from(PG_PLAIN))))).toEqual({ gzip: true, kind: 'text' });
  });

  it('maps each engine to its format and refuses the rest with 422', () => {
    const t = (kind: string, gzip = false) => ({ gzip, kind }) as never;
    expect(L.formatFor('postgres', t('pg_custom'))).toBe('pg_custom');
    expect(L.formatFor('postgres', t('text', true))).toBe('pg_plain');
    expect(L.formatFor('mysql', t('text'))).toBe('mysql_sql');
    expect(L.formatFor('mariadb', t('text', true))).toBe('mysql_sql');
    expect(L.formatFor('mongo', t('mongo_archive', true))).toBe('mongo_archive');
    expect(L.formatFor('redis', t('rdb'))).toBe('rdb');
    expect(L.formatFor('valkey', t('rdb'))).toBe('rdb');
    expect(L.formatFor('keydb', t('rdb'))).toBe('rdb');
    expect(L.formatFor('dragonfly', t('rdb', true))).toBe('rdb');
    const refused = (engine: string, kind: string, re: RegExp) => {
      try {
        L.formatFor(engine, t(kind));
        throw new Error('accepted');
      } catch (err) {
        expect((err as { statusCode?: number }).statusCode).toBe(422);
        expect((err as Error).message).toMatch(re);
      }
    };
    refused('postgres', 'tar', /tar and directory formats/);
    refused('postgres', 'binary', /pg_dump custom-format archive or plain SQL/);
    refused('mysql', 'pg_custom', /plain SQL dump/);
    refused('mongo', 'text', /mongodump --archive/);
    refused('redis', 'text', /RDB/);
    refused('clickhouse', 'text', /not supported for clickhouse/);
    refused('meilisearch', 'text', /not supported/);
    refused('rabbitmq', 'text', /not supported/);
  });
});

describe('options, engines and the safety-backup rule', () => {
  it('refuses keys that do not apply to the engine', () => {
    expect(() => L.resolveImportOptions('mysql', { drop: true })).toThrow(/drop do not apply to mysql/);
    expect(() => L.resolveImportOptions('postgres', { confirmReplace: true })).toThrow(/confirmReplace/);
    expect(() => L.resolveImportOptions('mongo', { clean: true, singleTransaction: false })).toThrow(/clean, singleTransaction/);
    expect(() => L.resolveImportOptions('clickhouse', {})).toThrow(/not supported for clickhouse/);
  });

  it('defaults singleTransaction on for postgres only, and requires confirmReplace for an RDB', () => {
    expect(L.resolveImportOptions('postgres', {})).toEqual({ singleTransaction: true });
    expect(L.resolveImportOptions('postgres', { singleTransaction: false, clean: true })).toEqual({ singleTransaction: false, clean: true });
    expect(L.resolveImportOptions('mysql', {})).toEqual({});
    expect(L.resolveImportOptions('mongo', { drop: true, skipSafetyBackup: undefined })).toEqual({ drop: true });
    expect(() => L.resolveImportOptions('redis', {})).toThrow(/confirmReplace/);
    expect(() => L.resolveImportOptions('valkey', { confirmReplace: false })).toThrow(/confirmReplace/);
    expect(L.resolveImportOptions('valkey', { confirmReplace: true })).toEqual({ confirmReplace: true });
    for (const engine of ['keydb', 'dragonfly']) {
      expect(() => L.resolveImportOptions(engine, {})).toThrow(/confirmReplace/);
      expect(L.resolveImportOptions(engine, { confirmReplace: true, skipSafetyBackup: undefined })).toEqual({ confirmReplace: true });
      expect(() => L.resolveImportOptions(engine, { confirmReplace: true, drop: true })).toThrow(/do not apply to/);
    }
  });

  it('lets only an operator, or a database initialised < 10 minutes ago, skip the safety backup', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const at = (minutesAgo: number | null) => ({ initializedAt: minutesAgo === null ? null : new Date(now - minutesAgo * 60_000) });
    expect(L.canSkipSafetyBackup(at(null), true, now)).toBe(true);
    expect(L.canSkipSafetyBackup(at(5), false, now)).toBe(true);
    expect(L.canSkipSafetyBackup(at(11), false, now)).toBe(false);
    expect(L.canSkipSafetyBackup(at(null), false, now)).toBe(false);
    expect(L.canSkipSafetyBackup(at(-5), false, now)).toBe(false);
    expect(() => L.assertMaySkipSafetyBackup(at(30), { skipSafetyBackup: true }, false, now)).toThrow(/operators/);
    expect(() => L.assertMaySkipSafetyBackup(at(30), {}, false, now)).not.toThrow();
  });
});

describe('disk, size and S3 keys', () => {
  it('needs 2 × size + 512 MiB free (507 otherwise)', async () => {
    const MiB = 1048576;
    const fs = (free: number) => async () => ({ bavail: BigInt(free / 4096), bsize: 4096 });
    await expect(L.assertFreeSpace('/x', 100 * MiB, fs(712 * MiB))).resolves.toBeUndefined();
    await expect(L.assertFreeSpace('/x', 100 * MiB, fs(708 * MiB))).rejects.toMatchObject({ statusCode: 507 });
    await expect(L.freeBytes(tmp)).resolves.toBeGreaterThan(0);
  });

  it('caps the size at NINEDEPLOY_IMPORT_MAX_BYTES (413), default 10 GiB', () => {
    expect(() => L.assertImportSize(11, 10)).toThrow(/at most 10/);
    expect(() => L.assertImportSize(10, 10)).not.toThrow();
    expect(DEFAULT_IMPORT_MAX_BYTES).toBe(10 * 1024 ** 3);
    expect(parseImportMaxBytes(undefined)).toBe(DEFAULT_IMPORT_MAX_BYTES);
    expect(parseImportMaxBytes(' 1048576 ')).toBe(1048576);
    for (const bad of ['', '0', '10G', '1.5', '-1', '99999999999999999999']) expect(parseImportMaxBytes(bad)).toBe(DEFAULT_IMPORT_MAX_BYTES);
  });

  it('keeps S3 keys inside the destination prefix, with no dot segments', () => {
    expect(L.keyWithinPrefix('ninedeploy', 'ninedeploy/app.dump')).toBe(true);
    expect(L.keyWithinPrefix('/ninedeploy/', 'ninedeploy/a/b.sql.gz')).toBe(true);
    expect(L.keyWithinPrefix('', 'anything.dump')).toBe(true);
    expect(L.keyWithinPrefix('ninedeploy', 'other/app.dump')).toBe(false);
    expect(L.keyWithinPrefix('ninedeploy', 'ninedeployx/app.dump')).toBe(false);
    expect(L.keyWithinPrefix('ninedeploy', 'ninedeploy/../secret')).toBe(false);
    expect(L.keyWithinPrefix('ninedeploy', 'ninedeploy/./x')).toBe(false);
    expect(L.keyWithinPrefix('ninedeploy', 'ninedeploy\\..\\x')).toBe(false);
    expect(L.keyWithinPrefix('ninedeploy', '/ninedeploy/x')).toBe(false);
    expect(L.keyWithinPrefix('', 'a/\u0000')).toBe(false);
  });

  it('creates a 0600 staging file once, and removes it with its decompressed sibling', async () => {
    const dir = path.join(tmp, 'staging');
    const p = await L.createStagingFile(dir, 7);
    expect(p).toBe(path.join(dir, '7.part'));
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
    await expect(L.createStagingFile(dir, 7)).rejects.toThrow();
    writeFileSync(`${p}.raw`, 'x');
    await L.removeStaging(p);
    expect(existsSync(p) || existsSync(`${p}.raw`)).toBe(false);
    await expect(L.removeStaging(null)).resolves.toBeUndefined();
  });
});

describe('streaming helpers', () => {
  it('hashes a file', async () => {
    expect(await L.sha256File(file('abc'))).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('decompresses within a byte cap, and refuses a bomb', async () => {
    const src = file(gzipSync(Buffer.from('x'.repeat(10_000))));
    const ok = path.join(tmp, 'ok.raw');
    await L.gunzipTo(src, ok, 10_000);
    expect(readFileSync(ok, 'utf8')).toHaveLength(10_000);
    const bomb = path.join(tmp, 'bomb.raw');
    await expect(L.gunzipTo(src, bomb, 9_999)).rejects.toThrow(/exceeds/);
    expect(existsSync(bomb)).toBe(false);
    await expect(L.gunzipTo(file('not gzip'), path.join(tmp, 'bad.raw'), 100)).rejects.toThrow(/could not decompress/);
  });
});

describe('psql meta-command allowlist (operators and non-operators alike)', () => {
  const scan = (sql: string) => L.scanPsqlMetaCommands(file(sql));

  it('accepts real pg_dump plain output, gzip-free, CRLF too', async () => {
    expect(await scan(PG_PLAIN)).toBeNull();
    expect(await scan(PG_PLAIN.replace(/\n/g, '\r\n'))).toBeNull();
    expect(await scan('\\c "My DB"\n\\connect -reuse-previous=on "dbname=\'a b\'"\n\\set ON_ERROR_STOP on\n\\.\nSELECT 1;')).toBeNull();
  });

  it('a COPY header whose COPY fails: its data is skipped here, and psql stops on the failure', async () => {
    // psql would run "\! id" as a command if it went on after the failed COPY;
    // the scanner treats it as data because ON_ERROR_STOP=1 (always passed,
    // never switchable off by the dump) stops psql at the failure instead.
    expect(await scan('COPY public.missing_table (a) FROM stdin;\n\\! id\n\\.\n')).toBeNull();
    expect(importCommand('postgres', 'c', '/tmp/f', { format: 'pg_plain' }, 'pw')).toEqual(expect.arrayContaining(['-v', 'ON_ERROR_STOP=1']));
    expect(await scan('\\set ON_ERROR_STOP off\n')).toMatch(/ON_ERROR_STOP off/);
  });

  it.each([
    ['shell escape', '\\! id'],
    ['shell escape mid-line', "SELECT 1; \\! id"],
    ['shell escape after a closed literal', "SELECT 'a', 'b''c'; \\! id"],
    ['\\set with backticks', '\\set x `id`'],
    ['\\set of another variable', '\\set AUTOCOMMIT off'],
    ['\\i', '\\i /etc/passwd'],
    ['\\ir', '\\ir other.sql'],
    ['\\include', '\\include /etc/passwd'],
    ['\\o to a file', '\\o /tmp/out'],
    ['\\o to a pipe', '\\o |sh'],
    ['\\g to a pipe', 'SELECT 1 \\g |sh'],
    ['\\w', '\\w /tmp/x'],
    ['\\lo_import', '\\lo_import /etc/passwd'],
    ['\\lo_export', '\\lo_export 1 /tmp/x'],
    ['\\prompt', '\\prompt x y'],
    ['\\copy … program', "\\copy t from program 'id'"],
    ['\\setenv', '\\setenv PAGER sh'],
    ['\\gexec', 'SELECT 1 \\gexec'],
    ['\\connect with a backtick', '\\connect app `id`'],
    ['\\connect with a pipe', '\\connect "a|b"'],
    ['\\connect with a variable', '\\connect :db'],
    ['\\restrict with a non-alphanumeric key', '\\restrict a-b'],
    ['E-string escape hiding a quote', "SELECT E'it\\'s';\n\\! id"],
    ['COPY header inside a block comment', '/*\nCOPY t FROM stdin;\n*/\n\\! id\n\\.'],
    ['COPY header inside a dollar body', 'DO $$\nCOPY t FROM stdin;\n$$;\n\\! id\n\\.'],
    ['COPY header inside a literal', "SELECT '\nCOPY t FROM stdin;\n';\n\\! id\n\\."],
    ['COPY header with a trailing comment', 'COPY t FROM stdin; -- x\n\\! id\n\\.'],
    ['COPY header that is not a statement', 'COPY t -- x FROM stdin;\n\\! id\n\\.'],
    ['COPY header after an unfinished statement', 'SELECT 1\nCOPY t FROM stdin;\n\\! id\n\\.'],
    ['COPY header after another statement on the line', 'SELECT 1; COPY t FROM stdin;\n\\! id\n\\.'],
    ['the set_config bypass', String.raw`SELECT set_config('standard_conforming_strings', 'off', false);
SELECT 'a\';
\! id
';`],
    ['a quoted SET bypass', String.raw`SET "standard_conforming_strings" = 'off';
SELECT 'x\'; \! id; --';`],
  ])('refuses %s', async (_name, sql) => {
    expect(await scan(sql)).not.toBeNull();
  });

  it('dual lex: refuses a dump whose line states differ with backslash escapes on and off', async () => {
    expect(await scan(String.raw`SELECT 'a\';
SELECT 1;
';`)).toMatch(/reads differently/);
    expect(await scan(String.raw`SELECT 'a\'`)).toMatch(/reads differently/);
    // A bare setting change with no literal that reads two ways is harmless.
    expect(await scan('SET standard_conforming_strings = off;\nSELECT 1;')).toBeNull();
  });

  it('refuses a line too long to lex outside COPY data', async () => {
    expect(await scan(`SELECT '${'x'.repeat(4 * 1024 * 1024 + 10)}';`)).toMatch(/longer than 4 MiB/);
    // …but not inside COPY data.
    expect(await scan(`COPY t FROM stdin;\n${'x'.repeat(4 * 1024 * 1024 + 10)}\n\\.\n`)).toBeNull();
  });
});

describe('mysql dump filter (non-operators)', () => {
  const scan = (sql: string) => L.scanMysqlDump(file(sql));

  it('accepts a real mysqldump, a mariadb-dump sandbox header and USE app', async () => {
    expect(await scan(MYSQL_DUMP)).toBeNull();
    expect(await scan(MYSQL_DUMP.replace(/\n/g, '\r\n'))).toBeNull();
    expect(await scan('/*M!999999\\- enable the sandbox mode */ \n-- MariaDB dump 10.19\nUSE app;\nCREATE TABLE t (a int);\n')).toBeNull();
  });

  it.each([
    ['USE mysql', 'USE mysql;'],
    ['use `sys`', 'use `sys`;'],
    ['USE of another database', 'USE other_db;'],
    ['USE split over lines', 'SELECT 1; USE\n`performance_schema`;'],
    ['CREATE DATABASE mysql', 'CREATE DATABASE IF NOT EXISTS mysql;'],
    ['CREATE DATABASE in a versioned comment', 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `mysql`;'],
    ['INSERT INTO mysql.user', "INSERT INTO mysql.user VALUES ('x');"],
    ['UPDATE with spaced, quoted qualifier', 'UPDATE `mysql` . `user` SET authentication_string = 1;'],
    ['GRANT on mysql.*', 'GRANT ALL ON mysql.* TO x;'],
    ['REPLACE INTO mysql', 'REPLACE INTO mysql.db VALUES (1);'],
    ['a comment between keyword and schema', 'DELETE FROM/**/mysql.db;'],
    ['information_schema', 'SELECT * FROM information_schema.tables;'],
    ['sys qualifier after a keyword-free context', 'CALL sys.ps_setup_enable_instrument(1);'],
    ['a qualifier inside a versioned comment', '/*!50000 INSERT INTO mysql.user VALUES (1) */;'],
    ['a qualifier after a backslash-escaped literal', "INSERT INTO t VALUES ('a\\\\'); INSERT INTO mysql.user VALUES (1);"],
    ['\\! shell escape', '\\! id'],
    ['\\! mid-line', 'SELECT 1 \\! id'],
    ['\\u', '\\u mysql'],
    ['\\r', '\\r mysql'],
    ['\\. source', '\\. /tmp/x.sql'],
    ['source', 'source /tmp/x.sql'],
    ['system', 'system id'],
    ['connect', 'connect mysql'],
    ['tee', 'tee /tmp/x'],
    ['NO_BACKSLASH_ESCAPES', "SET sql_mode = 'NO_BACKSLASH_ESCAPES';"],
    ['ANSI_QUOTES', "/*!40101 SET SQL_MODE='ANSI_QUOTES' */;"],
    ['sql_mode ANSI', "SET SESSION sql_mode = 'ANSI';"],
  ])('refuses %s', async (_name, sql) => {
    expect(await scan(sql)).not.toBeNull();
  });

  it('finds a hit past the first 64 KiB of code', async () => {
    expect(await scan(`${'INSERT INTO t VALUES (1);\n'.repeat(5000)}INSERT INTO mysql.user VALUES (1);\n`)).toMatch(/mysql\./);
  });
});

// ── the job and the sweeps, against a real migrated SQLite ───────────────
let db: DB;
let close: () => void;
let dbId: number;
const OWNER = 1;

async function seedDb(engine = 'postgres', over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(databases)
    .values({ name: `${engine}-${++seq}`, slug: `${engine}-${seq}`, engine: engine as never, status: 'running', containerName: `nd-db-${seq}`, passwordEncrypted: 'v1:x', ...over })
    .returning();
  return row!.id;
}

async function importRow(content: string | Buffer, over: Partial<typeof databaseImports.$inferInsert> = {}) {
  const staging = file(content, `${++seq}.part`);
  const [row] = await db
    .insert(databaseImports)
    .values({
      databaseId: dbId,
      source: 'upload',
      status: 'running',
      sizeBytes: Buffer.byteLength(content),
      receivedBytes: Buffer.byteLength(content),
      chunkSize: 8,
      stagingPath: staging,
      options: { singleTransaction: true },
      createdByUserId: OWNER,
      ...over,
    })
    .returning();
  return row!;
}
const reload = async (id: number) => (await db.query.databaseImports.findFirst({ where: eq(databaseImports.id, id) }))!;
const actions = () => m.audit.mock.calls.map((c) => c[2]);

async function setupDb() {
  vi.clearAllMocks();
  m.probe.mockResolvedValue(true);
  m.importDatabase.mockImplementation(async (_d, _f, plan: { safetyBackup?: { onDone: () => Promise<void> } }) => {
    await plan.safetyBackup?.onDone();
  });
  m.validate.mockResolvedValue({ outcome: 'passed', details: {} });
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: OWNER, email: 'o@example.com', passwordHash: 'x' });
  dbId = await seedDb();
}

describe('runImportJob', () => {
  beforeEach(setupDb);
  afterEach(() => close());

  it('verifies, takes the safety backup, imports, probes — and records it all', async () => {
    const row = await importRow(PG_PLAIN, { sha256: createHash('sha256').update(PG_PLAIN).digest('hex') });
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: false });
    const done = await reload(row.id);
    expect(done).toMatchObject({ status: 'completed', format: 'pg_plain', error: null, stagingPath: null });
    expect(done.completedAt).toBeInstanceOf(Date);
    const plan = m.importDatabase.mock.calls[0]![2];
    expect(plan).toMatchObject({ format: 'pg_plain', singleTransaction: true, gzip: false });
    expect(plan.safetyBackup.file).toMatch(/-pre-import\.dump$/);
    const [b] = await db.select().from(backups);
    expect(b).toMatchObject({ databaseId: dbId, scope: 'db', label: 'pre-import', status: 'completed' });
    expect(done.safetyBackupId).toBe(b!.id);
    expect(actions()).toEqual(['database.import.safety_backup', 'database.import.complete']);
    // Meta carries size/format/source, never contents.
    expect(JSON.stringify(m.audit.mock.calls.map((c) => c.slice(1)))).not.toContain('PostgreSQL database dump');
    expect(existsSync(row.stagingPath!)).toBe(false);
  });

  it('marks a failed safety backup and fails the import', async () => {
    m.importDatabase.mockImplementation(async (_d, _f, plan: { safetyBackup: { onFailed: (e: unknown) => Promise<void> } }) => {
      await plan.safetyBackup.onFailed(new Error('disk full'));
      throw new Error('disk full');
    });
    const row = await importRow(PG_PLAIN);
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: false });
    expect((await reload(row.id)).status).toBe('failed');
    expect((await db.select().from(backups))[0]!.status).toBe('failed');
  });

  it('skips the safety backup when the options say so (the routes enforce who may)', async () => {
    const row = await importRow(PG_PLAIN, { options: { skipSafetyBackup: true, singleTransaction: false } });
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: true });
    expect(m.importDatabase.mock.calls[0]![2].safetyBackup).toBeUndefined();
    expect(m.importDatabase.mock.calls[0]![2].singleTransaction).toBe(false);
    expect(await db.select().from(backups)).toHaveLength(0);
  });

  it('reports changed credentials as completed_with_warnings', async () => {
    m.probe.mockResolvedValue(false);
    const row = await importRow(PG_PLAIN);
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: false });
    expect(await reload(row.id)).toMatchObject({ status: 'completed_with_warnings', error: L.CREDENTIALS_CHANGED_WARNING });
  });

  it('fails on a sha256 mismatch before touching the database', async () => {
    const row = await importRow(PG_PLAIN, { sha256: 'a'.repeat(64) });
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: false });
    const r = await reload(row.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/sha256 mismatch/);
    expect(m.importDatabase).not.toHaveBeenCalled();
    expect(await db.select().from(backups)).toHaveLength(0);
    expect(actions()).toEqual(['database.import.fail']);
    expect(existsSync(row.stagingPath!)).toBe(false);
  });

  it('refuses an envelope from a non-operator; an operator goes through stageForRestore', async () => {
    const env = 'NDBK1:v1:abc\nciphertext';
    const row = await importRow(env);
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: false });
    expect(await reload(row.id)).toMatchObject({ status: 'failed', error: L.ENVELOPE_REFUSAL });
    expect(m.stage).not.toHaveBeenCalled();

    const dec = file(PG_PLAIN);
    const cleanup = vi.fn();
    m.stage.mockResolvedValue({ path: dec, cleanup });
    const op = await importRow(env);
    await L.runImportJob(db, op.id, { actorId: OWNER, isOperator: true });
    expect(await reload(op.id)).toMatchObject({ status: 'completed', format: 'pg_plain' });
    expect(m.importDatabase.mock.calls[0]![1]).toBe(dec);
    expect(cleanup).toHaveBeenCalled();
  });

  it('refuses a gzipped envelope and an envelope that decrypts to another one', async () => {
    const gz = await importRow(gzipSync(Buffer.from('NDBK1:v1:x')));
    await L.runImportJob(db, gz.id, { actorId: OWNER, isOperator: true });
    expect((await reload(gz.id)).error).toMatch(/gzip-compressed NineDeploy backup/);
    m.stage.mockResolvedValue({ path: file('v1:again'), cleanup: vi.fn() });
    const nested = await importRow('NDBK1:v1:x');
    await L.runImportJob(db, nested.id, { actorId: OWNER, isOperator: true });
    expect((await reload(nested.id)).error).toMatch(/itself an envelope/);
  });

  it('decompresses a gzipped SQL dump for psql, but hands mongo its gzip archive as-is', async () => {
    let seen = '';
    m.importDatabase.mockImplementation(async (_d, f: string) => {
      seen = readFileSync(f, 'utf8');
    });
    const row = await importRow(gzipSync(Buffer.from(PG_PLAIN)), { options: { skipSafetyBackup: true } });
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: true });
    expect(seen).toBe(PG_PLAIN);
    expect(existsSync(`${row.stagingPath}.raw`)).toBe(false);

    dbId = await seedDb('mongo');
    const mongo = await importRow(gzipSync(MONGO_ARCHIVE), { options: { drop: true, skipSafetyBackup: true } });
    await L.runImportJob(db, mongo.id, { actorId: OWNER, isOperator: true });
    expect(m.importDatabase.mock.calls[1]![1]).toBe(mongo.stagingPath);
    expect(m.importDatabase.mock.calls[1]![2]).toMatchObject({ format: 'mongo_archive', gzip: true, drop: true });
  });

  it('refuses the wrong format, and clean on plain SQL', async () => {
    const bad = await importRow(MONGO_ARCHIVE);
    await L.runImportJob(db, bad.id, { actorId: OWNER, isOperator: true });
    expect((await reload(bad.id)).error).toMatch(/not a pg_dump/);
    const clean = await importRow(PG_PLAIN, { options: { clean: true } });
    await L.runImportJob(db, clean.id, { actorId: OWNER, isOperator: true });
    expect((await reload(clean.id)).error).toMatch(/options.clean applies to custom-format/);
  });

  it('applies the psql allowlist to operators too', async () => {
    const row = await importRow(`${PG_PLAIN}\\! id\n`);
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: true });
    expect((await reload(row.id)).error).toMatch(/psql meta-command/);
    expect(m.importDatabase).not.toHaveBeenCalled();
  });

  it('mysql: the system-schema scan and the sandbox flag bind non-operators only', async () => {
    dbId = await seedDb('mysql');
    const dump = `${MYSQL_DUMP}INSERT INTO mysql.user VALUES (1);\n`;
    const nonOp = await importRow(dump);
    await L.runImportJob(db, nonOp.id, { actorId: OWNER, isOperator: false, sandboxFlag: '--sandbox' });
    expect((await reload(nonOp.id)).error).toMatch(/mysql system schema/);
    const noFlag = await importRow(MYSQL_DUMP);
    await L.runImportJob(db, noFlag.id, { actorId: OWNER, isOperator: false, sandboxFlag: null });
    expect((await reload(noFlag.id)).error).toMatch(/no sandbox flag/);
    const ok = await importRow(MYSQL_DUMP);
    await L.runImportJob(db, ok.id, { actorId: OWNER, isOperator: false, sandboxFlag: '--system-command=OFF' });
    expect((await reload(ok.id)).status).toBe('completed');
    expect(m.importDatabase.mock.calls.at(-1)![2]).toMatchObject({ format: 'mysql_sql', sandboxFlag: '--system-command=OFF' });
    const op = await importRow(dump);
    await L.runImportJob(db, op.id, { actorId: OWNER, isOperator: true, sandboxFlag: null });
    expect((await reload(op.id)).status).toBe('completed');
  });

  it('adds the DEFINER hint to a mysql error naming a definer privilege', async () => {
    dbId = await seedDb('mariadb');
    m.importDatabase.mockImplementation(async (_d, _f, _p, log: (l: string) => void) => {
      log('ERROR 1227 (42000) at line 12: Access denied; you need (at least one of) the SUPER or SET_USER_ID privilege(s)');
      throw new Error('`docker exec …` exited with code 1');
    });
    const row = await importRow(MYSQL_DUMP, { options: { skipSafetyBackup: true } });
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: false, sandboxFlag: '--sandbox' });
    const r = await reload(row.id);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('SET_USER_ID');
    expect(r.error).toContain(L.DEFINER_HINT);
  });

  it('redis: validates the RDB in the engine image first, and refuses an invalid one', async () => {
    dbId = await seedDb('valkey', { version: '9.1' });
    m.validate.mockResolvedValueOnce({ outcome: 'failed', error: 'valkey-check-rdb rejected the file' });
    const bad = await importRow('REDIS0012junk', { options: { confirmReplace: true } });
    await L.runImportJob(db, bad.id, { actorId: OWNER, isOperator: false });
    expect((await reload(bad.id)).error).toMatch(/did not validate: valkey-check-rdb/);
    expect(m.validate).toHaveBeenCalledWith('valkey', bad.stagingPath, 'valkey/valkey:9.1');
    expect(m.importDatabase).not.toHaveBeenCalled();
    const ok = await importRow('REDIS0012', { options: { confirmReplace: true } });
    await L.runImportJob(db, ok.id, { actorId: OWNER, isOperator: false });
    expect((await reload(ok.id)).status).toBe('completed');
    expect(m.importDatabase.mock.calls[0]![2].format).toBe('rdb');
  });

  it('fails cleanly when the database or the file is gone, and ignores an unknown id', async () => {
    const row = await importRow(PG_PLAIN, { stagingPath: null });
    await L.runImportJob(db, row.id, { actorId: OWNER, isOperator: false });
    expect((await reload(row.id)).error).toMatch(/uploaded file is gone/);
    await expect(L.runImportJob(db, 999_999, { actorId: OWNER, isOperator: false })).resolves.toBeUndefined();
  });
});

describe('S3 download', () => {
  beforeEach(setupDb);
  afterEach(() => close());

  const cfg = { endpoint: 'https://s3.invalid', region: 'r', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' };

  it('promotes the import to pending once the size matches', async () => {
    const row = await importRow('', { source: 's3', status: 'uploading', sizeBytes: 5, receivedBytes: 0, objectKey: 'ninedeploy/a.sql' });
    m.s3Get.mockImplementation(async (_c, _k, f: string) => writeFileSync(f, '12345'));
    await L.downloadS3Import(db, row, cfg, OWNER);
    expect(await reload(row.id)).toMatchObject({ status: 'pending', receivedBytes: 5 });
    expect(m.s3Get).toHaveBeenCalledWith(cfg, 'ninedeploy/a.sql', row.stagingPath);
  });

  it('fails on a size mismatch or a download error, and drops the file', async () => {
    const row = await importRow('', { source: 's3', status: 'uploading', sizeBytes: 9, receivedBytes: 0, objectKey: 'k' });
    m.s3Get.mockImplementation(async (_c, _k, f: string) => writeFileSync(f, '123'));
    await L.downloadS3Import(db, row, cfg, OWNER);
    expect(await reload(row.id)).toMatchObject({ status: 'failed' });
    expect((await reload(row.id)).error).toMatch(/downloaded 3 bytes/);
    expect(existsSync(row.stagingPath!)).toBe(false);
    expect(actions()).toContain('database.import.fail');
  });

  it('a cancel during the download wins: the file is deleted, not promoted', async () => {
    const row = await importRow('', { source: 's3', status: 'uploading', sizeBytes: 2, receivedBytes: 0, objectKey: 'k' });
    m.s3Get.mockImplementation(async (_c, _k, f: string) => {
      writeFileSync(f, 'ab');
      await db.update(databaseImports).set({ status: 'cancelled' }).where(eq(databaseImports.id, row.id));
    });
    await L.downloadS3Import(db, row, cfg, OWNER);
    expect((await reload(row.id)).status).toBe('cancelled');
    expect(existsSync(row.stagingPath!)).toBe(false);
  });
});

describe('recovery, expiry and retention', () => {
  beforeEach(setupDb);
  afterEach(() => close());

  it('boot: running imports become failed ("interrupted by panel restart")', async () => {
    const running = await importRow('x');
    const pending = await importRow('x', { status: 'pending' });
    expect(await L.recoverInterruptedImports(db)).toEqual([running.id]);
    expect(await reload(running.id)).toMatchObject({ status: 'failed', error: L.INTERRUPTED_IMPORT_ERROR, stagingPath: null });
    expect((await reload(pending.id)).status).toBe('pending');
    expect(actions()).toEqual(['database.import.fail']);
    expect(await L.recoverInterruptedImports(db)).toEqual([]);
  });

  it('expires uploading/pending imports idle for 24h and deletes their staging', async () => {
    const now = Date.now();
    const old = new Date(now - L.STALE_IMPORT_MS - 60_000);
    const stale = await importRow('x', { status: 'uploading', updatedAt: old });
    const stalePending = await importRow('x', { status: 'pending', updatedAt: old });
    const fresh = await importRow('x', { status: 'uploading' });
    const done = await importRow('x', { status: 'completed', updatedAt: old });
    // updatedAt is $onUpdate: pin the old values after insert.
    for (const r of [stale, stalePending, done]) await db.run(`UPDATE database_imports SET updated_at = ${Math.floor(old.getTime() / 1000)} WHERE id = ${r.id}` as never);
    expect((await L.expireStaleImports(db, now)).sort()).toEqual([stale.id, stalePending.id].sort());
    expect((await reload(stale.id)).status).toBe('expired');
    expect(existsSync(stale.stagingPath!)).toBe(false);
    expect((await reload(fresh.id)).status).toBe('uploading');
    expect((await reload(done.id)).status).toBe('completed');
  });

  it('prunes finished rows older than 90 days, never live ones', async () => {
    const now = Date.now();
    const ancient = Math.floor((now - L.FINISHED_IMPORT_RETENTION_MS - 86_400_000) / 1000);
    const oldDone = await importRow('x', { status: 'completed' });
    const oldLive = await importRow('x', { status: 'uploading' });
    const recent = await importRow('x', { status: 'failed' });
    for (const r of [oldDone, oldLive]) await db.run(`UPDATE database_imports SET created_at = ${ancient} WHERE id = ${r.id}` as never);
    expect(await L.pruneFinishedImports(db, now)).toBe(1);
    const left = (await db.select().from(databaseImports)).map((r) => r.id).sort();
    expect(left).toEqual([oldLive.id, recent.id].sort());
  });

  it('deletes orphan staging files older than 24h, keeping live imports and other files', async () => {
    const dir = mkdtempSync(path.join(tmp, 'orphans-'));
    const live = await importRow('x', { status: 'uploading' });
    const names = [`${live.id}.part`, '424242.part', '424242.part.raw', 'notes.txt', '5.part'];
    for (const n of names) writeFileSync(path.join(dir, n), 'x');
    const old = (Date.now() - L.STALE_IMPORT_MS - 60_000) / 1000;
    for (const n of names.slice(0, 4)) utimesSync(path.join(dir, n), old, old);
    expect(await L.pruneOrphanStaging(db, dir)).toBe(2);
    expect(existsSync(path.join(dir, `${live.id}.part`))).toBe(true);
    expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(path.join(dir, '5.part'))).toBe(true); // too young
    expect(await L.pruneOrphanStaging(db, path.join(tmp, 'missing-dir'))).toBe(0);
  });

  it('serializes without the staging path', async () => {
    const row = await importRow('x', { source: 's3', objectKey: 'ninedeploy/a', destinationId: null });
    const view = L.serializeImport(await reload(row.id));
    expect(view).not.toHaveProperty('stagingPath');
    expect(view).toMatchObject({ id: row.id, status: 'running', startedAt: null, objectKey: 'ninedeploy/a' });
    expect(L.importAuditMeta(row)).toMatchObject({ source: 's3', key: 'ninedeploy/a' });
    expect(L.importAuditMeta({ ...row, source: 'upload' })).not.toHaveProperty('key');
  });
});
