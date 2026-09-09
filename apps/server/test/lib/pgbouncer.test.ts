/**
 * G-32 PgBouncer sidecar — lib coverage.
 *
 * `pgbouncer.ts` is the engine behind the three
 * `databases pgbouncer {enable, disable, status}` routes. The
 * surface worth pinning down:
 *  - `pgbouncerContainerName` falls back to `nd-pgb-<slug>`
 *    when the row is not flagged.
 *  - `pooledConnectionString` returns the pgbouncer URL when
 *    the sidecar is enabled, the direct URL otherwise. It
 *    fills missing `username` / `dbName` / `containerName`
 *    with sane defaults so a row that was created before the
 *    pgbouncer columns existed still resolves.
 *  - `enablePgbouncer` is idempotent (re-running on an
 *    already-up sidecar is a no-op), refuses non-postgres
 *    engines and databases without a container name, and
 *    bails when the postgres container is not running yet.
 *  - The pull+ini+userlist+run sequence is wired through
 *    `exec` + `secretFile`, and the row is stamped with the
 *    resolved container name + port on success.
 *  - `disablePgbouncer` skips when the row is not flagged,
 *    tears the container down, clears the row, and reaps
 *    the bind-mounted config files.
 *  - `pgbouncerStatusFor` returns the disabled shape when
 *    the row is not flagged, otherwise queries docker for
 *    the running flag and parses `pool_mode` out of the
 *    rendered ini inside the sidecar (r016: the container
 *    env can never answer — enablePgbouncer passes no -e
 *    flags, so PGBOUNCER_POOL_MODE does not exist there).
 */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  execState,
  cryptoState,
  secretState,
  fsState,
} = vi.hoisted(() => {
  const execState = {
    /** Maps a `tool args-joined` key to the result to return. */
    toolResults: new Map<string, { stdout?: string; throw?: Error }>(),
    /** Recorded docker run args for assertions. */
    runs: [] as Array<{ tool: string; args: string[] }>,
    /** Recorded `capture` calls (for the pull step). */
    captures: [] as Array<{ tool: string; args: string[] }>,
  };
  const cryptoState = {
    /** id → decrypted password. */
    decrypted: new Map<string, string>(),
  };
  const secretState = {
    /** id → written path. */
    written: new Map<string, string>(),
    /** Paths whose cleanup() ran. */
    cleaned: [] as string[],
    nextId: 0,
  };
  const fsState = {
    unlinkCalls: [] as string[],
  };
  return { execState, cryptoState, secretState, fsState };
});

vi.mock('../../src/lib/exec.js', () => ({
  capture: vi.fn(async (tool: string, args: string[] = []) => {
    execState.captures.push({ tool, args });
    const key = `${tool} ${args.join(' ')}`;
    const r = execState.toolResults.get(key);
    if (r?.throw) throw r.throw;
    return r?.stdout ?? '';
  }),
  run: vi.fn(async (tool: string, args: string[] = []) => {
    execState.runs.push({ tool, args });
    const key = `${tool} ${args.join(' ')}`;
    const r = execState.toolResults.get(key);
    if (r?.throw) throw r.throw;
  }),
}));

vi.mock('../../src/lib/crypto.js', () => ({
  decrypt: vi.fn((cipher: string) => {
    return cryptoState.decrypted.get(cipher) ?? 'plainpw';
  }),
}));

vi.mock('../../src/lib/secretFile.js', () => ({
  writeSecretFile: vi.fn(async (_ref: string, suffix: string, _body: string) => {
    const id = secretState.nextId++;
    const path = `/tmp/nd-pgb-test-${id}.${suffix}`;
    secretState.written.set(suffix, path);
    return { path, cleanup: () => { secretState.cleaned.push(path); } };
  }),
}));

vi.mock('../../src/engine/proxy.js', () => ({
  NETWORK: 'nd-net',
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    unlink: vi.fn(async (p: string) => {
      fsState.unlinkCalls.push(p);
    }),
  };
});

import {
  enablePgbouncer,
  disablePgbouncer,
  pgbouncerContainerName,
  pgbouncerStatusFor,
  pooledConnectionString,
} from '../../src/lib/pgbouncer.js';
import { createFakeDb } from '../helpers.js';

interface DbRow {
  id: number;
  name: string;
  slug: string;
  engine: string;
  containerName: string | null;
  internalHost: string | null;
  internalPort: number | null;
  dbName: string | null;
  username: string | null;
  passwordEncrypted: string;
  pgbouncerEnabled: boolean;
  pgbouncerContainerName: string | null;
  pgbouncerPort: number | null;
}

