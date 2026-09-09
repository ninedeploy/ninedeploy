import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync as existsSyncMock, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptRetainedVolume,
  backupDatabase,
  connectionString,
  createBackupReadStream,
  createDockerVolume,
  databaseLogs,
  readBackupBytes,
  databaseSize,
  defaultPort,
  ENGINES,
  postgresMajor,
  removeVolume,
  resolveDataDir,
  resolveVolumePath,
  restartDatabase,
  restoreDatabase,
  startDatabase,
  stopDatabase,
  volumeExists,
} from '../src/engine/database.js';

const h = vi.hoisted(() => {
  // decrypt handles BOTH envelope round-trips (v0:… = real envelope shape)
  // and DB passwords (pw:… fallback).
  const decrypt = vi.fn((v: string) => (v.startsWith('v0:') ? v.slice(3) : `pw:${v}`));
  const encrypt = vi.fn((v: string) => `v0:${v}`);
  const run = vi.fn(async (_cmd: string, _args: unknown[], _opts: unknown, sink?: (line: string) => void) => {
    sink?.('');
  });
  const capture = vi.fn(async () => '[]');
  const pullDockerImage = vi.fn(async () => undefined);
  const ensureDockerImage = vi.fn(async () => undefined);
  const config: { paths: { dataDir: string } } = { paths: { dataDir: '/tmp/nd-db-test' } };
  return { decrypt, encrypt, run, capture, pullDockerImage, ensureDockerImage, config };
});

vi.mock('../src/lib/crypto.js', async () => {
  const { PassThrough } = await import('node:stream');
  return {
    decrypt: h.decrypt,
    encrypt: h.encrypt,
    createBackupCipher: () => {
      const cipher = new PassThrough() as PassThrough & { getAuthTag: () => Buffer };
      cipher.getAuthTag = () => Buffer.alloc(16, 7);
      return { cipher, header: Buffer.from('NDBK1:v0:AAAAAAAAAAAAAAAA\n') };
    },
    createBackupDecipher: () => new PassThrough(),
  };
});
vi.mock('../src/lib/exec.js', () => ({ run: h.run, capture: h.capture, sleep: vi.fn() }));
vi.mock('../src/lib/dockerPull.js', () => ({
  pullDockerImage: h.pullDockerImage,
  ensureDockerImage: h.ensureDockerImage,
}));
vi.mock('../src/config.js', () => ({ config: h.config }));

beforeEach(() => {
  vi.clearAllMocks();
  h.run.mockImplementation(async (_cmd: string, _args: unknown[], _opts: unknown, sink?: (line: string) => void) => {
    sink?.('');
  });
  h.capture.mockResolvedValue('[]');
  h.pullDockerImage.mockResolvedValue(undefined);
  h.ensureDockerImage.mockResolvedValue(undefined);
});

const dbRow = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    projectId: null,
    name: 'db',
    slug: 'db',
    engine: 'postgres',
    version: null,
    status: 'running',
    containerName: 'c',
    internalHost: null,
    internalPort: null,
    username: null,
    passwordEncrypted: 'enc',
    dbName: null,
    volumeName: 'v',
    cpuShares: 0,
    memLimitMb: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }) as never;

describe('ENGINES metadata', () => {
  it('maps each engine to image, port, volume and env', () => {
    expect(ENGINES.postgres.image()).toBe('postgres:18');
    expect(ENGINES.postgres.image('17')).toBe('postgres:17');
    expect(ENGINES.mysql.image()).toBe('mysql:9.7');
    expect(ENGINES.mysql.image('8.4')).toBe('mysql:8.4');
    expect(ENGINES.mariadb.image()).toBe('mariadb:12.3');
    expect(ENGINES.mariadb.image('11')).toBe('mariadb:11');
    expect(ENGINES.redis.image()).toBe('redis:8.8');
    expect(ENGINES.redis.image('7')).toBe('redis:7');
    expect(ENGINES.mongo.image()).toBe('mongo:8.0');
    expect(ENGINES.mongo.image('7.0')).toBe('mongo:7.0');

    expect(ENGINES.postgres.port).toBe(5432);
    expect(ENGINES.mysql.port).toBe(3306);
    expect(ENGINES.mariadb.port).toBe(3306);
    expect(ENGINES.redis.port).toBe(6379);
    expect(ENGINES.mongo.port).toBe(27017);

    // postgres 18+ moved the data directory under /var/lib/postgresql/<major>/docker
    // and REFUSES the classic /var/lib/postgresql/data mount (docker-library/postgres#1259):
    // mounting there crash-loops the container, its DNS name never registers and the
    // attached app dies with `getaddrinfo EAI_AGAIN` against the database hostname.
    expect(resolveVolumePath(ENGINES.postgres)).toBe('/var/lib/postgresql');
    expect(resolveVolumePath(ENGINES.postgres, '18')).toBe('/var/lib/postgresql');
    expect(resolveVolumePath(ENGINES.postgres, 'pgvector')).toBe('/var/lib/postgresql');
    expect(resolveDataDir(ENGINES.postgres)).toBe('/var/lib/postgresql/18/docker');
    expect(resolveDataDir(ENGINES.postgres, '19')).toBe('/var/lib/postgresql/19/docker');
    expect(resolveVolumePath(ENGINES.postgres, '17')).toBe('/var/lib/postgresql/data');
    expect(resolveDataDir(ENGINES.postgres, '17')).toBe('/var/lib/postgresql/data');
    expect(postgresMajor('vector')).toBe(18);
    expect(postgresMajor('17')).toBe(17);
    expect(postgresMajor(undefined)).toBe(18);
    expect(resolveVolumePath(ENGINES.mysql)).toBe('/var/lib/mysql');
    expect(resolveVolumePath(ENGINES.mariadb)).toBe('/var/lib/mysql');
    expect(resolveVolumePath(ENGINES.redis)).toBe('/data');
    expect(resolveVolumePath(ENGINES.mongo)).toBe('/data/db');

    expect(ENGINES.postgres.username()).toBe('nine');
    expect(ENGINES.mysql.username()).toBe('root');
    expect(ENGINES.mariadb.username()).toBe('root');
    expect(ENGINES.mongo.username()).toBe('nine');
    expect(ENGINES.redis.username()).toBeUndefined();
    expect(ENGINES.postgres.dbName()).toBe('app');
    expect(ENGINES.mysql.dbName()).toBe('app');
    expect(ENGINES.mariadb.dbName()).toBe('app');
    expect(ENGINES.redis.dbName()).toBeUndefined();
    expect(ENGINES.mongo.dbName()).toBeUndefined();

    expect(ENGINES.postgres.env('p')).toEqual({ POSTGRES_USER: 'nine', POSTGRES_PASSWORD: 'p', POSTGRES_DB: 'app' });
    expect(ENGINES.mysql.env('p')).toEqual({ MYSQL_ROOT_PASSWORD: 'p', MYSQL_DATABASE: 'app' });
    expect(ENGINES.mariadb.env('p')).toEqual({ MARIADB_ROOT_PASSWORD: 'p', MARIADB_DATABASE: 'app' });
    expect(ENGINES.redis.env('p')).toEqual({});
    expect(ENGINES.mongo.env('p')).toEqual({ MONGO_INITDB_ROOT_USERNAME: 'nine', MONGO_INITDB_ROOT_PASSWORD: 'p' });
    expect(ENGINES.redis.authViaArg).toBe(true);
    expect(ENGINES.valkey.authViaArg).toBe(true);
    expect(ENGINES.postgres.authViaArg).toBeUndefined();
  });

  it('renders mariadb connection strings', () => {
    expect(ENGINES.mariadb.connectionString('db', 3306, 'root', 'pw', undefined)).toBe('mariadb://root:pw@db:3306/app');
  });
});

