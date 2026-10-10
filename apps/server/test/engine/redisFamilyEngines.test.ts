/**
 * 0.15.6, KeyDB and Dragonfly: the two managed engines that speak the Redis
 * protocol. Engine configuration (image, flags, URI), the start argv, the
 * Web Studio, size / backup / restore / import / credential probe for each,
 * and the guarantee that redis and valkey keep their exact argv. Docker is
 * mocked; nothing is executed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  run: vi.fn(async (_cmd: string, _args: string[], _opts: unknown, _sink?: (line: string) => void) => undefined),
  capture: vi.fn<(...args: any[]) => Promise<string>>(async () => ''),
  sleep: vi.fn(async () => undefined),
  pull: vi.fn<(...args: any[]) => Promise<void>>(async () => undefined),
  ensure: vi.fn(async () => undefined),
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
vi.mock('../../src/lib/dockerPull.js', () => ({ pullDockerImage: h.pull, ensureDockerImage: h.ensure }));
vi.mock('../../src/config.js', () => ({ config: h.config }));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-redis-family-'));
h.config.paths.dataDir = tmp;
h.config.paths.backupsDir = tmp;

const {
  adoptRetainedVolume,
  backupDatabase,
  connectionString,
  databaseSize,
  defaultPort,
  DRAGONFLY_DEFAULT_VERSION,
  ENGINES,
  importDatabase,
  keydbDefaultTag,
  probeDatabaseCredentials,
  restoreDatabase,
  startDatabase,
  startDatabaseStudio,
  studioImageForEngine,
} = await import('../../src/engine/database.js');

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  h.run.mockImplementation(async () => undefined);
  h.capture.mockResolvedValue('');
  h.pull.mockResolvedValue(undefined);
});

const COMMANDER = 'rediscommander/redis-commander@sha256:19cd0c49f418779fa2822a0496c5e6516d0c792effc39ed20089e6268477e40a';
const row = (engine: string, over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    name: 'db',
    slug: 'db',
    engine,
    version: null,
    status: 'running',
    containerName: 'nd-db-x',
    volumeName: 'nd-db-x-data',
    internalHost: 'nd-db-x',
    internalPort: null,
    passwordEncrypted: 'enc',
    cpuShares: 0,
    cpuLimitMilli: 0,
    memLimitMb: 0,
    ownerUserId: 1,
    ...over,
  }) as never;
const dockerCalls = () => h.run.mock.calls.map((c) => c[1] as string[]);
/** `docker cp <container>:<dump> <host file>` lands the dump on the host. */
const landDumpOnCp = (saveReply = 'OK') =>
  h.run.mockImplementation(async (_c: string, args: string[], _o: unknown, sink?: (line: string) => void) => {
    if (args.includes('SAVE')) sink?.(saveReply);
    if (args[0] === 'cp') writeFileSync(args[2]!, 'REDIS0012');
  });

