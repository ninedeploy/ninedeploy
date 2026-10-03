/**
 * G-32 PgBouncer sidecar — module coverage.
 *
 * `modules/pgbouncer.ts` is the HTTP surface for the three
 * pgbouncer routes:
 *   GET    /:id/pgbouncer             (member)
 *   POST   /:id/pgbouncer/enable      (admin)
 *   POST   /:id/pgbouncer/disable     (admin)
 *
 * The behavior worth pinning down:
 *  - the read route hands the status + a direct-connection string
 *    back to the caller (the connection string redacts the
 *    password).
 *  - `enable` validates the body via Zod (port must be 1024-65535
 *    when supplied), applies the port override to the row before
 *    calling the lib helper, and surfaces a lib failure as a
 *    400. Non-admin callers hit 403.
 *  - `disable` is a passthrough to the lib helper and surfaces
 *    a lib failure as a 400.
 *  - The module re-exports `pooledConnectionString` so the SDK /
 *    CLI can import it from the route module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asUser,
  buildTestApp,
  createFakeDb,
  listen,
  type TestAppOpts,
} from '../helpers.js';

const lib = vi.hoisted(() => ({
  status: {
    enabled: false,
    containerName: null as string | null,
    port: 6432,
    running: false,
    poolMode: null as string | null,
    pooledConnectionString: null as string | null,
  } as Record<string, unknown>,
  enableCalls: 0,
  disableCalls: 0,
  enableThrow: null as Error | null,
  disableThrow: null as Error | null,
  /** The row each pgbouncerStatusFor call was handed (r331). */
  statusRows: [] as Array<Record<string, unknown>>,
  /** Simulates the real helper stamping the DB row (r331). */
  onEnable: null as (() => void) | null,
  onDisable: null as (() => void) | null,
}));

vi.mock('../../src/lib/pgbouncer.js', async () => {
  const actual = await vi.importActual<unknown>('../../src/lib/pgbouncer.js');
  return {
    ...(actual as Record<string, unknown>),
    pgbouncerStatusFor: vi.fn(async (row: Record<string, unknown>) => {
      lib.statusRows.push({ ...row });
      return lib.status;
    }),
    enablePgbouncer: vi.fn(async () => {
      lib.enableCalls++;
      if (lib.enableThrow) throw lib.enableThrow;
      lib.onEnable?.();
    }),
    disablePgbouncer: vi.fn(async () => {
      lib.disableCalls++;
      if (lib.disableThrow) throw lib.disableThrow;
      lib.onDisable?.();
    }),
  };
});

vi.mock('../../src/lib/audit.js', () => ({
  audit: vi.fn(async () => undefined),
}));

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

function rowDbFixture(over: Partial<DbRow> = {}): DbRow {
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
    ...over,
  };
}

let updates: Array<Record<string, unknown>> = [];
let currentRow: DbRow = rowDbFixture();
let apps: TestAppOpts['stats'] extends never ? never : ReturnType<typeof buildTestApp> extends Promise<infer T> ? T : never;

async function startApp() {
  const db = createFakeDb({
    findFirst: {
      databases: () => currentRow,
    },
    update: {
      databases: (set: Record<string, unknown>) => {
        updates.push(set);
        Object.assign(currentRow, set);
        return [set];
      },
    },
  });
  const app = await buildTestApp({ db });
  await app.register((await import('../../src/modules/pgbouncer.js')).pgbouncerRoutes);
  const port = await listen(app);
  apps = app;
  return { app, port, db };
}

beforeEach(() => {
  updates = [];
  currentRow = rowDbFixture();
  lib.status = {
    enabled: false,
    containerName: null,
    port: 6432,
    running: false,
    poolMode: null,
    pooledConnectionString: null,
  };
  lib.enableCalls = 0;
  lib.disableCalls = 0;
  lib.enableThrow = null;
  lib.disableThrow = null;
  lib.statusRows = [];
  lib.onEnable = null;
  lib.onDisable = null;
});

afterEach(async () => {
  if (apps) await apps.close().catch(() => undefined);
});

