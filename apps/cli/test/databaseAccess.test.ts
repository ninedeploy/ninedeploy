import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseImport, databaseImports, databasePublicAccess, importOptionsFrom } from '../src/commands/databaseAccess.js';

/** 0.14: `ninedeploy databases public-access | import | imports`. */

const ESC = String.fromCharCode(27);

const STATUS = {
  supported: true,
  configured: true,
  enabled: true,
  port: 15432,
  tlsMode: 'none' as const,
  tlsHostname: null as string | null,
  ipAllowlist: ['203.0.113.0/24'],
  status: 'running' as const,
  lastError: null as string | null,
  appliedAt: '2026-10-08T00:00:00.000Z' as string | null,
  publicHost: 'db.example.com' as string | null,
};

const ROW = {
  id: 9,
  databaseId: 4,
  source: 'upload' as const,
  status: 'completed' as string,
  format: 'pg_custom' as string | null,
  sizeBytes: 10,
  receivedBytes: 10,
  chunkSize: 4,
  sha256: null,
  filename: 'dump.sql' as string | null,
  destinationId: null,
  objectKey: null as string | null,
  options: {},
  safetyBackupId: 31 as number | null,
  error: null as string | null,
  createdByUserId: 1,
  createdAt: '',
  updatedAt: '',
  startedAt: null,
  completedAt: null,
};