describe('startDatabase', () => {
  it('starts postgres with volume bind and env flags, reusing a retained volume', async () => {
    h.capture.mockResolvedValue('[{"Name":"v"}]');
    const log = vi.fn();

    await startDatabase(dbRow({ engine: 'postgres', version: '16' }), log);

    expect(log).toHaveBeenCalledWith('Reusing retained volume v (previous data restored)');
    expect(h.pullDockerImage).toHaveBeenCalledWith('postgres:16', log);
    expect(log).toHaveBeenCalledWith('Starting postgres database db (c) …');
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      [
        'run', '-d', '--name', 'c', '--network', 'ninedeploy', '--restart', 'unless-stopped',
        '-v', 'v:/var/lib/postgresql/data',
        // Secrets ride in a 0600 env-file, not on the argv.
        '--env-file', expect.any(String),
        'postgres:16',
      ],
      {},
      log,
    );
  });

  it('mounts postgres 18+ volumes at /var/lib/postgresql (cluster layout, docker-library/postgres#1259)', async () => {
    h.capture.mockResolvedValue('[{"Name":"v"}]');
    const log = vi.fn();

    // dbRow defaults to version null → the 18 default major.
    await startDatabase(dbRow({ engine: 'postgres' }), log);

    const call = h.run.mock.calls.find((c) => (c[1] as string[])[0] === 'run');
    const argv = (call![1] as string[]).join(' ');
    expect(argv).toContain('-v v:/var/lib/postgresql ');
    expect(argv).not.toContain('/var/lib/postgresql/data');
    expect(argv).toContain('postgres:18');
  });

  it('is a no-op when the container is already running (idempotent restart)', async () => {
    // First capture call is the container-state inspect.
    h.capture.mockResolvedValueOnce('running');
    const log = vi.fn();

    await startDatabase(dbRow({ engine: 'postgres' }), log);

    expect(log).toHaveBeenCalledWith('c already running — reusing');
    expect(h.pullDockerImage).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('stops before mutating container state when database image preparation fails', async () => {
    h.capture.mockResolvedValueOnce('exited');
    h.pullDockerImage.mockRejectedValueOnce(new Error('snapshot recovery failed'));

    await expect(startDatabase(dbRow({ engine: 'mysql' }), vi.fn())).rejects.toThrow('snapshot recovery failed');

    expect(h.pullDockerImage).toHaveBeenCalledWith('mysql:9.7', expect.any(Function));
    expect(h.run).not.toHaveBeenCalled();
  });

  it('removes a stale same-name container before starting (no name conflict)', async () => {
    // Container not running, volume retained. The rm -f may fail if there was
    // nothing to remove — that's absorbed and we still proceed to start.
    h.capture.mockResolvedValue('[{"Name":"v"}]');
    h.run.mockRejectedValueOnce(new Error('no such container'));
    const log = vi.fn();

    await startDatabase(dbRow({ engine: 'postgres' }), log);

    expect(h.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'c'], {}, expect.any(Function));
  });

  it('still starts when the state inspect fails (treats it as not running)', async () => {
    h.capture.mockRejectedValue(new Error('inspect failed'));
    const log = vi.fn();

    await startDatabase(dbRow({ engine: 'postgres' }), log);

    expect(log).toHaveBeenCalledWith('Starting postgres database db (c) …');
    expect(h.run).toHaveBeenCalledWith('docker', expect.arrayContaining(['run', '-d', '--name', 'c']), {}, log);
  });

  it('adopts a container that is running after docker run reports code 125', async () => {
    h.capture
      .mockResolvedValueOnce('exited')
      .mockResolvedValueOnce('No such volume')
      .mockResolvedValueOnce('running');
    h.run.mockImplementation(async (_cmd: string, args: unknown[]) => {
      if ((args as string[])[0] === 'run') throw new Error('docker run exited with code 125');
    });
    const log = vi.fn();

    await expect(startDatabase(dbRow(), log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('c is running despite docker run failure — adopting it');
  });

  it('preserves a docker run failure when no container is running', async () => {
    h.capture.mockResolvedValue('exited');
    h.run.mockImplementation(async (_cmd: string, args: unknown[]) => {
      if ((args as string[])[0] === 'run') throw new Error('docker run exited with code 125');
    });

    await expect(startDatabase(dbRow(), vi.fn())).rejects.toThrow('docker run exited with code 125');
  });

  it('adds cpu/memory flags and defaults the mysql tag when no version is set', async () => {
    h.capture.mockResolvedValue('No such volume');
    const log = vi.fn();

    await startDatabase(
      dbRow({ engine: 'mysql', containerName: 'cm', volumeName: 'vm', cpuShares: 512, memLimitMb: 256 }),
      log,
    );

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Reusing retained volume'));
    expect(h.pullDockerImage).toHaveBeenCalledWith('mysql:9.7', log);
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      [
        'run', '-d', '--name', 'cm', '--network', 'ninedeploy', '--restart', 'unless-stopped',
        '--cpu-shares', '512', '--memory', '256m',
        '-v', 'vm:/var/lib/mysql',
        '--env-file', expect.any(String),
        'mysql:9.7',
      ],
      {},
      log,
    );
  });

  it('starts redis with a --requirepass argument (no env vars)', async () => {
    h.capture.mockResolvedValue('No such volume');
    const log = vi.fn();

    await startDatabase(dbRow({ engine: 'redis', version: '8' }), log);

    expect(h.run).toHaveBeenCalledWith(
      'docker',
      // Redis has no env vars → no --env-file; the password rides as the
      // container command's --requirepass argument so the shared network
      // cannot be reached without authenticating.
      ['run', '-d', '--name', 'c', '--network', 'ninedeploy', '--restart', 'unless-stopped', '-v', 'v:/data', '--requirepass', 'pw:enc', 'redis:8'],
      {},
      log,
    );
  });

  it('starts mongo with init root credentials', async () => {
    h.capture.mockResolvedValue('No such volume');
    const log = vi.fn();

    await startDatabase(dbRow({ engine: 'mongo' }), log);

    expect(h.run).toHaveBeenCalledWith(
      'docker',
      [
        'run', '-d', '--name', 'c', '--network', 'ninedeploy', '--restart', 'unless-stopped',
        '-v', 'v:/data/db',
        '--env-file', expect.any(String),
        'mongo:8.0',
      ],
      {},
      log,
    );
  });

  it('throws for an unknown engine', async () => {
    await expect(startDatabase(dbRow({ engine: 'oracle' }), vi.fn())).rejects.toThrow('Unknown engine: oracle');
  });

  it('throws when the container or volume name is missing', async () => {
    await expect(
      startDatabase(dbRow({ containerName: null, volumeName: null }), vi.fn()),
    ).rejects.toThrow('database has no container/volume name');
  });
});

describe('volumeExists', () => {
  it('returns true when docker reports the volume', async () => {
    h.capture.mockResolvedValue('[{"Name":"v"}]');
    await expect(volumeExists('v')).resolves.toBe(true);
  });

  it('returns false when docker says the volume does not exist', async () => {
    h.capture.mockResolvedValue('No such volume');
    await expect(volumeExists('v')).resolves.toBe(false);
  });

  it('returns false when the inspect command fails', async () => {
    h.capture.mockRejectedValue(new Error('docker down'));
    await expect(volumeExists('v')).resolves.toBe(false);
  });
});

describe('retained volume provenance + adoption', () => {
  const labels = (over: Record<string, string> = {}): Record<string, string> => ({
    'ninedeploy.managed': 'database',
    'ninedeploy.database.slug': 'db',
    'ninedeploy.database.name': 'Old DB',
    'ninedeploy.database.engine': 'postgres',
    'ninedeploy.database.image': 'postgres:16',
    ...over,
  });
  /** Route capture calls by shape: volumeExists (no --format) vs volumeLabels (--format). */
  const captureVolume = (exists: boolean, volumeLabelsJson: Record<string, string> = {}) => {
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--format')) return JSON.stringify(volumeLabelsJson);
      return exists ? '[{"Name":"v"}]' : 'No such volume';
    });
  };

  it('stamps provenance labels when startDatabase creates a fresh volume', async () => {
    h.capture.mockResolvedValue('No such volume');
    const log = vi.fn();

    await startDatabase(dbRow({ engine: 'postgres', version: '16', ownerUserId: 7 }), log);

    expect(h.run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'volume', 'create',
        '--label', 'ninedeploy.managed=database',
        '--label', 'ninedeploy.database.slug=db',
        '--label', 'ninedeploy.database.name=db',
        '--label', 'ninedeploy.database.engine=postgres',
        '--label', 'ninedeploy.database.image=postgres:16',
        '--label', 'ninedeploy.owner=7',
        'v',
      ]),
      {},
      log,
    );
  });

  it('passes caller labels (e.g. the provisioning template) through to the volume', async () => {
    h.capture.mockResolvedValue('No such volume');

    await startDatabase(dbRow({ engine: 'redis' }), vi.fn(), { labels: { 'ninedeploy.template': 'directus' } });

    const createCall = h.run.mock.calls.find((call) => (call[1] as string[])[0] === 'volume');
    expect(createCall).toBeDefined();
    const args = createCall![1] as string[];
    expect(args).toContain('ninedeploy.template=directus');
  });

  it('adoptRetainedVolume is a no-op when the volume does not exist', async () => {
    captureVolume(false);
    await expect(adoptRetainedVolume(dbRow(), vi.fn())).resolves.toEqual({ action: 'fresh' });
  });

  it('skips re-keying for engines that keep credentials outside the volume', async () => {
    captureVolume(true, labels({ 'ninedeploy.database.engine': 'redis' }));
    const log = vi.fn();

    await expect(adoptRetainedVolume(dbRow({ engine: 'redis' }), log)).resolves.toEqual({ action: 'no-rekey-needed' });
    expect(h.run).not.toHaveBeenCalled();
  });

  it('re-keys a retained postgres volume with the cluster\'s own image and verifies the new password', async () => {
    captureVolume(true, labels());
    h.capture.mockImplementation(async (_cmd: string, args: string[], _opts: unknown, input?: Buffer) => {
      if (args.includes('--single')) {
        expect(args).toEqual([
          'run', '--rm', '-i', '-v', 'v:/var/lib/postgresql/data', 'postgres:16',
          'postgres', '--single', '-D', '/var/lib/postgresql/data', 'postgres',
        ]);
        const sql = (input as Buffer).toString();
        expect(sql).toContain("ALTER ROLE nine WITH PASSWORD 'secret' VALID UNTIL 'infinity';");
        return 'NINEDEPLOY_REKEY_OK';
      }
      if (args.includes('--format')) return JSON.stringify(labels());
      return '[{"Name":"v"}]';
    });

    await expect(adoptRetainedVolume(dbRow({ passwordEncrypted: 'v0:secret' }), vi.fn())).resolves.toEqual({ action: 'rekeyed' });
    expect(h.ensureDockerImage).toHaveBeenCalledWith('postgres:16', expect.any(Function));
  });

  it('re-keys a postgres 18+ labeled volume with the 18 cluster layout (single mount at /var/lib/postgresql)', async () => {
    captureVolume(true, labels({ 'ninedeploy.database.image': 'pgvector/pgvector:pg18' }));
    h.capture.mockImplementation(async (_cmd: string, args: string[], _opts: unknown, _input?: Buffer) => {
      if (args.includes('--single')) {
        expect(args).toEqual([
          'run', '--rm', '-i', '-v', 'v:/var/lib/postgresql', 'pgvector/pgvector:pg18',
          'postgres', '--single', '-D', '/var/lib/postgresql/18/docker', 'postgres',
        ]);
        return 'NINEDEPLOY_REKEY_OK';
      }
      if (args.includes('--format')) return JSON.stringify(labels({ 'ninedeploy.database.image': 'pgvector/pgvector:pg18' }));
      return '[{"Name":"v"}]';
    });

    await expect(adoptRetainedVolume(dbRow({ passwordEncrypted: 'v0:secret' }), vi.fn())).resolves.toEqual({ action: 'rekeyed' });
  });

  it('escapes single quotes in the generated password', async () => {
    captureVolume(true, labels());
    let sql = '';
    h.capture.mockImplementation(async (_cmd: string, args: string[], _opts: unknown, input?: Buffer) => {
      if (args.includes('--single')) {
        sql = (input as Buffer).toString();
        return 'NINEDEPLOY_REKEY_OK';
      }
      if (args.includes('--format')) return JSON.stringify(labels());
      return '[{"Name":"v"}]';
    });

    await adoptRetainedVolume(dbRow({ passwordEncrypted: "v0:it's" }), vi.fn());
    expect(sql).toContain("ALTER ROLE nine WITH PASSWORD 'it''s' VALID UNTIL 'infinity';");
  });

  it('refuses a re-key that the sidecar did not verify', async () => {
    captureVolume(true, labels());
    h.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--single')) return 'FATAL: database files are incompatible with server';
      if (args.includes('--format')) return JSON.stringify(labels());
      return '[{"Name":"v"}]';
    });

    await expect(adoptRetainedVolume(dbRow(), vi.fn())).rejects.toThrow(
      /Retained volume "v" holds postgres data \(previously "Old DB", postgres\) but re-keying it failed/,
    );
  });

  it('refuses engines it cannot re-key, naming the volume and its origin', async () => {
    captureVolume(true, labels({ 'ninedeploy.database.engine': 'mysql' }));

    await expect(adoptRetainedVolume(dbRow({ engine: 'mysql' }), vi.fn())).rejects.toThrow(
      /Retained volume "v" still holds mysql data \(previously "Old DB", mysql\) whose credentials NineDeploy cannot re-key.*docker volume rm v/,
    );
  });

  it('refuses to mount another engine\'s labeled data directory', async () => {
    captureVolume(true, labels({ 'ninedeploy.database.engine': 'mysql' }));

    await expect(adoptRetainedVolume(dbRow({ engine: 'postgres' }), vi.fn())).rejects.toThrow(
      /holds mysql data \(previously "Old DB", mysql\), not postgres/,
    );
  });

  it('treats an unlabeled retained volume as managed postgres data and still re-keys it', async () => {
    captureVolume(true, {});
    h.capture.mockImplementation(async (_cmd: string, args: string[], _opts: unknown, input?: Buffer) => {
      if (args.includes('--single')) {
        // No label → the row's own default image builds the sidecar.
        expect((args as string[])[5]).toBe('postgres:18');
        expect((input as Buffer).toString()).toContain("ALTER ROLE nine");
        return 'NINEDEPLOY_REKEY_OK';
      }
      if (args.includes('--format')) return '{}';
      return '[{"Name":"v"}]';
    });

    await expect(adoptRetainedVolume(dbRow(), vi.fn())).resolves.toEqual({ action: 'rekeyed' });
  });
});