function buildDb(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: 1,
    name: 'mydb',
    slug: 'mydb',
    engine: 'postgres',
    containerName: 'nd-pg-mydb',
    internalHost: null,
    internalPort: 5432,
    dbName: 'app',
    username: 'nine',
    passwordEncrypted: 'cipher::pw',
    pgbouncerEnabled: false,
    pgbouncerContainerName: null,
    pgbouncerPort: null,
    ...overrides,
  };
}

const dbState = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
  database: { id: 1 } as DbRow,
}));

vi.mock('@ninedeploy/db', () => ({
  databases: { _: { name: 'databases' } },
}));

const db = createFakeDb({
  update: {
    databases: (set: Record<string, unknown>) => {
      dbState.updates.push({ table: 'databases', set });
      return [{ id: 1, ...set }];
    },
  },
});

beforeEach(() => {
  execState.toolResults.clear();
  execState.runs.length = 0;
  execState.captures.length = 0;
  cryptoState.decrypted.clear();
  cryptoState.decrypted.set('cipher::pw', 'plainpw');
  secretState.written.clear();
  secretState.nextId = 0;
  secretState.cleaned.length = 0;
  fsState.unlinkCalls.length = 0;
  dbState.updates.length = 0;
  dbState.database = { id: 1 } as DbRow;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('pgbouncerContainerName', () => {
  it('returns the explicit column when set', () => {
    expect(pgbouncerContainerName(buildDb({ pgbouncerContainerName: 'nd-pgb-custom' }))).toBe('nd-pgb-custom');
  });

  it('falls back to nd-pgb-<slug> when the column is null', () => {
    expect(pgbouncerContainerName(buildDb({ pgbouncerContainerName: null, slug: 'orders' }))).toBe('nd-pgb-orders');
  });
});

describe('pooledConnectionString', () => {
  it('returns the pgbouncer URL when the sidecar is enabled', () => {
    const s = pooledConnectionString(
      buildDb({
        pgbouncerEnabled: true,
        pgbouncerContainerName: 'nd-pgb-mydb',
        pgbouncerPort: 6432,
      }),
    );
    expect(s).toBe('postgres://nine:plainpw@nd-pgb-mydb:6432/app');
  });

  it('falls back to the direct URL when pgbouncerEnabled is false', () => {
    const s = pooledConnectionString(buildDb());
    expect(s).toBe('postgres://nine:plainpw@nd-pg-mydb:5432/app');
  });

  it('falls back to the direct URL when the container name is missing', () => {
    const s = pooledConnectionString(buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: null }));
    expect(s).toBe('postgres://nine:plainpw@nd-pg-mydb:5432/app');
  });

  it('uses default username / dbName / port / host when columns are missing', () => {
    const s = pooledConnectionString(
      buildDb({
        pgbouncerEnabled: false,
        pgbouncerContainerName: null,
        username: null,
        dbName: null,
        internalPort: null,
        containerName: null,
        internalHost: 'pg.internal',
      }),
    );
    // Direct path: defaults resolve to nine / app / 5432 / pg.internal.
    expect(s).toBe('postgres://nine:plainpw@pg.internal:5432/app');
  });

  it('uses the default pgbouncer port when none is set', () => {
    const s = pooledConnectionString(
      buildDb({
        pgbouncerEnabled: true,
        pgbouncerContainerName: 'nd-pgb-mydb',
        pgbouncerPort: null,
      }),
    );
    expect(s).toBe('postgres://nine:plainpw@nd-pgb-mydb:6432/app');
  });

  it('encodes the password and username when special characters are present', () => {
    cryptoState.decrypted.set('cipher::pw', 'p@ss/wo:rd!');
    // `encodeURIComponent` does NOT encode `!` (it's a valid URI character);
    // the `:` and `/` get encoded as `%3A` / `%2F`.
    const s = pooledConnectionString(buildDb());
    expect(s).toBe('postgres://nine:p%40ss%2Fwo%3Ard!@nd-pg-mydb:5432/app');
  });
});