function makeClient() {
  return {
    databases: {
      publicAccess: { get: vi.fn(), set: vi.fn(), disable: vi.fn() },
      imports: { create: vi.fn(), start: vi.fn(), list: vi.fn(), wait: vi.fn() },
      importFile: vi.fn(),
    },
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
const stderr = () => stderrSpy.mock.calls.map((c) => String(c[0])).join('');

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('databases public-access', () => {
  it('shows the status, with the endpoint and sanitised entries', async () => {
    const client = makeClient();
    client.databases.publicAccess.get.mockResolvedValue({
      ...STATUS,
      tlsMode: 'terminate',
      tlsHostname: `db${ESC}[2J.example.com`,
      ipAllowlist: [`198.51.100.7${ESC}]8;;x`],
      lastError: `bind failed${ESC}[5m`,
    });
    await databasePublicAccess(client as never, '4');
    const text = out();
    expect(text).toContain('db.example.com:15432');
    expect(text).toContain('terminate (db.example.com)');
    expect(text).toContain('198.51.100.7');
    expect(text).toContain('bind failed');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).not.toContain(`${ESC}[5m`);
  });

  it('shows unsupported, unconfigured and minimal states', async () => {
    const client = makeClient();
    client.databases.publicAccess.get.mockResolvedValueOnce({ ...STATUS, supported: false });
    await databasePublicAccess(client as never, '4');
    expect(out()).toContain('cannot be exposed');
    client.databases.publicAccess.get.mockResolvedValueOnce({ ...STATUS, configured: false });
    await databasePublicAccess(client as never, '4');
    expect(out()).toContain('never been configured');
    client.databases.publicAccess.get.mockResolvedValueOnce({
      ...STATUS, enabled: false, status: 'off', ipAllowlist: [], publicHost: null, appliedAt: null, tlsMode: 'terminate',
    });
    await databasePublicAccess(client as never, '4');
    expect(out()).toContain('none');
    expect(out()).not.toContain(':15432');
  });

  it('enables with merged values and warns about root credentials', async () => {
    const client = makeClient();
    client.databases.publicAccess.get.mockResolvedValue({ ...STATUS, enabled: false, tlsHostname: 'db.example.com' });
    client.databases.publicAccess.set.mockResolvedValue(STATUS);
    await databasePublicAccess(client as never, '4', { enable: true, allow: [' 198.51.100.0/24 ', ''] });
    expect(client.databases.publicAccess.set).toHaveBeenCalledWith(4, {
      enabled: true, port: 15432, ipAllowlist: ['198.51.100.0/24'], tlsMode: 'none', tlsHostname: 'db.example.com',
    });
    expect(out()).toContain('ROOT credentials');
    expect(out()).toContain('Public access enabled');
  });

  it('updates an enabled one with an explicit port, TLS and host', async () => {
    const client = makeClient();
    client.databases.publicAccess.get.mockResolvedValue(STATUS);
    client.databases.publicAccess.set.mockResolvedValue(STATUS);
    await databasePublicAccess(client as never, '4', { enable: true, port: '16000', tls: 'terminate', tlsHost: 'pg.example.com' });
    expect(client.databases.publicAccess.set).toHaveBeenCalledWith(4, {
      enabled: true, port: 16000, ipAllowlist: ['203.0.113.0/24'], tlsMode: 'terminate', tlsHostname: 'pg.example.com',
    });
    expect(out()).toContain('Public access updated');
  });

  it('refuses bad input before calling the server', async () => {
    const client = makeClient();
    client.databases.publicAccess.get.mockResolvedValue({ ...STATUS, port: null, ipAllowlist: [] });
    await databasePublicAccess(client as never, 'x');
    expect(err()).toContain('Usage: ninedeploy databases public-access');
    await databasePublicAccess(client as never, '4', { enable: true, disable: true });
    expect(err()).toContain('cannot be combined');
    await databasePublicAccess(client as never, '4', { disable: true, port: '1' });
    expect(err()).toContain('--disable takes no other options');
    await databasePublicAccess(client as never, '4', { port: '16000' });
    expect(err()).toContain('Pass --enable');
    await databasePublicAccess(client as never, '4', { enable: true, port: '443' });
    expect(err()).toContain('between 1024 and 65535');
    await databasePublicAccess(client as never, '4', { enable: true, port: 'abc' });
    await databasePublicAccess(client as never, '4', { enable: true });
    expect(err()).toContain('A port is required');
    await databasePublicAccess(client as never, '4', { enable: true, port: '16000' });
    expect(err()).toContain('At least one allow-list entry');
    await databasePublicAccess(client as never, '4', { enable: true, port: '16000', allow: ['1.2.3.4'], tls: 'full' });
    expect(err()).toContain('--tls must be');
    expect(client.databases.publicAccess.set).not.toHaveBeenCalled();
  });

  it('disables, and reports server errors on every path', async () => {
    const client = makeClient();
    client.databases.publicAccess.disable.mockResolvedValue({ ok: true });
    await databasePublicAccess(client as never, '4', { disable: true });
    expect(out()).toContain('Public access disabled');
    client.databases.publicAccess.disable.mockRejectedValue(new Error('Forbidden'));
    await databasePublicAccess(client as never, '4', { disable: true });
    expect(err()).toContain('Forbidden');
    client.databases.publicAccess.get.mockRejectedValue(new Error(`nope${ESC}[2J`));
    await databasePublicAccess(client as never, '4');
    await databasePublicAccess(client as never, '4', { enable: true });
    expect(err()).toContain('nope');
    expect(err()).not.toContain(`${ESC}[2J`);
    client.databases.publicAccess.get.mockResolvedValue(STATUS);
    client.databases.publicAccess.set.mockRejectedValue('port in use');
    await databasePublicAccess(client as never, '4', { enable: true });
    expect(err()).toContain('port in use');
  });
});

describe('databases import', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nd-import-'));
    file = path.join(dir, 'dump.sql');
    writeFileSync(file, '0123456789');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds only the option keys the user set', () => {
    expect(importOptionsFrom({ singleTransaction: true, safetyBackup: true, wait: true })).toEqual({});
    expect(importOptionsFrom({ clean: true, singleTransaction: false, drop: true, confirmReplace: true, safetyBackup: false })).toEqual({
      clean: true, singleTransaction: false, drop: true, confirmReplace: true, skipSafetyBackup: true,
    });
  });

  it('streams the file from the requested offset, reports progress, and waits for the result', async () => {
    const client = makeClient();
    let streamed = '';
    client.databases.importFile.mockImplementation(async (_id: number, factory: (o: number) => AsyncIterable<Buffer>, opts: Record<string, any>) => {
      opts.onCreated({ ...ROW, status: 'uploading' });
      for await (const piece of factory(4)) streamed += piece.toString();
      opts.onProgress({ receivedBytes: 4, sizeBytes: 10, row: ROW });
      opts.onProgress({ receivedBytes: 5, sizeBytes: 10, row: ROW });
      opts.onProgress({ receivedBytes: 10, sizeBytes: 10, row: ROW });
      return { ...ROW, status: 'running' };
    });
    client.databases.imports.wait.mockResolvedValue(ROW);
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    await databaseImport(client as never, '4', { file, clean: true, singleTransaction: true, safetyBackup: true, wait: true });
    expect(streamed).toBe('456789');
    const [, , opts] = client.databases.importFile.mock.calls[0]!;
    expect(opts).toMatchObject({ sizeBytes: 10, filename: 'dump.sql', options: { clean: true } });
    expect(opts.resumeImportId).toBeUndefined();
    expect(out()).toContain('--resume 9');
    // Non-TTY: one line per decile (40%, 50%, 100%).
    expect(stderr().split('\n').filter(Boolean)).toHaveLength(3);
    expect(client.databases.imports.wait).toHaveBeenCalledWith(4, 9);
    expect(out()).toContain('Import #9 completed (pg_custom)');
    expect(out()).toContain('ninedeploy backups restore 4 31');
  });

  it('resumes, rewrites progress in place on a TTY, and returns early with --no-wait', async () => {
    const client = makeClient();
    client.databases.importFile.mockImplementation(async (_id: number, _f: unknown, opts: Record<string, any>) => {
      opts.onProgress({ receivedBytes: 4, sizeBytes: 10, row: ROW });
      opts.onProgress({ receivedBytes: 10, sizeBytes: 10, row: ROW });
      return { ...ROW, status: 'running', safetyBackupId: null };
    });
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    await databaseImport(client as never, '4', { file, resume: '9', drop: true, wait: false });
    expect(client.databases.importFile.mock.calls[0]![2]).toMatchObject({ resumeImportId: 9 });
    expect(out()).toContain('flags are ignored on --resume');
    expect(stderr()).toContain('\r  Uploading 40%');
    expect(stderr()).toMatch(/100%.*\n$/);
    expect(client.databases.imports.wait).not.toHaveBeenCalled();
    expect(out()).toContain('databases imports 4 --watch');
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
  });

  it('reports every final status', async () => {
    const client = makeClient();
    for (const [status, error, format] of [
      ['completed', null, null],
      ['completed_with_warnings', `the import changed credentials${ESC}[2J`, null],
      ['completed_with_warnings', null, null],
      ['failed', 'syntax error at line 3', 'pg_plain'],
      ['cancelled', null, null],
    ] as const) {
      client.databases.importFile.mockResolvedValueOnce({ ...ROW, status: 'running' });
      client.databases.imports.wait.mockResolvedValueOnce({ ...ROW, status, error, format, safetyBackupId: null });
      await databaseImport(client as never, '4', { file, resume: '9' });
    }
    expect(out()).toContain('Import #9 completed');
    expect(out()).toContain('completed with warnings: the import changed credentials');
    expect(out()).not.toContain(`${ESC}[2J`);
    expect(err()).toContain('Import #9 failed: syntax error at line 3');
    expect(err()).toContain('Import #9 cancelled');
    expect(process.exitCode).toBe(1);
  });

  it('refuses bad arguments and unreadable files', async () => {
    const client = makeClient();
    await databaseImport(client as never, '0', { file });
    expect(err()).toContain('Usage: ninedeploy databases import');
    await databaseImport(client as never, '4', {});
    await databaseImport(client as never, '4', { file, fromS3: '2' });
    expect(err()).toContain('Pass exactly one of --file or --from-s3');
    await databaseImport(client as never, '4', { file: dir });
    expect(err()).toContain('is not a regular file');
    await databaseImport(client as never, '4', { file: path.join(dir, 'missing.sql') });
    expect(err()).toContain('Cannot read');
    const empty = path.join(dir, 'empty.sql');
    writeFileSync(empty, '');
    await databaseImport(client as never, '4', { file: empty });
    expect(err()).toContain('is empty');
    await databaseImport(client as never, '4', { file, resume: 'abc' });
    expect(err()).toContain('--resume takes an import id');
    expect(client.databases.importFile).not.toHaveBeenCalled();
    client.databases.importFile.mockRejectedValue(new Error('The import is failed; chunks are accepted only while it is uploading'));
    await databaseImport(client as never, '4', { file });
    expect(err()).toContain('chunks are accepted only while it is uploading');
  });

  it('imports from a backup destination: download, start, wait', async () => {
    const client = makeClient();
    client.databases.imports.create.mockResolvedValue({ ...ROW, source: 's3', status: 'uploading', objectKey: 'db/x.dump' });
    client.databases.imports.wait.mockResolvedValueOnce({ ...ROW, status: 'pending' }).mockResolvedValueOnce(ROW);
    client.databases.imports.start.mockResolvedValue({ ...ROW, status: 'running' });
    await databaseImport(client as never, '4', { fromS3: '2', key: ' db/x.dump ', confirmReplace: true });
    expect(client.databases.imports.create).toHaveBeenCalledWith(4, { source: 's3', destinationId: 2, key: 'db/x.dump', options: { confirmReplace: true } });
    expect(client.databases.imports.wait).toHaveBeenNthCalledWith(1, 4, 9, { until: 'uploaded' });
    expect(client.databases.imports.start).toHaveBeenCalledWith(4, 9);
    expect(client.databases.imports.wait).toHaveBeenNthCalledWith(2, 4, 9);
    expect(out()).toContain('Import #9 completed');
  });

  it('S3: stops on a failed download, honours --no-wait, and validates its flags', async () => {
    const client = makeClient();
    client.databases.imports.create.mockResolvedValue({ ...ROW, source: 's3', status: 'uploading' });
    client.databases.imports.wait.mockResolvedValueOnce({ ...ROW, status: 'failed', error: 'object vanished', safetyBackupId: null });
    await databaseImport(client as never, '4', { fromS3: '2', key: 'k' });
    expect(err()).toContain('object vanished');
    expect(client.databases.imports.start).not.toHaveBeenCalled();

    client.databases.imports.wait.mockResolvedValueOnce({ ...ROW, status: 'pending' });
    client.databases.imports.start.mockResolvedValue({ ...ROW, status: 'running', safetyBackupId: null });
    await databaseImport(client as never, '4', { fromS3: '2', key: 'k', wait: false });
    expect(client.databases.imports.wait).toHaveBeenCalledTimes(2);
    expect(out()).toContain('is running');

    await databaseImport(client as never, '4', { fromS3: 'x', key: 'k' });
    expect(err()).toContain('--from-s3 takes a backup destination id');
    await databaseImport(client as never, '4', { fromS3: '2' });
    expect(err()).toContain('--key <objectKey> is required');
    await databaseImport(client as never, '4', { fromS3: '2', key: 'k', resume: '9' });
    expect(err()).toContain('--resume applies to --file uploads only');
    client.databases.imports.create.mockRejectedValue(new Error('Importing from a backup destination is limited to instance operators'));
    await databaseImport(client as never, '4', { fromS3: '2', key: 'k' });
    expect(err()).toContain('limited to instance operators');
  });
});