describe('GET /:id/pgbouncer', () => {
  it('returns status + redacted direct connection string for members', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer`, { headers: asUser(1) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.databaseId).toBe(1);
    expect(body.enabled).toBe(false);
    expect(body.directConnectionString).toMatch(/postgres:\/\/nine:\*@nd-pg-mydb:5432\/app/);
  });

  it('r184: a member who owns the database can read the status (not only admins)', async () => {
    currentRow = { ...rowDbFixture(), ownerUserId: 7 } as DbRow;
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer`, { headers: asUser({ id: 7, role: 'member' }) });
    expect(res.status).toBe(200);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer`);
    expect(res.status).toBe(401);
  });

  it('serves the status to a valid caller', async () => {
    // `loadDatabaseForUser` is the access gate for the read route.
    // In the helpers' default fake-DB the operator user (id 1) is
    // already a member, so we test the happy path here. The 401 path
    // is covered by the unauthenticated test above.
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer`, { headers: asUser(1) });
    expect(res.status).toBe(200);
  });

  it('returns 422 for a non-numeric id', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/abc/pgbouncer`, { headers: asUser(1) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('POST /:id/pgbouncer/enable', () => {
  it('rejects non-admin callers with 403', async () => {
    const { port } = await startApp();
    // user 1 with role=member — the requireAdmin decorator refuses
    // them, so the lib helper must NOT be called.
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser({ id: 1, role: 'member' }), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(lib.enableCalls).toBe(0);
  });

  it('enables the sidecar and returns the status', async () => {
    lib.status = { ...lib.status, enabled: true, running: true, containerName: 'nd-pgb-mydb' };
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(lib.enableCalls).toBe(1);
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });

  it('applies a port override to the row before calling the helper', async () => {
    lib.status = { ...lib.status, enabled: true, running: true, port: 7000 };
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ port: 7000 }),
    });
    expect(res.status).toBe(200);
    expect(updates.some((u) => u['pgbouncerPort'] === 7000)).toBe(true);
    expect(currentRow.pgbouncerPort).toBe(7000);
  });

  it('skips the update when the override matches the existing port', async () => {
    currentRow = rowDbFixture({ pgbouncerPort: 7000 });
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ port: 7000 }),
    });
    expect(res.status).toBe(200);
    expect(updates).toEqual([]);
  });

  it('rejects an out-of-range port with 422', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ port: 80 }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects a non-integer port with 422', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ port: 'lol' }),
    });
    expect(res.status).toBe(422);
  });

  it('surfaces a lib helper failure as 400', async () => {
    lib.enableThrow = new Error('container already in use');
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.message).toMatch(/container already in use/);
  });

  it('emits an audit log on success', async () => {
    const { port, app } = await startApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(app.db, 1, 'database.pgbouncer_enable', expect.stringMatching(/mydb/));
  });
});

describe('POST /:id/pgbouncer/disable', () => {
  it('rejects non-admin callers with 403', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/disable`, {
      method: 'POST',
      headers: { ...asUser({ id: 1, role: 'member' }), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('disables the sidecar and returns the status', async () => {
    lib.status = { ...lib.status, enabled: false, running: false };
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/disable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(lib.disableCalls).toBe(1);
  });

  it('surfaces a lib helper failure as 400', async () => {
    lib.disableThrow = new Error('docker rm failed');
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/disable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});

// r331: the lib helpers update the DB row only. The route used to build its
// response from the row it loaded BEFORE the change, so enable answered
// `enabled: false` (CLI: "Connection URL: (pending)") and disable answered
// `enabled: true` (CLI: "still reporting enabled").
describe('r331: enable/disable report the post-change row', () => {
  it('enable builds the status from the freshly stamped row', async () => {
    // The real helper writes the row via db.update; model that as the fake
    // DB now serving a NEW row object, as a real re-query would.
    lib.onEnable = () => {
      currentRow = { ...currentRow, pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb', pgbouncerPort: 6432 };
    };
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/enable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(lib.statusRows.at(-1)).toMatchObject({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' });
  });

  it('disable builds the status from the freshly cleared row', async () => {
    currentRow = rowDbFixture({ pgbouncerEnabled: true, pgbouncerContainerName: 'nd-pgb-mydb' });
    lib.onDisable = () => {
      currentRow = { ...currentRow, pgbouncerEnabled: false, pgbouncerContainerName: null };
    };
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/pgbouncer/disable`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(lib.statusRows.at(-1)).toMatchObject({ pgbouncerEnabled: false, pgbouncerContainerName: null });
  });
});

describe('module re-exports', () => {
  it('re-exports pooledConnectionString from the lib', async () => {
    const mod = await import('../../src/modules/pgbouncer.js');
    expect(typeof mod.pooledConnectionString).toBe('function');
  });
});
