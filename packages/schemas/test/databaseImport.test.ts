import { describe, expect, it } from 'vitest';
import {
  DATABASE_IMPORT_CHUNK_SIZE,
  DATABASE_IMPORT_ENGINE_OPTIONS,
  backupDestinationObject,
  backupDestinationObjectsQuery,
  databaseImport,
  databaseImportCreate,
  databaseImportFormat,
  databaseImportOptions,
  databaseImportStatus,
} from '../src/databaseImport.js';

describe('databaseImportCreate (0.14)', () => {
  it('accepts an upload, lower-cases the sha256 and defaults options to {}', () => {
    expect(
      databaseImportCreate.parse({ source: 'upload', sizeBytes: 1024, sha256: 'AB'.repeat(32), filename: ' dump.sql.gz ' }),
    ).toEqual({ source: 'upload', sizeBytes: 1024, sha256: 'ab'.repeat(32), filename: 'dump.sql.gz', options: {} });
  });

  it('accepts an S3 object with options', () => {
    expect(
      databaseImportCreate.parse({ source: 's3', destinationId: 2, key: 'ninedeploy/app.dump', options: { clean: true } }),
    ).toEqual({ source: 's3', destinationId: 2, key: 'ninedeploy/app.dump', options: { clean: true } });
  });

  it('refuses bad sizes, hashes, filenames, keys and sources', () => {
    for (const body of [
      { source: 'upload', sizeBytes: 0 },
      { source: 'upload', sizeBytes: 1.5 },
      { source: 'upload', sizeBytes: 10, sha256: 'abc' },
      { source: 'upload', sizeBytes: 10, filename: '   ' },
      { source: 's3', destinationId: 0, key: 'k' },
      { source: 's3', destinationId: 1, key: '' },
      { source: 's3', destinationId: 1, key: 'k'.repeat(1025) },
      { source: 'url', sizeBytes: 10 },
    ]) {
      expect(databaseImportCreate.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('databaseImportOptions (strict)', () => {
  it('accepts every known key and leaves omitted ones absent', () => {
    const all = { clean: true, singleTransaction: false, drop: true, confirmReplace: true, skipSafetyBackup: false };
    expect(databaseImportOptions.parse(all)).toEqual(all);
    expect(databaseImportOptions.parse({})).toEqual({});
  });

  it('names, per importable engine, only option keys the strict schema knows', () => {
    expect(Object.keys(DATABASE_IMPORT_ENGINE_OPTIONS)).toEqual(['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'valkey', 'keydb', 'dragonfly']);
    for (const keys of Object.values(DATABASE_IMPORT_ENGINE_OPTIONS)) {
      expect(databaseImportOptions.parse(Object.fromEntries(keys.map((k) => [k, true])))).toBeDefined();
      expect(keys).toContain('skipSafetyBackup');
    }
    expect(DATABASE_IMPORT_ENGINE_OPTIONS.redis).toContain('confirmReplace');
    // 0.15.6: the Redis-protocol engines take exactly redis' options.
    expect(DATABASE_IMPORT_ENGINE_OPTIONS.keydb).toEqual(DATABASE_IMPORT_ENGINE_OPTIONS.redis);
    expect(DATABASE_IMPORT_ENGINE_OPTIONS.dragonfly).toEqual(DATABASE_IMPORT_ENGINE_OPTIONS.redis);
  });

  it('refuses unknown keys instead of dropping them', () => {
    expect(databaseImportOptions.safeParse({ noOwner: true }).success).toBe(false);
    expect(databaseImportCreate.safeParse({ source: 'upload', sizeBytes: 1, options: { path: '/etc' } }).success).toBe(false);
    expect(databaseImportOptions.safeParse({ clean: 'yes' }).success).toBe(false);
  });
});

describe('import views', () => {
  it('shapes an import row', () => {
    const row = {
      id: 1,
      databaseId: 2,
      source: 'upload',
      status: 'uploading',
      format: null,
      sizeBytes: 10,
      receivedBytes: 0,
      chunkSize: DATABASE_IMPORT_CHUNK_SIZE,
      sha256: null,
      filename: null,
      destinationId: null,
      objectKey: null,
      options: {},
      safetyBackupId: null,
      error: null,
      createdByUserId: 1,
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
    };
    expect(databaseImport.parse(row)).toEqual(row);
    expect(databaseImport.safeParse({ ...row, status: 'queued' }).success).toBe(false);
    expect(DATABASE_IMPORT_CHUNK_SIZE).toBe(8 * 1024 * 1024);
  });

  it('mirrors the db enums', () => {
    expect(databaseImportStatus.options).toHaveLength(8);
    expect(databaseImportFormat.options).toEqual(['pg_custom', 'pg_plain', 'mysql_sql', 'mongo_archive', 'rdb']);
  });

  it('shapes the destination object listing', () => {
    expect(backupDestinationObjectsQuery.parse({})).toEqual({});
    expect(backupDestinationObjectsQuery.parse({ prefix: 'ninedeploy/' })).toEqual({ prefix: 'ninedeploy/' });
    expect(backupDestinationObjectsQuery.safeParse({ prefix: 'p'.repeat(1025) }).success).toBe(false);
    const obj = { key: 'ninedeploy/a.dump', sizeBytes: 3, lastModified: null };
    expect(backupDestinationObject.parse(obj)).toEqual(obj);
  });
});