describe('enablePgbouncer', () => {
  it('rejects non-postgres engines', async () => {
    await expect(
      enablePgbouncer(db, buildDb({ engine: 'mysql' }), () => undefined),
    ).rejects.toThrow(/only supported for the postgres engine/);
  });

  it('rejects when the row has no container name', async () => {
    await expect(
      enablePgbouncer(db, buildDb({ containerName: null }), () => undefined),
    ).rejects.toThrow(/no container name/);
  });

  it('is a no-op when the sidecar is already running', async () => {
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pgb-mydb', { stdout: 'true\n' });
    await enablePgbouncer(
      db,
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
      () => undefined,
    );
    // Pull + run + update must not happen.
    expect(execState.runs).toEqual([]);
    expect(dbState.updates).toEqual([]);
  });

  it('continues to enable when the row is flagged but the container is down', async () => {
    // First inspect says not running; we then bring it up via run, then
    // re-inspect (for the log line is not called — pgbouncer is "running" only
    // if the row is flagged AND the inspect returns true). Here the row is
    // flagged but inspect says false, so the code falls through to setup.
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pg-mydb', { stdout: 'true\n' });
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pgb-mydb', { stdout: 'false\n' });
    await enablePgbouncer(
      db,
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
      () => undefined,
    );
    // A create happened (we re-created the container) and a row update followed.
    expect(execState.runs.some((r) => r.args[0] === 'create')).toBe(true);
    expect(dbState.updates.length).toBeGreaterThan(0);
  });

  it('refuses when the postgres container is not running', async () => {
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pg-mydb', { stdout: 'false\n' });
    await expect(
      enablePgbouncer(db, buildDb(), () => undefined),
    ).rejects.toThrow(/Postgres container.*is not running/);
  });

  it('pulls the image, copies config into the sidecar, starts it, and stamps the row', async () => {
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pg-mydb', { stdout: 'true\n' });
    const log = vi.fn();
    await enablePgbouncer(db, buildDb(), log);

    // Pull + create/cp/start happened.
    expect(execState.captures.some((r) => r.tool === 'docker' && r.args[0] === 'pull')).toBe(true);
    const create = execState.runs.find((r) => r.args[0] === 'create');
    expect(create).toBeDefined();
    expect(create!.args).toContain('--network');
    expect(create!.args).toContain('nd-net');
    expect(create!.args[create!.args.indexOf('--name') + 1]).toBe('nd-pgb-mydb');
    // The secret config is COPIED in (not bind-mounted), so the host-side
    // copies could be deleted at the end of the sequence.
    const cps = execState.runs.filter((r) => r.args[0] === 'cp');
    expect(cps).toHaveLength(2);
    expect(cps[0]!.args[2]).toBe('nd-pgb-mydb:/etc/pgbouncer/pgbouncer.ini');
    expect(cps[1]!.args[2]).toBe('nd-pgb-mydb:/etc/pgbouncer/userlist.txt');
    expect(execState.runs.some((r) => r.args[0] === 'start' && r.args[1] === 'nd-pgb-mydb')).toBe(true);
    // No secret file bind mounts on the host.
    expect(create!.args.join(' ')).not.toContain('-v');

    // Ini + userlist were written via the secretFile helper.
    expect(secretState.written.get('pgbouncer.ini')).toMatch(/\.pgbouncer\.ini$/);
    expect(secretState.written.get('userlist.txt')).toMatch(/\.userlist\.txt$/);

    // Row was stamped with the resolved container name + default port.
    const last = dbState.updates.at(-1);
    expect(last?.set.pgbouncerEnabled).toBe(true);
    expect(last?.set.pgbouncerContainerName).toBe('nd-pgb-mydb');
    expect(last?.set.pgbouncerPort).toBe(6432);

    // Log lines were emitted.
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Pulling PgBouncer image/));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Creating PgBouncer sidecar/));
  });

  it('honors a custom port from the row, bound to LOOPBACK only', async () => {
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pg-mydb', { stdout: 'true\n' });
    await enablePgbouncer(db, buildDb({ pgbouncerPort: 7000 }), () => undefined);
    const create = execState.runs.find((r) => r.args[0] === 'create');
    expect(create).toBeDefined();
    // The publish binds 127.0.0.1: pgbouncer has no panel auth in front of
    // it, so a LAN-reachable port carrying DB credentials is pure surface.
    expect(create!.args).toContain('127.0.0.1:7000:7000');
    expect(create!.args).not.toContain('7000:7000');
    const last = dbState.updates.at(-1);
    expect(last?.set.pgbouncerPort).toBe(7000);
  });

  it('does not publish a host port for the default (network-internal) sidecar', async () => {
    // Every sidecar binds the same default port (6432); the second enabled
    // database would fail `docker run` with "port is already allocated".
    // Connections go over the shared docker network by container name, so
    // the host publish is only for an operator-chosen explicit port.
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pg-mydb', { stdout: 'true\n' });
    await enablePgbouncer(db, buildDb(), () => undefined);
    const create = execState.runs.find((r) => r.args[0] === 'create');
    expect(create).toBeDefined();
    expect(create!.args).not.toContain('-p');
  });

  it('removes the temp config files once the container has consumed them', async () => {
    // The temp files carry the DB password (mode 0600 but still at rest in
    // the shared tmp dir); they must not outlive the enable sequence.
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pg-mydb', { stdout: 'true\n' });
    await enablePgbouncer(db, buildDb(), () => undefined);
    expect(secretState.cleaned.length).toBe(2);
  });

  it('swallows a failing pull (network flakes, but the rest still runs)', async () => {
    execState.toolResults.set('docker pull bitnami/pgbouncer:1.24.1', {
      throw: new Error('network unreachable'),
    });
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pg-mydb', { stdout: 'true\n' });
    await expect(enablePgbouncer(db, buildDb(), () => undefined)).resolves.toBeUndefined();
    expect(execState.runs.some((r) => r.args[0] === 'create')).toBe(true);
  });

  it('uses a row-supplied pgbouncer container name verbatim', async () => {
    execState.toolResults.set('docker inspect --format {{.State.Running}} nd-pg-mydb', { stdout: 'true\n' });
    await enablePgbouncer(
      db,
      buildDb({ pgbouncerContainerName: 'nd-pgb-custom' }),
      () => undefined,
    );
    const create = execState.runs.find((r) => r.args[0] === 'create');
    expect(create).toBeDefined();
    expect(create!.args[create!.args.indexOf('--name') + 1]).toBe('nd-pgb-custom');
  });
});

