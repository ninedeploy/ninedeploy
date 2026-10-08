/**
 * 0.14 dump import, engine side: the argv per engine (sandbox flag present
 * and absent, mongo nsExclude, psql ON_ERROR_STOP + forced
 * standard_conforming_strings), the safety backup running first under the
 * same lock, the redis stop/copy/start sequence, the sandbox-flag probe and
 * the post-import credential probe. Docker is mocked; nothing is executed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  run: vi.fn(async (_cmd: string, _args: string[], _opts: unknown, _sink?: (line: string) => void) => undefined),
  capture: vi.fn<(...args: any[]) => Promise<string>>(async () => ''),
  sleep: vi.fn(async () => undefined),
  config: { paths: { dataDir: '', backupsDir: '' } },
}));

vi.mock('../../src/lib/crypto.js', async () => {
  const { PassThrough } = await import('node:stream');
  return {
    decrypt: (v: string) => `pw:${v}`,
    encrypt: (v: string) => `v0:${v}`,
    createBackupCipher: () => {
      const cipher = new PassThrough() as InstanceType<typeof PassThrough> & { getAuthTag: () => Buffer };
      cipher.getAuthTag = () => Buffer.alloc(16, 7);
      return { cipher, header: Buffer.from('NDBK1:v0:AAAAAAAAAAAAAAAA\n') };
    },
    createBackupDecipher: () => new PassThrough(),
  };
});
vi.mock('../../src/lib/exec.js', () => ({ run: h.run, capture: h.capture, sleep: h.sleep }));
vi.mock('../../src/lib/dockerPull.js', () => ({ pullDockerImage: vi.fn(), ensureDockerImage: vi.fn() }));
vi.mock('../../src/config.js', () => ({ config: h.config }));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-import-engine-'));
h.config.paths.dataDir = tmp;
h.config.paths.backupsDir = tmp;

const { IMPORT_TIMEOUT_MS, PSQL_IMPORT_PGOPTIONS, importCommand, importDatabase, probeDatabaseCredentials, probeMysqlSandboxFlag } =
  await import('../../src/engine/database.js');

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  h.run.mockImplementation(async () => undefined);
  h.capture.mockResolvedValue('');
});

const db = (over: Record<string, unknown> = {}) =>
  ({ id: 1, name: 'db', slug: 'db', engine: 'postgres', version: null, containerName: 'nd-db-x', passwordEncrypted: 'enc', ...over }) as never;

describe('importCommand (argv per engine)', () => {
  it('postgres custom format: pg_restore without owners or ACLs, stopping on the first error', () => {
    expect(importCommand('postgres', 'c', '/tmp/f', { format: 'pg_custom', singleTransaction: true, clean: true }, 'pw')).toEqual([
      'exec', 'c', 'pg_restore', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--clean', '--if-exists',
      '-U', 'nine', '-d', 'app', '/tmp/f',
    ]);
    expect(importCommand('postgres', 'c', '/tmp/f', { format: 'pg_custom' }, 'pw')).not.toContain('--single-transaction');
  });

  it('postgres plain SQL: psql with ON_ERROR_STOP and standard_conforming_strings forced on', () => {
    const argv = importCommand('postgres', 'c', '/tmp/f', { format: 'pg_plain', singleTransaction: true }, 'pw');
    expect(argv).toEqual([
      'exec', '-e', PSQL_IMPORT_PGOPTIONS, 'c', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-U', 'nine', '-d', 'app', '-f', '/tmp/f',
    ]);
    expect(PSQL_IMPORT_PGOPTIONS).toBe('PGOPTIONS=-c standard_conforming_strings=on');
    expect(importCommand('postgres', 'c', '/tmp/f', { format: 'pg_plain', singleTransaction: false }, 'pw')).not.toContain('--single-transaction');
  });

  it('mysql/mariadb: stdin through a positional sh -c, with the sandbox flag when there is one', () => {
    const mysql = importCommand('mysql', 'c', '/tmp/f', { format: 'mysql_sql', sandboxFlag: '--system-command=OFF' }, 'p$w');
    expect(mysql).toEqual([
      'exec', 'c', 'sh', '-c', 'f="$1"; shift; exec "$@" < "$f"', 'sh', '/tmp/f',
      'mysql', '-uroot', '--password=p$w', '--system-command=OFF', '--local-infile=0', 'app',
    ]);
    const maria = importCommand('mariadb', 'c', '/tmp/f', { format: 'mysql_sql', sandboxFlag: '--sandbox' }, 'pw');
    expect(maria.slice(7)).toEqual(['mariadb', '-uroot', '--password=pw', '--sandbox', '--local-infile=0', 'app']);
    // No flag (operator only — enforced by the caller): nothing in its place.
    expect(importCommand('mariadb', 'c', '/tmp/f', { format: 'mysql_sql', sandboxFlag: null }, 'pw').slice(7)).toEqual([
      'mariadb', '-uroot', '--password=pw', '--local-infile=0', 'app',
    ]);
    // The script interpolates nothing: the password is never inside it.
    expect(mysql[4]).not.toContain('p$w');
  });

  it('mongo: mongorestore excluding admin, config and local', () => {
    expect(importCommand('mongo', 'c', '/tmp/f', { format: 'mongo_archive', gzip: true, drop: true }, 'pw')).toEqual([
      'exec', 'c', 'mongorestore', '-u', 'nine', '-p', 'pw', '--authenticationDatabase', 'admin', '--archive=/tmp/f',
      '--gzip', '--drop', '--nsExclude=admin.*', '--nsExclude=config.*', '--nsExclude=local.*',
    ]);
    const plain = importCommand('mongo', 'c', '/tmp/f', { format: 'mongo_archive' }, 'pw');
    expect(plain).not.toContain('--gzip');
    expect(plain).not.toContain('--drop');
  });

  it('refuses a format the engine cannot take', () => {
    expect(() => importCommand('mysql', 'c', '/tmp/f', { format: 'pg_custom' }, 'pw')).toThrow(/not supported for mysql/);
    expect(() => importCommand('clickhouse', 'c', '/tmp/f', { format: 'pg_plain' }, 'pw')).toThrow(/not supported/);
  });
});

describe('importDatabase', () => {
  it('takes the safety backup first, under the same lock, then copies, runs and cleans up', async () => {
    const order: string[] = [];
    h.run.mockImplementation(async (_c: string, args: string[]) => {
      order.push(args.slice(0, 3).join(' '));
      // `docker cp <container>:<dump> <host file>` lands the safety dump.
      if (args[0] === 'cp' && args[2]!.endsWith('pre.dump')) writeFileSync(args[2]!, 'dump');
    });
    const onDone = vi.fn(async () => {
      order.push('safety-done');
    });
    await importDatabase(db(), '/host/dump.sql', {
      format: 'pg_plain',
      singleTransaction: true,
      safetyBackup: { file: path.join(tmp, 'pre.dump'), onDone, onFailed: vi.fn() },
    }, () => undefined);
    expect(order[0]).toBe('exec nd-db-x pg_dump');
    expect(order.indexOf('safety-done')).toBeLessThan(order.findIndex((s) => s.startsWith('cp /host/dump.sql')));
    expect(order.at(-2)).toBe(`exec -e ${PSQL_IMPORT_PGOPTIONS}`);
    expect(order.at(-1)).toBe('exec nd-db-x rm');
    const psql = h.run.mock.calls.find((c) => (c[1] as string[]).includes('psql'));
    expect((psql![2] as { timeoutMs: number }).timeoutMs).toBe(IMPORT_TIMEOUT_MS);
  });

  it('a failed safety backup records the failure and never imports', async () => {
    h.run.mockImplementation(async (_c: string, args: string[]) => {
      if (args.includes('pg_dump')) throw new Error('disk full');
    });
    const onFailed = vi.fn(async () => undefined);
    const onDone = vi.fn(async () => undefined);
    await expect(
      importDatabase(db(), '/host/dump.sql', { format: 'pg_plain', safetyBackup: { file: path.join(tmp, 'x.dump'), onDone, onFailed } }, () => undefined),
    ).rejects.toThrow('disk full');
    expect(onFailed).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(h.run.mock.calls.some((c) => (c[1] as string[]).includes('psql'))).toBe(false);
  });

  it('redis/valkey: stop, copy over dump.rdb, and always start again', async () => {
    h.run.mockImplementation(async (_c: string, args: string[]) => {
      if (args[0] === 'cp') throw new Error('copy failed');
    });
    await expect(importDatabase(db({ engine: 'valkey' }), '/host/x.rdb', { format: 'rdb' }, () => undefined)).rejects.toThrow('copy failed');
    expect(h.run.mock.calls.map((c) => (c[1] as string[])[0])).toEqual(['stop', 'cp', 'start']);
    expect(h.run.mock.calls[1]![1]).toEqual(['cp', '/host/x.rdb', 'nd-db-x:/data/dump.rdb']);
  });

  it('refuses rdb for a non-redis engine and a database with no container', async () => {
    await expect(importDatabase(db(), '/x', { format: 'rdb' }, () => undefined)).rejects.toThrow(/not supported for postgres/);
    await expect(importDatabase(db({ containerName: null }), '/x', { format: 'pg_plain' }, () => undefined)).rejects.toThrow(/not runnable/);
  });

  it('still removes the in-container copy when the restore tool fails', async () => {
    h.run.mockImplementation(async (_c: string, args: string[]) => {
      if (args.includes('mongorestore')) throw new Error('bad archive');
    });
    const log = vi.fn();
    await expect(importDatabase(db({ engine: 'mongo' }), '/x', { format: 'mongo_archive' }, log)).rejects.toThrow('bad archive');
    expect(h.run.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(['rm', '-f']));
  });
});

describe('probeMysqlSandboxFlag', () => {
  it('finds mariadb --sandbox and mysql --system-command in --help', async () => {
    h.capture.mockResolvedValueOnce('  --sandbox          Disallow commands that access the file system\n');
    expect(await probeMysqlSandboxFlag(db({ engine: 'mariadb' }))).toBe('--sandbox');
    expect(h.capture.mock.calls[0]![1]).toEqual(['exec', 'nd-db-x', 'mariadb', '--help']);
    h.capture.mockResolvedValueOnce('  --system-command   Enable (by default) or disable the system mysql command.\n');
    expect(await probeMysqlSandboxFlag(db({ engine: 'mysql' }))).toBe('--system-command=OFF');
  });

  it('is null when the client lacks the flag, the probe fails, or the engine is not mysql', async () => {
    h.capture.mockResolvedValueOnce('  --silent\n  --sandboxed-thing\n');
    expect(await probeMysqlSandboxFlag(db({ engine: 'mysql' }))).toBeNull();
    h.capture.mockRejectedValueOnce(new Error('no such container'));
    expect(await probeMysqlSandboxFlag(db({ engine: 'mariadb' }))).toBeNull();
    expect(await probeMysqlSandboxFlag(db({ engine: 'postgres' }))).toBeNull();
    expect(await probeMysqlSandboxFlag(db({ engine: 'mysql', containerName: null }))).toBeNull();
  });
});

describe('probeDatabaseCredentials', () => {
  it('signs in for real on every engine', async () => {
    h.capture.mockResolvedValueOnce('1\n');
    expect(await probeDatabaseCredentials(db(), 1, 0)).toBe(true);
    // postgres goes over TCP with the password: the local socket is trust.
    expect(h.capture.mock.calls[0]![1]).toEqual(expect.arrayContaining(['-e', 'PGPASSWORD=pw:enc', '-h', '127.0.0.1']));
    h.capture.mockResolvedValueOnce('1');
    expect(await probeDatabaseCredentials(db({ engine: 'mariadb' }), 1, 0)).toBe(true);
    h.capture.mockResolvedValueOnce('1');
    expect(await probeDatabaseCredentials(db({ engine: 'mongo' }), 1, 0)).toBe(true);
    h.capture.mockResolvedValueOnce('PONG');
    expect(await probeDatabaseCredentials(db({ engine: 'redis' }), 1, 0)).toBe(true);
  });

  it('retries, then reports changed credentials', async () => {
    h.capture.mockRejectedValueOnce(new Error('LOADING')).mockResolvedValueOnce('PONG');
    expect(await probeDatabaseCredentials(db({ engine: 'valkey' }), 3, 0)).toBe(true);
    expect(h.sleep).toHaveBeenCalledTimes(1);
    h.capture.mockResolvedValue('NOAUTH Authentication required.');
    expect(await probeDatabaseCredentials(db({ engine: 'redis' }), 2, 0)).toBe(false);
    expect(await probeDatabaseCredentials(db({ engine: 'clickhouse' }), 1, 0)).toBe(false);
    expect(await probeDatabaseCredentials(db({ containerName: null }), 1, 0)).toBe(false);
  });
});