describe('databases imports', () => {
  it('lists imports with sanitised names and every status color', async () => {
    const client = makeClient();
    client.databases.imports.list.mockResolvedValue([
      { ...ROW, filename: `evil${ESC}[2J.sql` },
      { ...ROW, id: 8, status: 'failed', error: 'x'.repeat(200), format: null, safetyBackupId: null },
      { ...ROW, id: 7, source: 's3', objectKey: 'db/a.dump', status: 'completed_with_warnings' },
      { ...ROW, id: 6, status: 'uploading', receivedBytes: 4 },
      { ...ROW, id: 5, status: 'cancelled', filename: null, sizeBytes: 0 },
    ]);
    await databaseImports(client as never, '4');
    const text = out();
    expect(text).toContain('evil.sql');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).toContain('db/a.dump');
    expect(text).toContain('40%');
    expect(client.databases.imports.list).toHaveBeenCalledTimes(1);
  });

  it('shows an empty list, and errors', async () => {
    const client = makeClient();
    client.databases.imports.list.mockResolvedValue([]);
    await databaseImports(client as never, '4', { watch: true });
    expect(out()).toContain('No imports yet');
    await databaseImports(client as never, 'nope');
    expect(err()).toContain('Usage: ninedeploy databases imports <id>');
    client.databases.imports.list.mockRejectedValue(new Error('Database not found'));
    await databaseImports(client as never, '4');
    expect(err()).toContain('Database not found');
  });

  it('--watch re-polls until nothing is active, printing only changes', async () => {
    const client = makeClient();
    client.databases.imports.list
      .mockResolvedValueOnce([{ ...ROW, status: 'running' }])
      .mockResolvedValueOnce([{ ...ROW, status: 'running' }])
      .mockResolvedValueOnce([ROW]);
    await databaseImports(client as never, '4', { watch: true, intervalMs: 1 });
    expect(client.databases.imports.list).toHaveBeenCalledTimes(3);
    expect(logSpy.mock.calls.filter((c) => String(c[0]).includes('Imports for database #4'))).toHaveLength(2);
  });
});