describe('the engine configs', () => {
  it('keydb: arch-specific pinned tag, redis port, password as a command argument, redis:// URI', () => {
    const cfg = ENGINES['keydb']!;
    expect(cfg.image()).toBe(`eqalpha/keydb:${keydbDefaultTag()}`);
    expect(cfg.image('x86_64_v6.3.4')).toBe('eqalpha/keydb:x86_64_v6.3.4');
    expect(cfg.image('arm64_v6.3.4')).toBe('eqalpha/keydb:arm64_v6.3.4');
    expect(cfg.image()).not.toMatch(/latest/);
    expect(cfg.port).toBe(6379);
    expect(cfg.volumePath).toBe('/data');
    expect(cfg.env('p')).toEqual({});
    expect(cfg.authViaArg).toBe(true);
    expect(cfg.extraArgs).toEqual(['--dir', '/data']);
    expect(cfg.username()).toBeUndefined();
    expect(cfg.dbName()).toBeUndefined();
    expect(cfg.connectionString('h', 6379, '', 'p@ss:w', undefined)).toBe('redis://:p%40ss%3Aw@h:6379');
    expect(connectionString(row('keydb', { internalHost: 'kdb', internalPort: 6379 }))).toBe('redis://:pw%3Aenc@kdb:6379');
    expect(defaultPort('keydb')).toBe(6379);
  });

  it('keydbDefaultTag follows the CPU architecture', () => {
    expect(keydbDefaultTag('x64')).toBe('x86_64_v6.3.4');
    expect(keydbDefaultTag('arm64')).toBe('arm64_v6.3.4');
    expect(keydbDefaultTag()).toBe(process.arch === 'arm64' ? 'arm64_v6.3.4' : 'x86_64_v6.3.4');
  });

  it('dragonfly: pinned ghcr.io tag, redis port, RDB snapshot flags, redis:// URI', () => {
    const cfg = ENGINES['dragonfly']!;
    expect(DRAGONFLY_DEFAULT_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(cfg.image()).toBe(`ghcr.io/dragonflydb/dragonfly:${DRAGONFLY_DEFAULT_VERSION}`);
    expect(cfg.image('v1.30.0')).toBe('ghcr.io/dragonflydb/dragonfly:v1.30.0');
    expect(cfg.image()).not.toMatch(/latest/);
    expect(cfg.port).toBe(6379);
    expect(cfg.volumePath).toBe('/data');
    expect(cfg.env('p')).toEqual({});
    expect(cfg.authViaArg).toBe(true);
    // The snapshot IS /data/dump.rdb: the file every redis-family backup and restore moves.
    expect(cfg.extraArgs).toEqual(['--logtostderr', '--dir=/data', '--dbfilename=dump', '--df_snapshot_format=false', '--snapshot_cron=*/15 * * * *']);
    expect(cfg.username()).toBeUndefined();
    expect(cfg.dbName()).toBeUndefined();
    expect(connectionString(row('dragonfly', { internalHost: 'dfly', internalPort: 6379 }))).toBe('redis://:pw%3Aenc@dfly:6379');
    expect(defaultPort('dragonfly')).toBe(6379);
  });

  it('redis and valkey have no extra arguments (their start argv is unchanged)', () => {
    expect(ENGINES['redis']!.extraArgs).toBeUndefined();
    expect(ENGINES['valkey']!.extraArgs).toBeUndefined();
    expect(ENGINES['redis']!.image('8')).toBe('redis:8');
    expect(connectionString(row('redis', { internalHost: 'r', internalPort: 6379 }))).toBe('redis://:pw%3Aenc@r:6379');
    expect(connectionString(row('valkey', { internalHost: 'v', internalPort: 6379 }))).toBe('valkey://:pw%3Aenc@v:6379');
  });
});

describe('startDatabase', () => {
  it('keydb: --requirepass after the image, then --dir /data; no env file', async () => {
    h.capture.mockResolvedValue('No such volume');
    const log = vi.fn();
    await startDatabase(row('keydb', { version: 'x86_64_v6.3.4' }), log);
    expect(h.pull).toHaveBeenCalledTimes(1);
    expect(h.pull).toHaveBeenCalledWith('eqalpha/keydb:x86_64_v6.3.4', log);
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      ['run', '-d', '--name', 'nd-db-x', '--network', 'ninedeploy', '--restart', 'unless-stopped', '-v', 'nd-db-x-data:/data', 'eqalpha/keydb:x86_64_v6.3.4', '--requirepass', 'pw:enc', '--dir', '/data'],
      {},
      log,
    );
  });

  it('dragonfly: --requirepass then the snapshot flags; only its own image is pulled', async () => {
    h.capture.mockResolvedValue('No such volume');
    const log = vi.fn();
    await startDatabase(row('dragonfly'), log);
    expect(h.pull.mock.calls.map((c) => c[0])).toEqual([`ghcr.io/dragonflydb/dragonfly:${DRAGONFLY_DEFAULT_VERSION}`]);
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      [
        'run', '-d', '--name', 'nd-db-x', '--network', 'ninedeploy', '--restart', 'unless-stopped', '-v', 'nd-db-x-data:/data',
        `ghcr.io/dragonflydb/dragonfly:${DRAGONFLY_DEFAULT_VERSION}`,
        '--requirepass', 'pw:enc',
        '--logtostderr', '--dir=/data', '--dbfilename=dump', '--df_snapshot_format=false', '--snapshot_cron=*/15 * * * *',
      ],
      {},
      log,
    );
  });

  it('keydb pulls only its own image; redis stays byte-identical', async () => {
    h.capture.mockResolvedValue('No such volume');
    await startDatabase(row('keydb'), vi.fn());
    expect(h.pull.mock.calls.map((c) => c[0])).toEqual([`eqalpha/keydb:${keydbDefaultTag()}`]);
    h.run.mockClear();
    await startDatabase(row('redis', { version: '8' }), vi.fn());
    expect(dockerCalls().at(-1)).toEqual(['run', '-d', '--name', 'nd-db-x', '--network', 'ninedeploy', '--restart', 'unless-stopped', '-v', 'nd-db-x-data:/data', 'redis:8', '--requirepass', 'pw:enc']);
  });

  it('a retained volume of either engine needs no re-key (the credentials live on the container)', async () => {
    for (const engine of ['keydb', 'dragonfly']) {
      h.capture.mockImplementation(async (_c: string, args: string[]) => (args.includes('--format') ? JSON.stringify({ 'ninedeploy.database.engine': engine }) : '[{"Name":"v"}]'));
      expect(await adoptRetainedVolume(row(engine), vi.fn())).toEqual({ action: 'no-rekey-needed' });
    }
  });
});

