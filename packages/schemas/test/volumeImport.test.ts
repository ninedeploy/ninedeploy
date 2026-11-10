import { describe, expect, it } from 'vitest';
import { VOLUME_IMPORT_CHUNK_SIZE, volumeImport, volumeImportCreate, volumeImportStatus } from '../src/index.js';

describe('volume import schemas', () => {
  it('requires a size and a sha256, lower-cased', () => {
    expect(volumeImportCreate.parse({ sizeBytes: 10, sha256: ` ${'AB'.repeat(32)} `, filename: ' a.tar.gz ' })).toEqual({ sizeBytes: 10, sha256: 'ab'.repeat(32), filename: 'a.tar.gz' });
    expect(volumeImportCreate.safeParse({ sizeBytes: 10 }).success).toBe(false);
    expect(volumeImportCreate.safeParse({ sizeBytes: 0, sha256: 'a'.repeat(64) }).success).toBe(false);
    expect(volumeImportCreate.safeParse({ sizeBytes: 1, sha256: 'z'.repeat(64) }).success).toBe(false);
  });

  it('describes a row and its statuses', () => {
    expect(VOLUME_IMPORT_CHUNK_SIZE).toBe(8 * 1024 * 1024);
    expect(volumeImportStatus.options).toEqual(['uploading', 'pending', 'running', 'completed', 'failed', 'cancelled', 'expired']);
    const row = {
      id: 1, serviceId: 2, volumeName: 'nd-svc-a-data', status: 'completed', sizeBytes: 1, receivedBytes: 1, chunkSize: 8, sha256: 'a'.repeat(64),
      filename: null, safetyBackupId: 3, error: null, createdByUserId: null, createdAt: 'x', updatedAt: 'x', startedAt: null, completedAt: null,
    };
    expect(volumeImport.parse(row)).toEqual(row);
  });
});