describe('disablePgbouncer', () => {
  it('is a no-op when the row is not flagged', async () => {
    await disablePgbouncer(db, buildDb(), () => undefined);
    expect(execState.runs).toEqual([]);
    expect(dbState.updates).toEqual([]);
    expect(fsState.unlinkCalls).toEqual([]);
  });

  it('stops the container and clears the row (no host files to reap)', async () => {
    await disablePgbouncer(
      db,
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
      () => undefined,
    );
    expect(execState.runs.length).toBe(1);
    expect(execState.runs[0]?.args).toEqual(['rm', '-f', 'nd-pgb-mydb']);
    const upd = dbState.updates.at(-1);
    expect(upd?.set.pgbouncerEnabled).toBe(false);
    expect(upd?.set.pgbouncerContainerName).toBeNull();
    // Enable copies the config INTO the container and reaps its own temp
    // files — disable has no host filesystem cleanup to do.
    expect(fsState.unlinkCalls).toEqual([]);
  });

  it('falls back to the slug-derived container name when the column is null', async () => {
    await disablePgbouncer(
      db,
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: null, slug: 'orders' }),
      () => undefined,
    );
    expect(execState.runs[0]?.args).toEqual(['rm', '-f', 'nd-pgb-orders']);
    expect(fsState.unlinkCalls).toEqual([]);
  });

  it('swallows a docker rm failure (best-effort teardown)', async () => {
    execState.toolResults.set('docker rm -f nd-pgb-mydb', { throw: new Error('already gone') });
    await disablePgbouncer(
      db,
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
      () => undefined,
    );
    // The row was still cleared.
    const upd = dbState.updates.at(-1);
    expect(upd?.set.pgbouncerEnabled).toBe(false);
  });
});