describe('createDockerVolume', () => {
  it('applies labels at creation', async () => {
    await createDockerVolume('nd-db-x-data', vi.fn(), { 'ninedeploy.managed': 'database', 'ninedeploy.database.engine': 'redis' });
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      ['volume', 'create', '--label', 'ninedeploy.managed=database', '--label', 'ninedeploy.database.engine=redis', 'nd-db-x-data'],
      {},
      expect.any(Function),
    );
  });

  it('creates plain volumes when no labels are given', async () => {
    await createDockerVolume('nd-svc-x-data');
    expect(h.run).toHaveBeenCalledWith('docker', ['volume', 'create', 'nd-svc-x-data'], {}, expect.any(Function));
  });
});


describe('stopDatabase', () => {
  it('stops and removes the container but keeps the volume', async () => {
    const log = vi.fn();

    await stopDatabase(dbRow(), log);

    expect(log).toHaveBeenCalledWith('Stopping c (volume retained) …');
    expect(h.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'c'], {}, expect.any(Function));
  });

  it('does nothing when there is no container name', async () => {
    const log = vi.fn();
    await stopDatabase(dbRow({ containerName: null }), log);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('swallows remove errors', async () => {
    h.run.mockRejectedValueOnce(new Error('gone'));
    await expect(stopDatabase(dbRow(), vi.fn())).resolves.toBeUndefined();
  });
});

describe('removeVolume', () => {
  it('deletes the named volume', async () => {
    const log = vi.fn();

    await removeVolume('v', log);

    expect(log).toHaveBeenCalledWith('Deleting volume v …');
    expect(h.run).toHaveBeenCalledWith('docker', ['volume', 'rm', 'v'], {}, log);
  });

  it('swallows errors', async () => {
    h.run.mockRejectedValueOnce(new Error('volume busy'));
    await expect(removeVolume('v', vi.fn())).resolves.toBeUndefined();
  });
});

describe('connectionString', () => {
  it('builds a postgres connection string with internal host/port', () => {
    const d = dbRow({ engine: 'postgres', internalHost: 'pg.internal', internalPort: 15432 });
    expect(connectionString(d)).toBe('postgres://nine:pw%3Aenc@pg.internal:15432/app');
    expect(h.decrypt).toHaveBeenCalledWith('enc');
  });

  it('falls back to the container name and engine port', () => {
    const d = dbRow({ engine: 'mysql' });
    expect(connectionString(d)).toBe('mysql://root:pw%3Aenc@c:3306/app');
  });

  it('handles missing host/port and an empty user (redis)', () => {
    const d = dbRow({ engine: 'redis', internalHost: null, containerName: null, internalPort: null });
    expect(connectionString(d)).toBe('redis://:pw%3Aenc@:6379');
  });

  it('builds a mongo connection string', () => {
    expect(connectionString(dbRow({ engine: 'mongo' }))).toBe('mongodb://nine:pw%3Aenc@c:27017');
  });

  it('throws for an unknown engine', () => {
    expect(() => connectionString(dbRow({ engine: 'oracle' }))).toThrow('Unknown engine: oracle');
  });
});

describe('defaultPort', () => {
  it('returns the engine port or 0 for unknown engines', () => {
    expect(defaultPort('postgres')).toBe(5432);
    expect(defaultPort('bogus')).toBe(0);
  });
});

describe('databaseSize', () => {
  it('returns 0 for unknown engines or missing container names', async () => {
    await expect(databaseSize(dbRow({ engine: 'oracle' }))).resolves.toBe(0);
    await expect(databaseSize(dbRow({ containerName: null }))).resolves.toBe(0);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('queries postgres size and falls back to 0 on garbage', async () => {
    h.capture.mockResolvedValueOnce('12345');
    await expect(databaseSize(dbRow({ engine: 'postgres' }))).resolves.toBe(12345);
    expect(h.capture).toHaveBeenCalledWith('docker', ['exec', 'c', 'psql', '-U', 'nine', '-d', 'app', '-tAc', 'SELECT pg_database_size(current_database())']);

    h.capture.mockResolvedValueOnce('not-a-number');
    await expect(databaseSize(dbRow({ engine: 'postgres' }))).resolves.toBe(0);
  });

  it('parses redis used_memory (authed) and returns 0 when absent', async () => {
    h.capture.mockResolvedValueOnce('used_memory:456\n');
    await expect(databaseSize(dbRow({ engine: 'redis' }))).resolves.toBe(456);
    expect(h.capture).toHaveBeenCalledWith('docker', ['exec', 'c', 'redis-cli', '-a', 'pw:enc', '--no-auth-warning', 'INFO', 'memory']);
    expect(h.decrypt).toHaveBeenCalledWith('enc');

    h.capture.mockResolvedValueOnce('no match here');
    await expect(databaseSize(dbRow({ engine: 'redis' }))).resolves.toBe(0);
  });

  it('queries mysql size with the decrypted password', async () => {
    h.capture.mockResolvedValueOnce('789');
    await expect(databaseSize(dbRow({ engine: 'mysql' }))).resolves.toBe(789);
    expect(h.decrypt).toHaveBeenCalledWith('enc');

    h.capture.mockResolvedValueOnce('bad');
    await expect(databaseSize(dbRow({ engine: 'mysql' }))).resolves.toBe(0);
  });

  it('parses mongo dataSize', async () => {
    h.capture.mockResolvedValueOnce('123.5');
    await expect(databaseSize(dbRow({ engine: 'mongo' }))).resolves.toBe(123.5);

    h.capture.mockResolvedValueOnce('nothing');
    await expect(databaseSize(dbRow({ engine: 'mongo' }))).resolves.toBe(0);
  });

  it('returns 0 when the query fails', async () => {
    h.capture.mockRejectedValue(new Error('not ready'));
    await expect(databaseSize(dbRow({ engine: 'postgres' }))).resolves.toBe(0);
  });

  it('returns 0 when the engine is not one of the four handled engines', async () => {
    // A truthy (inherited) ENGINES entry plus a container name passes the guard
    // and reaches the engine dispatch without matching any handled branch.
    await expect(databaseSize(dbRow({ engine: 'toString', containerName: 'c' }))).resolves.toBe(0);
  });
});

describe('backupDatabase', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-backup-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('backs up postgres via a container-side dump file + docker cp (no in-memory dump)', async () => {
    const file = path.join(tmp, 'pg.sql');
    writeFileSync(file, ''); // the (mocked) docker cp would land here
    const log = vi.fn();
    await backupDatabase(dbRow({ engine: 'postgres' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['exec', 'c', 'pg_dump', '-U', 'nine', '-d', 'app', '--file=/tmp/ninedeploy-dump'], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', 'c:/tmp/ninedeploy-dump', file], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['exec', 'c', 'rm', '-f', '/tmp/ninedeploy-dump'], {}, expect.any(Function));
    expect(h.capture).not.toHaveBeenCalled();
    expect(readFileSync(file).subarray(0, 6).toString()).toBe('NDBK1:');
  });

  it('backs up mysql with the decrypted password via result-file + docker cp', async () => {
    const file = path.join(tmp, 'mysql.sql');
    writeFileSync(file, '');
    const log = vi.fn();
    await backupDatabase(dbRow({ engine: 'mysql' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', [
      'exec', 'c', 'mysqldump', '-uroot', '--password=pw:enc', '--single-transaction', '--quick', '--all-databases', '--result-file=/tmp/ninedeploy-dump',
    ], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', 'c:/tmp/ninedeploy-dump', file], {}, log);
    expect(h.decrypt).toHaveBeenCalledWith('enc');
    expect(h.capture).not.toHaveBeenCalled();
    expect(readFileSync(file).subarray(0, 6).toString()).toBe('NDBK1:');
  });

  it('backs up redis via authed redis-cli SAVE + docker cp, then encrypts', async () => {
    const file = path.join(tmp, 'redis.rdb');
    writeFileSync(file, 'RDB-BYTES'); // the (mocked) docker cp lands here
    const log = vi.fn();
    await backupDatabase(dbRow({ engine: 'redis' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['exec', 'c', 'redis-cli', '-a', 'pw:enc', '--no-auth-warning', 'SAVE'], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', 'c:/data/dump.rdb', file], {}, log);
    expect(h.decrypt).toHaveBeenCalledWith('enc');
    expect(readFileSync(file).includes(Buffer.from('RDB-BYTES'))).toBe(true);
  });

  it('backs up mongo via a static container temp file + docker cp, then encrypts', async () => {
    const file = path.join(tmp, 'mongo.archive');
    writeFileSync(file, 'MONGO-BYTES');
    const log = vi.fn();
    await backupDatabase(dbRow({ engine: 'mongo' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', [
      'exec', 'c', 'mongodump',
      '-u', 'nine', '-p', 'pw:enc', '--authenticationDatabase', 'admin',
      '--archive=/tmp/ninedeploy-dump', '--gzip',
    ], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', 'c:/tmp/ninedeploy-dump', file], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['exec', 'c', 'rm', '-f', '/tmp/ninedeploy-dump'], {}, expect.any(Function));
    expect(readFileSync(file).includes(Buffer.from('MONGO-BYTES'))).toBe(true);
  });

  it('throws for databases that are not runnable', async () => {
    await expect(backupDatabase(dbRow({ engine: 'oracle' }), '/f', vi.fn())).rejects.toThrow('database not runnable');
    await expect(backupDatabase(dbRow({ containerName: null }), '/f', vi.fn())).rejects.toThrow('database not runnable');
  });

  it('hits the unsupported fallback for a non-owned engine key', async () => {
    await expect(backupDatabase(dbRow({ engine: 'toString', containerName: 'c' }), '/f', vi.fn())).rejects.toThrow(
      'backup not supported for toString',
    );
  });
});

describe('readBackupBytes', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-read-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('decrypts an envelope backup to the original bytes', () => {
    const f = path.join(tmp, 'enc.dump');
    writeFileSync(f, `v0:${Buffer.from('hello').toString('base64')}`);
    expect(readBackupBytes(f).toString()).toBe('hello');
  });

  it('returns a legacy plaintext backup as-is (raw bytes, not base64)', () => {
    const f = path.join(tmp, 'legacy.dump');
    // Legacy backups predate envelope encryption: the raw file bytes ARE the dump.
    writeFileSync(f, Buffer.from('legacy'));
    expect(readBackupBytes(f).toString()).toBe('legacy');
  });
});

describe('createBackupReadStream', () => {
  const streamTmp = mkdtempSync(path.join(os.tmpdir(), 'nd-stream-read-'));
  afterAll(() => rmSync(streamTmp, { recursive: true, force: true }));

  it('streams the plaintext payload from the current backup envelope', async () => {
    const file = path.join(streamTmp, 'streamed.dump');
    writeFileSync(file, Buffer.concat([
      Buffer.from('NDBK1:v0:AAAAAAAAAAAAAAAA\nhello-stream'),
      Buffer.alloc(16, 7),
    ]));
    const stream = await createBackupReadStream(file);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('hello-stream');
  });
});

describe('restoreDatabase', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-restore-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const encFile = (plain: string) => {
    const f = path.join(tmp, `enc-${plain.length}.dump`);
    writeFileSync(f, `v0:${Buffer.from(plain).toString('base64')}>`);
    return f;
  };

  it('restores postgres from an ENCRYPTED backup (decrypts to a temp sibling)', async () => {
    const log = vi.fn();
    const file = encFile('-- plain sql --');
    await restoreDatabase(dbRow({ engine: 'postgres' }), file, log);
    // docker cp receives the DECRYPTED sibling, not the envelope file.
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', `${file}.dec`, 'c:/tmp/ninedeploy-restore'], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['exec', 'c', 'psql', '-U', 'nine', '-d', 'app', '-f', '/tmp/ninedeploy-restore'], {}, log);
  });

  it('restores from a LEGACY plaintext backup as-is (no envelope)', async () => {
    const log = vi.fn();
    const file = path.join(tmp, 'legacy.dump');
    writeFileSync(file, '-- legacy plain --');
    await restoreDatabase(dbRow({ engine: 'postgres' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', file, 'c:/tmp/ninedeploy-restore'], {}, log);
  });

  it('restores mysql with the decrypted password via source (no shell interpolation)', async () => {
    const log = vi.fn();
    const file = encFile('USE app;');
    await restoreDatabase(dbRow({ engine: 'mysql' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', `${file}.dec`, 'c:/tmp/ninedeploy-restore'], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', [
      'exec', 'c', 'mysql', '-uroot', '--password=pw:enc', '-e', 'source /tmp/ninedeploy-restore',
    ], {}, log);
    expect(h.decrypt).toHaveBeenCalledWith('enc');
  });

  it('backs up mariadb via mariadb-dump', async () => {
    const file = path.join(tmp, 'mariadb.sql');
    writeFileSync(file, '');
    const log = vi.fn();
    await backupDatabase(dbRow({ engine: 'mariadb' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', [
      'exec', 'c', 'mariadb-dump', '-uroot', '--password=pw:enc', '--single-transaction', '--quick', '--all-databases', '--result-file=/tmp/ninedeploy-dump',
    ], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', 'c:/tmp/ninedeploy-dump', file], {}, log);
    expect(h.capture).not.toHaveBeenCalled();
    expect(readFileSync(file).subarray(0, 6).toString()).toBe('NDBK1:');
  });

  it('restores mariadb via the mariadb client', async () => {
    const log = vi.fn();
    const file = encFile('USE app;');
    await restoreDatabase(dbRow({ engine: 'mariadb' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', [
      'exec', 'c', 'mariadb', '-uroot', '--password=pw:enc', '-e', 'source /tmp/ninedeploy-restore',
    ], {}, log);
  });

  it('queries the mariadb size like mysql', async () => {
    h.capture.mockResolvedValueOnce('4242');
    await expect(databaseSize(dbRow({ engine: 'mariadb' }))).resolves.toBe(4242);
    expect(h.capture).toHaveBeenCalledWith('docker', [
      'exec', 'c', 'mariadb', '-uroot', '--password=pw:enc', '-N',
      '-e', 'SELECT IFNULL(SUM(data_length+index_length),0) FROM information_schema.tables',
    ]);
  });

  it('restores mongo via docker cp + mongorestore --archive=path', async () => {
    const log = vi.fn();
    const file = encFile('MONGO');
    await restoreDatabase(dbRow({ engine: 'mongo' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', `${file}.dec`, 'c:/tmp/ninedeploy-restore'], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', [
      'exec', 'c', 'mongorestore',
      '-u', 'nine', '-p', 'pw:enc', '--authenticationDatabase', 'admin',
      '--archive=/tmp/ninedeploy-restore', '--gzip', '--drop',
    ], {}, log);
  });

  it('restores redis via docker cp to /data/dump.rdb + docker restart', async () => {
    const log = vi.fn();
    const file = encFile('REDIS');
    await restoreDatabase(dbRow({ engine: 'redis' }), file, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', `${file}.dec`, 'c:/data/dump.rdb'], {}, log);
    expect(h.run).toHaveBeenCalledWith('docker', ['restart', 'c'], {}, log);
    expect(existsSyncMock(`${file}.dec`)).toBe(false);
  });

  it('removes the staged restore file and decrypted sibling afterwards', async () => {
    const file = encFile('x');
    await restoreDatabase(dbRow({ engine: 'postgres' }), file, vi.fn());
    expect(h.run).toHaveBeenCalledWith('docker', ['exec', 'c', 'rm', '-f', '/tmp/ninedeploy-restore'], {}, expect.any(Function));
    expect(existsSyncMock(`${file}.dec`)).toBe(false);
  });

  it('swallows a failing cleanup after a successful restore', async () => {
    h.run.mockImplementation(async (_cmd: string, args: unknown[]) => {
      if (Array.isArray(args) && args.includes('rm')) throw new Error('cleanup failed');
    });
    const file = encFile('y');
    await expect(restoreDatabase(dbRow({ engine: 'postgres' }), file, vi.fn())).resolves.toBeUndefined();
    expect(h.run).toHaveBeenCalledWith('docker', ['exec', 'c', 'rm', '-f', '/tmp/ninedeploy-restore'], {}, expect.any(Function));
  });

  it('rejects unsupported engines and non-runnable databases', async () => {
    await expect(restoreDatabase(dbRow({ engine: 'oracle' }), '/f', vi.fn())).rejects.toThrow('database not runnable');
    await expect(restoreDatabase(dbRow({ containerName: null }), '/f', vi.fn())).rejects.toThrow('database not runnable');
  });

  it('hits the unsupported fallback for a non-owned engine key', async () => {
    await expect(restoreDatabase(dbRow({ engine: 'toString', containerName: 'c' }), '/f', vi.fn())).rejects.toThrow(
      'restore not supported for toString',
    );
  });

  it('restores a mariadb database using the mariadb CLI client', async () => {
    const file = encFile('mariadb-backup');
    await restoreDatabase(dbRow({ engine: 'mariadb', passwordEncrypted: 'enc-pass' }), file, vi.fn());
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      ['exec', 'c', 'mariadb', '-uroot', '--password=pw:enc-pass', '-e', 'source /tmp/ninedeploy-restore'],
      {},
      expect.any(Function),
    );
  });

  it('restarts a running database container', async () => {
    await restartDatabase(dbRow({ containerName: 'db-cont' }), vi.fn());
    expect(h.run).toHaveBeenCalledWith('docker', ['restart', 'db-cont'], {}, expect.any(Function));
    await expect(restartDatabase(dbRow({ containerName: null }), vi.fn())).rejects.toThrow('database not runnable');
  });

  it('captures database logs and handles errors or missing container', async () => {
    h.capture.mockResolvedValueOnce('line 1\nline 2\n');
    const logs = await databaseLogs(dbRow({ containerName: 'db-cont' }), 50);
    expect(logs).toEqual(['line 1', 'line 2']);
    expect(h.capture).toHaveBeenCalledWith('docker', ['logs', '--tail', '50', 'db-cont']);

    expect(await databaseLogs(dbRow({ containerName: null }))).toEqual([]);

    h.capture.mockRejectedValueOnce(new Error('docker dead'));
    expect(await databaseLogs(dbRow({ containerName: 'db-cont' }))).toEqual([]);
  });

  it('configures extended engines properly (valkey, clickhouse, meilisearch, rabbitmq, vector)', () => {
    expect(ENGINES.postgres.image('vector')).toBe('pgvector/pgvector:pg18');
    expect(ENGINES.postgres.image('pgvector')).toBe('pgvector/pgvector:pg18');
    expect(ENGINES.postgres.image('16')).toBe('postgres:16');
    expect(ENGINES.valkey.image('8')).toBe('valkey/valkey:8');
    expect(ENGINES.valkey.image()).toBe('valkey/valkey:9.1');
    expect(ENGINES.clickhouse.image('24.3')).toBe('clickhouse/clickhouse-server:24.3');
    expect(ENGINES.clickhouse.image()).toBe('clickhouse/clickhouse-server:25.8');
    expect(ENGINES.meilisearch.image('v1.12')).toBe('getmeili/meilisearch:v1.12');
    expect(ENGINES.meilisearch.image()).toBe('getmeili/meilisearch:v1.53');
    expect(ENGINES.rabbitmq.image('3-management')).toBe('rabbitmq:3-management');
    expect(ENGINES.rabbitmq.image()).toBe('rabbitmq:4-management');

    expect(ENGINES.valkey.env('p')).toEqual({});
    expect(ENGINES.valkey.username()).toBeUndefined();
    expect(ENGINES.valkey.dbName()).toBeUndefined();

    expect(ENGINES.clickhouse.env('p')).toEqual({ CLICKHOUSE_USER: 'nine', CLICKHOUSE_PASSWORD: 'p', CLICKHOUSE_DB: 'app' });
    expect(ENGINES.clickhouse.username()).toBe('nine');
    expect(ENGINES.clickhouse.dbName()).toBe('app');

    expect(ENGINES.meilisearch.env('p')).toEqual({ MEILI_MASTER_KEY: 'p', MEILI_NO_ANALYTICS: 'true' });
    expect(ENGINES.meilisearch.username()).toBeUndefined();
    expect(ENGINES.meilisearch.dbName()).toBeUndefined();

    expect(ENGINES.rabbitmq.env('p')).toEqual({ RABBITMQ_DEFAULT_USER: 'nine', RABBITMQ_DEFAULT_PASS: 'p' });
    expect(ENGINES.rabbitmq.username()).toBe('nine');
    expect(ENGINES.rabbitmq.dbName()).toBeUndefined();

    expect(connectionString(dbRow({ engine: 'valkey', internalHost: 'valkey-h', internalPort: 6379 }))).toBe('valkey://:pw%3Aenc@valkey-h:6379');
    expect(connectionString(dbRow({ engine: 'clickhouse', internalHost: 'ch-h', internalPort: 8123 }))).toBe('clickhouse://nine:pw%3Aenc@ch-h:8123/app');
    expect(ENGINES.clickhouse.connectionString('ch-h', 8123, 'nine', 'pw:enc', undefined)).toBe('clickhouse://nine:pw%3Aenc@ch-h:8123/default');
    expect(connectionString(dbRow({ engine: 'meilisearch', internalHost: 'ms-h', internalPort: 7700 }))).toBe('http://:pw%3Aenc@ms-h:7700');
    expect(connectionString(dbRow({ engine: 'rabbitmq', internalHost: 'rb-h', internalPort: 5672 }))).toBe('amqp://nine:pw%3Aenc@rb-h:5672/');
    expect(defaultPort('clickhouse')).toBe(8123);
    expect(defaultPort('meilisearch')).toBe(7700);
    expect(defaultPort('rabbitmq')).toBe(5672);
  });

  it('manages Web Studio containers (Adminer and Redis Commander)', async () => {
    const { studioImageForEngine, isDatabaseStudioRunning, startDatabaseStudio, stopDatabaseStudio } = await import(
      '../src/engine/database.js'
    );
    expect(studioImageForEngine('postgres')).toEqual({ image: 'adminer:latest', containerPort: 8080 });
    expect(studioImageForEngine('redis')).toEqual({ image: 'rediscommander/redis-commander:latest', containerPort: 8081 });
    expect(studioImageForEngine('valkey')).toEqual({ image: 'rediscommander/redis-commander:latest', containerPort: 8081 });

    h.capture.mockResolvedValueOnce('running');
    expect(await isDatabaseStudioRunning(dbRow({ slug: 'my-db' }))).toBe(true);

    h.capture.mockResolvedValueOnce('stopped');
    expect(await isDatabaseStudioRunning(dbRow({ slug: 'my-db' }))).toBe(false);

    // If already running, startDatabaseStudio returns early
    h.capture.mockResolvedValueOnce('running');
    await startDatabaseStudio(dbRow({ slug: 'my-db', engine: 'postgres', name: 'my-db' }), 18000, vi.fn());

    // Starts Redis commander with REDIS_HOSTS
    h.capture.mockResolvedValueOnce('exited');
    await startDatabaseStudio(dbRow({ slug: 'my-redis', engine: 'redis', name: 'my-redis', internalHost: 'my-redis' }), 18001, vi.fn());
    expect(h.ensureDockerImage).toHaveBeenCalledWith('rediscommander/redis-commander:latest', expect.any(Function));
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run', '-d', '--name', 'nd-studio-my-redis', '-p', '127.0.0.1:18001:8081', '-e', 'REDIS_HOSTS=local:my-redis:6379']),
      {},
      expect.any(Function),
    );

    // Starts Valkey studio container using containerName fallback
    h.capture.mockResolvedValueOnce('exited');
    await startDatabaseStudio(dbRow({ slug: 'my-valkey', engine: 'valkey', name: 'my-valkey', internalHost: null, containerName: 'nd-valkey' }), 18002, vi.fn());
    expect(h.run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run', '-d', '--name', 'nd-studio-my-valkey', '-p', '127.0.0.1:18002:8081', '-e', 'REDIS_HOSTS=local:nd-valkey:6379']),
      {},
      expect.any(Function),
    );

    // Starts postgres studio container using empty host fallback
    h.capture.mockResolvedValueOnce('exited');
    await startDatabaseStudio(dbRow({ slug: 'my-pg', engine: 'postgres', name: 'my-pg', internalHost: null, containerName: null }), 18003, vi.fn());

    // Stop studio
    await stopDatabaseStudio(dbRow({ slug: 'my-redis', name: 'my-redis' }), vi.fn());
    expect(h.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'nd-studio-my-redis'], {}, expect.any(Function));
  });

  it('backs up and restores valkey database', async () => {
    // Size check
    h.capture.mockResolvedValueOnce('used_memory:1048576');
    const size = await databaseSize(dbRow({ engine: 'valkey', containerName: 'c' }));
    expect(size).toBe(1048576);

    // Backup
    const backupTarget = encFile('valkey-b');
    await backupDatabase(dbRow({ engine: 'valkey', containerName: 'c' }), backupTarget, vi.fn());
    expect(h.run).toHaveBeenCalledWith('docker', ['exec', 'c', 'redis-cli', '-a', 'pw:enc', '--no-auth-warning', 'SAVE'], {}, expect.any(Function));

    // Restore
    await restoreDatabase(dbRow({ engine: 'valkey', containerName: 'c' }), backupTarget, vi.fn());
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', expect.any(String), 'c:/data/dump.rdb'], {}, expect.any(Function));
    expect(h.run).toHaveBeenCalledWith('docker', ['restart', 'c'], {}, expect.any(Function));
  });
});
