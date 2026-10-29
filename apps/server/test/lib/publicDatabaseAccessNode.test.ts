/**
 * ROADMAP item 10: lib/publicDatabaseAccess.ts for a database on a node,
 * against a migrated SQLite. The node calls (lib/nodePublicDatabaseAccess.ts)
 * are a fake; their own behaviour is tested in nodePublicDatabaseAccess.test.ts.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, databasePublicAccess, databases, servers, services, type DB } from '@ninedeploy/db';

const h = vi.hoisted(() => ({
  applies: [] as Array<Record<string, unknown>>,
  removes: [] as string[],
  applyError: [] as Array<Error | null>,
  removeError: null as Error | null,
  running: true as boolean | null,
  support: null as Error | null,
}));
// The panel's own Docker is never reached: the reconcile below must not see (or sweep) this machine's containers.
vi.mock('../../src/lib/exec.js', () => ({ capture: vi.fn(async () => ''), run: vi.fn(async () => undefined), sleep: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/nodePublicDatabaseAccess.js', () => ({
  assertNodePublicAccessSupport: vi.fn(async () => {
    if (h.support) throw h.support;
  }),
  nodeApplySidecar: vi.fn(async (_db: unknown, _serverId: number, input: Record<string, unknown>) => {
    h.applies.push(input);
    const err = h.applyError.shift();
    if (err) throw err;
    return { mode: h.applies.length > 1 ? 'hot' : 'started' };
  }),
  nodeRemoveSidecar: vi.fn(async (_db: unknown, _serverId: number, slug: string) => {
    if (h.removeError) throw h.removeError;
    h.removes.push(slug);
  }),
  nodeSidecarRunning: vi.fn(async () => h.running),
}));

const lib = await import('../../src/lib/publicDatabaseAccess.js');
const { HttpError } = await import('../../src/lib/errors.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

let db: DB;
let nodeId: number;
let pg: Database;
const log = vi.fn();
const input = (over: Record<string, unknown> = {}) => ({ port: 15432, ipAllowlist: ['203.0.113.7/24'], tlsMode: 'none' as const, ...over });
const opts = { userId: null, log };

beforeEach(async () => {
  db = await migratedDb();
  h.applies.length = 0;
  h.removes.length = 0;
  h.applyError = [];
  h.removeError = null;
  h.running = true;
  h.support = null;
  const [node] = await db.insert(servers).values({ name: 'edge', host: '198.51.100.3', port: 4600, tokenEncrypted: 'x', status: 'online' }).returning();
  nodeId = node!.id;
  [pg] = (await db
    .insert(databases)
    .values({ name: 'shop', slug: 'shop', engine: 'postgres', status: 'running', passwordEncrypted: 'v1:x', serverId: nodeId } as never)
    .returning()) as [Database];
});
afterEach(() => closeMigratedDb(db));

const row = () => db.query.databasePublicAccess.findFirst({ where: eq(databasePublicAccess.databaseId, pg.id) });

describe('a database on a node', () => {
  it('is exposed by the node’s agent, reported at the node’s address, and turned off again', async () => {
    const res = await lib.applyPublicAccess(db, pg, input(), opts);
    expect(res.mode).toBe('started');
    expect(h.applies[0]).toEqual({ databaseId: pg.id, slug: 'shop', container: 'nd-db-shop', enginePort: 5432, port: 15432, allowlist: ['203.0.113.0/24'] });
    expect(await row()).toMatchObject({ enabled: true, publicPort: 15432, tlsMode: 'none', containerName: 'nd-dbpub-shop' });
    expect(await lib.publicAccessStatus(db, pg)).toMatchObject({ enabled: true, status: 'running', publicHost: '198.51.100.3', port: 15432 });
    h.running = null;
    expect((await lib.publicAccessStatus(db, pg)).status).toBe('error');

    expect((await lib.applyPublicAccess(db, pg, input({ ipAllowlist: ['198.51.100.9'] }), opts)).mode).toBe('hot');
    expect(await lib.disablePublicAccess(db, pg, log)).toMatchObject({ enabled: true });
    expect(h.removes).toEqual(['shop']);
    expect(await row()).toMatchObject({ enabled: false, containerName: null });
    expect((await lib.publicAccessStatus(db, pg)).status).toBe('off');
  });

  it('refuses TLS termination, reserved node ports and ports a node service publishes', async () => {
    await expect(lib.applyPublicAccess(db, pg, input({ tlsMode: 'terminate', tlsHostname: 'db.example.com' }), opts)).rejects.toMatchObject({
      statusCode: 422,
      code: 'unsupported_tls_mode',
    });
    for (const port of [4600, 80, 443, 22]) {
      await expect(lib.applyPublicAccess(db, pg, input({ port }), opts)).rejects.toMatchObject({ statusCode: 400, code: 'invalid_port' });
    }
    await expect(lib.applyPublicAccess(db, pg, input({ port: 70 }), opts)).rejects.toMatchObject({ code: 'invalid_port' });
    await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', serverId: nodeId, publishedPort: 18080 } as never);
    await expect(lib.applyPublicAccess(db, pg, input({ port: 18080 }), opts)).rejects.toMatchObject({ statusCode: 409 });
    await db.insert(services).values({
      name: 'tcp', slug: 'tcp', type: 'docker', serverId: nodeId, portMappings: [{ hostPort: 18081, containerPort: 5000, protocol: 'tcp' }],
    } as never);
    await expect(lib.applyPublicAccess(db, pg, input({ port: 18081 }), opts)).rejects.toMatchObject({ statusCode: 409 });
    // A panel-host service on the same port does not bind the node.
    await db.insert(services).values({ name: 'local', slug: 'local', type: 'docker', publishedPort: 18082 } as never);
    expect((await lib.applyPublicAccess(db, pg, input({ port: 18082 }), opts)).mode).toBe('started');
    // Another database's public port is taken panel-wide.
    const [other] = (await db
      .insert(databases)
      .values({ name: 'b', slug: 'b', engine: 'postgres', status: 'running', passwordEncrypted: 'v1:x', serverId: nodeId } as never)
      .returning()) as [Database];
    await expect(lib.applyPublicAccess(db, other, input({ port: 18082 }), opts)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.applies).toHaveLength(1);
  });

  it('refuses a node whose agent cannot do it, before anything changes', async () => {
    h.support = new HttpError(422, 'agent_outdated', 'Update the node agent');
    await expect(lib.applyPublicAccess(db, pg, input(), opts)).rejects.toMatchObject({ code: 'agent_outdated' });
    expect(h.applies).toHaveLength(0);
    expect(await row()).toBeUndefined();
  });

  it('a failed first apply removes what it started; a failed change restores the previous configuration', async () => {
    h.applyError = [new HttpError(409, 'conflict', 'Host port 15432 is not available')];
    await expect(lib.applyPublicAccess(db, pg, input(), opts)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.removes).toEqual(['shop']);
    expect(await row()).toBeUndefined();

    await lib.applyPublicAccess(db, pg, input(), opts);
    h.applies.length = 0;
    const failure = new Error('the public access proxy did not stay running');
    h.applyError = [failure];
    await expect(lib.applyPublicAccess(db, pg, input({ port: 15433 }), opts)).rejects.toBe(failure);
    expect(lib.isApplyFailure(failure)).toBe(true);
    expect(h.applies.map((a) => a['port'])).toEqual([15433, 15432]);
    expect(await row()).toMatchObject({ publicPort: 15432, lastError: 'the public access proxy did not stay running' });
    // The restore failing too is only logged.
    h.applyError = [new Error('down'), new Error('still down')];
    await expect(lib.applyPublicAccess(db, pg, input({ port: 15433 }), opts)).rejects.toThrow('down');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restoring the previous proxy failed'));
  });

  it('turning it off is refused while the node cannot confirm; deleting the database removes it best effort', async () => {
    await lib.applyPublicAccess(db, pg, input(), opts);
    h.removeError = new HttpError(502, 'node_unreachable', 'The node could not be reached');
    await expect(lib.disablePublicAccess(db, pg, log)).rejects.toMatchObject({ code: 'node_unreachable' });
    expect(await row()).toMatchObject({ enabled: true });
    await lib.removePublicAccessSidecar(db, pg, log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('public access sidecar removal failed'));
    h.removeError = null;
    await lib.removePublicAccessSidecar(db, pg, log);
    expect(h.removes).toEqual(['shop']);
    // Without a row nothing is asked of the node.
    await db.delete(databasePublicAccess);
    await lib.removePublicAccessSidecar(db, pg, log);
    expect(h.removes).toEqual(['shop']);
  });

  it('is left to the node by the panel’s reconcile, and reports the node’s address before it is configured', async () => {
    await lib.applyPublicAccess(db, pg, input(), opts);
    h.applies.length = 0;
    expect(await lib.reconcilePublicAccess(db, log)).toEqual({ started: 0, failed: 0, orphansRemoved: 0 });
    expect(h.applies).toHaveLength(0);
    expect(await row()).toMatchObject({ enabled: true, lastError: null });
    await db.delete(databasePublicAccess);
    expect(await lib.publicAccessStatus(db, pg)).toMatchObject({ configured: false, publicHost: '198.51.100.3' });
    expect(await lib.publicHostFor(db, pg, 'ignored.example.com')).toBe('198.51.100.3');
    expect(await lib.publicHostFor(db, { ...pg, serverId: null }, 'db.example.com')).toBe('db.example.com');
    await db.delete(databases).where(eq(databases.id, pg.id));
    await db.delete(servers).where(eq(servers.id, nodeId));
    expect(await lib.publicHostFor(db, pg, null)).toBeNull();
    await expect(lib.assertNodePublicPortAvailable(db, nodeId, 15432, pg.id)).rejects.toMatchObject({ code: 'remote_database' });
  });
});