describe('pgbouncerStatusFor', () => {
  it('returns the disabled shape when the row is not flagged', async () => {
    const status = await pgbouncerStatusFor(buildDb());
    expect(status).toEqual({
      enabled: false,
      containerName: null,
      port: 6432,
      running: false,
      poolMode: null,
      pooledConnectionString: null,
    });
  });

  it('uses the row-supplied port in the disabled shape', async () => {
    const status = await pgbouncerStatusFor(buildDb({ pgbouncerPort: 7000 }));
    expect(status.port).toBe(7000);
  });

  // r016 regression: pool_mode is parsed from the rendered ini that
  // `enablePgbouncer` docker-cp'd into the sidecar. The container env can
  // never answer — the create argv passes no -e flags, so
  // PGBOUNCER_POOL_MODE does not exist there, and the old
  // `{{index .Config.Env}}` template was invalid Go template usage
  // ("index of nothing") besides. poolMode must be null ONLY when the
  // sidecar is down or the ini cannot be read — never while it is running.
  const STATUS_INI = [
    '[databases]',
    'app = host=nd-pg-mydb port=5432',
    '',
    '[pgbouncer]',
    'listen_addr = 0.0.0.0',
    'listen_port = 6432',
    'auth_type = md5',
    'auth_file = /etc/pgbouncer/userlist.txt',
    'pool_mode = transaction',
    'max_client_conn = 1000',
    '',
  ].join('\n');

  it('returns running=true, the pool mode from the rendered ini, and the pooled URL when the container is up', async () => {
    execState.toolResults.set(
      'docker inspect --format {{.State.Running}} nd-pgb-mydb',
      { stdout: 'true\n' },
    );
    execState.toolResults.set(
      'docker exec nd-pgb-mydb cat /etc/pgbouncer/pgbouncer.ini',
      { stdout: STATUS_INI },
    );
    const status = await pgbouncerStatusFor(
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
    );
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(status.poolMode).toBe('transaction');
    expect(status.pooledConnectionString).toBe('postgres://nine:plainpw@nd-pgb-mydb:6432/app');
  });

  it('reports the mode the ini actually pins, not a hardcoded value', async () => {
    execState.toolResults.set(
      'docker inspect --format {{.State.Running}} nd-pgb-mydb',
      { stdout: 'true\n' },
    );
    execState.toolResults.set(
      'docker exec nd-pgb-mydb cat /etc/pgbouncer/pgbouncer.ini',
      { stdout: STATUS_INI.replace('pool_mode = transaction', 'pool_mode=session') },
    );
    const status = await pgbouncerStatusFor(
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
    );
    expect(status.poolMode).toBe('session');
  });

  it('returns poolMode=null when the rendered ini has no pool_mode line', async () => {
    execState.toolResults.set(
      'docker inspect --format {{.State.Running}} nd-pgb-mydb',
      { stdout: 'true\n' },
    );
    execState.toolResults.set(
      'docker exec nd-pgb-mydb cat /etc/pgbouncer/pgbouncer.ini',
      { stdout: STATUS_INI.replace('pool_mode = transaction\n', '') },
    );
    const status = await pgbouncerStatusFor(
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
    );
    expect(status.running).toBe(true);
    expect(status.poolMode).toBeNull();
  });

  it('returns poolMode=null when reading the ini fails (best-effort)', async () => {
    execState.toolResults.set(
      'docker inspect --format {{.State.Running}} nd-pgb-mydb',
      { stdout: 'true\n' },
    );
    execState.toolResults.set(
      'docker exec nd-pgb-mydb cat /etc/pgbouncer/pgbouncer.ini',
      { throw: new Error('no such container') },
    );
    const status = await pgbouncerStatusFor(
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
    );
    expect(status.running).toBe(true);
    expect(status.poolMode).toBeNull();
  });

  it('returns running=false (and no pooled URL) when the container is down', async () => {
    execState.toolResults.set(
      'docker inspect --format {{.State.Running}} nd-pgb-mydb',
      { stdout: 'false\n' },
    );
    const status = await pgbouncerStatusFor(
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
    );
    expect(status.running).toBe(false);
    expect(status.pooledConnectionString).toBeNull();
  });

  it('returns running=false when the running-inspect throws (container gone)', async () => {
    execState.toolResults.set(
      'docker inspect --format {{.State.Running}} nd-pgb-mydb',
      { throw: new Error('No such object: nd-pgb-mydb') },
    );
    const status = await pgbouncerStatusFor(
      buildDb({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' }),
    );
    expect(status.running).toBe(false);
  });

  // vitest shims CJS `require` in its module runner, so the original defect
  // (a lazy require of 'node:crypto' inside renderUserlist) crashed only in
  // production ESM (`node dist/server.js`) and was invisible to this suite.
  // The durable guard is therefore source-level: this package is pure ESM,
  // so no module here may ever invoke CJS require syntax.
  describe('ESM purity (r007 regression)', () => {
    it('never references CJS require — the runtime is `node dist/server.js`', async () => {
      const src = await readFile(
        new URL('../../src/lib/pgbouncer.ts', import.meta.url),
        'utf8',
      );
      expect(src).not.toMatch(/\brequire\s*\(/);
    });
  });
});