describe('Web Studio (Redis Commander)', () => {
  it('serves keydb and dragonfly through Redis Commander, not Adminer', async () => {
    expect(studioImageForEngine('keydb')).toEqual({ image: COMMANDER, containerPort: 8081 });
    expect(studioImageForEngine('dragonfly')).toEqual({ image: COMMANDER, containerPort: 8081 });
    expect(studioImageForEngine('postgres').image).toBe('adminer:6.0.1');
    for (const engine of ['keydb', 'dragonfly']) {
      h.run.mockClear();
      h.capture.mockResolvedValueOnce('exited');
      await startDatabaseStudio(row(engine, { slug: `s-${engine}`, passwordEncrypted: 'v0:sekr3t' }), 18010, vi.fn());
      expect(dockerCalls()[1]).toEqual(expect.arrayContaining(['-p', '127.0.0.1:18010:8081', '-e', 'REDIS_URL=redis://default:pw%3Av0%3Asekr3t@nd-db-x:6379/0']));
    }
  });
});

describe('size, probe, backup, restore and import', () => {
  it('keydb: the commands run in the database container through keydb-cli', async () => {
    h.capture.mockResolvedValueOnce('used_memory:2048');
    expect(await databaseSize(row('keydb'))).toBe(2048);
    expect(h.capture.mock.calls[0]![1]).toEqual(['exec', 'nd-db-x', 'keydb-cli', '-a', 'pw:enc', '--no-auth-warning', 'INFO', 'memory']);

    h.capture.mockResolvedValueOnce('PONG');
    expect(await probeDatabaseCredentials(row('keydb'), 1, 0)).toBe(true);
    expect(h.capture.mock.calls[1]![1]).toEqual(['exec', 'nd-db-x', 'keydb-cli', '-a', 'pw:enc', '--no-auth-warning', 'PING']);

    const file = path.join(tmp, 'keydb.dump');
    landDumpOnCp();
    await backupDatabase(row('keydb'), file, vi.fn());
    expect(dockerCalls()).toEqual([
      ['exec', 'nd-db-x', 'keydb-cli', '-a', 'pw:enc', '--no-auth-warning', 'SAVE'],
      ['cp', 'nd-db-x:/data/dump.rdb', file],
    ]);
  });

  it('dragonfly: the commands run in the database container through its own redis-cli, with the engine-specific SAVE RDB', async () => {
    const cli = (...cmd: string[]) => ['exec', 'nd-db-x', 'redis-cli', '-a', 'pw:enc', '--no-auth-warning', ...cmd];
    h.capture.mockResolvedValueOnce('used_memory:4096');
    expect(await databaseSize(row('dragonfly'))).toBe(4096);
    expect(h.capture.mock.calls[0]![1]).toEqual(cli('INFO', 'memory'));

    h.capture.mockResolvedValueOnce('PONG');
    expect(await probeDatabaseCredentials(row('dragonfly'), 1, 0)).toBe(true);
    expect(h.capture.mock.calls[1]![1]).toEqual(cli('PING'));

    const file = path.join(tmp, 'dragonfly.dump');
    landDumpOnCp();
    await backupDatabase(row('dragonfly'), file, vi.fn());
    expect(dockerCalls()).toEqual([cli('SAVE', 'RDB'), ['cp', 'nd-db-x:/data/dump.rdb', file]]);
  });

  it.each(['keydb', 'dragonfly'])('%s: a SAVE that answers an error is a failed backup, not a stale copy of dump.rdb', async (engine) => {
    const file = path.join(tmp, `${engine}-stale.dump`);
    landDumpOnCp('(error) ERR Background save already in progress');
    await expect(backupDatabase(row(engine), file, vi.fn())).rejects.toThrow('SAVE did not answer OK: (error) ERR Background save already in progress');
    // Nothing was copied out of the container.
    expect(dockerCalls().some((a) => a[0] === 'cp')).toBe(false);
    const { existsSync } = await import('node:fs');
    expect(existsSync(file)).toBe(false);
  });

  it('redis and valkey keep their unchecked SAVE: the reply is only logged', async () => {
    for (const engine of ['redis', 'valkey']) {
      h.run.mockClear();
      const file = path.join(tmp, `${engine}-unchecked.dump`);
      landDumpOnCp('(error) ERR whatever');
      await backupDatabase(row(engine), file, vi.fn());
      expect(dockerCalls()).toEqual([
        ['exec', 'nd-db-x', 'redis-cli', '-a', 'pw:enc', '--no-auth-warning', 'SAVE'],
        ['cp', 'nd-db-x:/data/dump.rdb', file],
      ]);
    }
  });

  it('a failed dragonfly backup leaves no file behind', async () => {
    const file = path.join(tmp, 'failed.dump');
    h.run.mockImplementationOnce(async () => {
      writeFileSync(file, 'partial');
      throw new Error('ERR snapshot failed');
    });
    await expect(backupDatabase(row('dragonfly'), file, vi.fn())).rejects.toThrow('ERR snapshot failed');
    const { existsSync } = await import('node:fs');
    expect(existsSync(file)).toBe(false);
  });

  it.each(['keydb', 'dragonfly'])('%s: restore stops first, copies over dump.rdb, and always starts again', async (engine) => {
    const file = path.join(tmp, `${engine}-restore.dump`);
    writeFileSync(file, 'REDIS0012-bytes');
    await restoreDatabase(row(engine), file, vi.fn());
    expect(dockerCalls()).toEqual([['stop', 'nd-db-x'], ['cp', file, 'nd-db-x:/data/dump.rdb'], ['start', 'nd-db-x']]);

    h.run.mockClear();
    h.run.mockImplementation(async (_c: string, args: string[]) => {
      if (args[0] === 'cp') throw new Error('copy failed');
    });
    await expect(restoreDatabase(row(engine), file, vi.fn())).rejects.toThrow('copy failed');
    expect(dockerCalls().map((a) => a[0])).toEqual(['stop', 'cp', 'start']);
  });

  it.each(['keydb', 'dragonfly'])('%s: an RDB import is stop / copy / start, and a wrong format is refused', async (engine) => {
    await importDatabase(row(engine), '/host/in.rdb', { format: 'rdb' }, vi.fn());
    expect(dockerCalls()).toEqual([['stop', 'nd-db-x'], ['cp', '/host/in.rdb', 'nd-db-x:/data/dump.rdb'], ['start', 'nd-db-x']]);
    await expect(importDatabase(row(engine), '/host/in.sql', { format: 'pg_plain' }, vi.fn())).rejects.toThrow(/not supported for/);
  });

  it('dragonfly: a probe against a container that is not accepting commands is retried, then false', async () => {
    h.capture.mockRejectedValue(new Error('Error response from daemon: container is not running'));
    expect(await probeDatabaseCredentials(row('dragonfly'), 2, 0)).toBe(false);
    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });
});
