import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backups, createDb, databaseAttachments, databases, type DB, runMigrations, servers, serviceTargets, services, users } from '@ninedeploy/db';
import { MULTI_NODE_CAPABILITIES } from '@ninedeploy/schemas';

/**
 * Multi-node T6 (design §5): managed databases on nodes, panel side.
 *
 *  - create / start / stop / restart / limits / logs / storage / delete
 *    through the node's agent, with the rollback marker on the row;
 *  - backups, restores and 0.14 imports over the stream channel into the
 *    panel's backups directory, in the panel host's format;
 *  - the same-host attachment rule (attach, move, fan-out, deploy refusal);
 *  - the refusals (Studio, PgBouncer, public access, operator-only placement,
 *    an existing volume, an offline node) and the server delete guard;
 *  - the status sweep (plugins/nodeDatabases.ts).
 *
 * "No local docker for node rows" (design §5.9): the panel host's `run` /
 * `capture` / pulls THROW in this file; every action must reach the fake node.
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-node-db-'));
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows may still hold a closed libsql file briefly */
  }
});

const h = vi.hoisted(() => ({
  ping: '' as string,
  ops: [] as Array<{ op: string; params: Record<string, unknown> }>,
  unreachable: false,
  /** Containers on the fake node → state. */
  containers: new Map<string, string>(),
  volumes: new Map<string, Record<string, string>>(),
  networks: new Set<string>(),
  local: [] as string[],
  /** What `db.dump` streams; what `db.restore` received. */
  dumpBytes: Buffer.from('-- PostgreSQL database dump\nCREATE TABLE t (id int);\n'),
  restored: [] as Buffer[],
  streams: [] as Array<{ kind: string; params: Record<string, unknown> }>,
}));

vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentTransportSealed: async () => true,
  agentOp: async (_db: unknown, _id: number, op: string, params: Record<string, unknown>, _sink: unknown, opts?: { tolerateExit?: boolean }) => {
    if (h.unreachable) throw new Error('connect ECONNREFUSED 10.0.0.5:4600');
    h.ops.push({ op, params });
    const answer = (exitCode: number, lines: string[] = []) => {
      if (exitCode !== 0 && !opts?.tolerateExit) throw new Error(`agent ${op} exited with ${exitCode}: ${lines.join(' ')}`);
      return { exitCode, lines };
    };
    const name = params['name'] as string;
    switch (op) {
      case 'agent.ping':
        return answer(0, h.ping ? [h.ping] : []);
      case 'docker.inspect':
        return h.containers.has(name) ? answer(0, [`${h.containers.get(name)}|172.20.0.2`]) : answer(1, ['Error: No such object']);
      case 'docker.networkCreate':
        if (h.networks.has(name)) return answer(1, ['network already exists']);
        h.networks.add(name);
        return answer(0);
      case 'docker.networkRm':
        h.networks.delete(name);
        return answer(0);
      case 'docker.volumeInspect':
        return answer(h.volumes.has(name) ? 0 : 1);
      case 'docker.volumeCreate':
        h.volumes.set(name, (params['labels'] as Record<string, string>) ?? {});
        return answer(0, [name]);
      case 'docker.volumeRm':
        h.volumes.delete(name);
        return answer(0);
      case 'docker.volumeList':
        return answer(0, [...h.volumes].map(([n, labels]) => JSON.stringify({ Name: n, Labels: Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',') })));
      case 'docker.pull':
      case 'file.deleteEnv':
        return answer(0);
      case 'file.writeEnv':
        return answer(0, [`wrote .agent-env/${name}.env`]);
      case 'docker.rm':
        h.containers.delete(name);
        return answer(0);
      case 'docker.runSpec':
        h.containers.set(name, 'running');
        return answer(0, ['cid']);
      case 'docker.restart':
        return h.containers.has(name) ? answer(0) : answer(1, ['no such container']);
      case 'docker.logs':
        return answer(0, ['2026-10-09T00:00:00Z ready', '2026-10-09T00:00:01Z accepting connections']);
      case 'db.exec':
        if (params['query'] === 'size') return answer(0, ['4242']);
        if (params['query'] === 'probe') return answer(0, ['1']);
        return answer(0, ['  --sandbox  Disallow commands']);
      case 'docker.networkConnect':
      case 'docker.networkDisconnect':
        return answer(0);
      default:
        throw new Error(`agent ${op} failed (400): {"error":{"code":"unknown_op"}}`);
    }
  },
}));

vi.mock('../src/lib/agentStream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentStream.js')>()),
  openAgentStream: async (_db: unknown, _serverId: number, kind: string, params: Record<string, unknown>) => {
    h.streams.push({ kind, params });
    if (kind === 'db.dump') {
      const readable = new PassThrough();
      const done = new Promise((resolve) => readable.on('end', () => resolve({ bytes: h.dumpBytes.length, sha256: 'x', result: {} })));
      setImmediate(() => readable.end(h.dumpBytes));
      return { kind, direction: 'agent-to-panel', readable, done, abort: () => undefined };
    }
    const writable = new PassThrough();
    writable.on('data', (c: Buffer) => h.restored.push(Buffer.from(c)));
    const done = new Promise((resolve) => writable.on('finish', () => resolve({ bytes: 0, sha256: '', result: {} })));
    return { kind, direction: 'panel-to-agent', writable, done, abort: () => undefined };
  },
}));

// The panel host must never be touched for a node database.
const forbidden = (what: string) => {
  h.local.push(what);
  throw new Error(`local docker must not run: ${what}`);
};
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  run: async (cmd: string, args: string[]) => forbidden(`${cmd} ${args.join(' ')}`),
  capture: async (cmd: string, args: string[]) => forbidden(`${cmd} ${args.join(' ')}`),
  sleep: async () => undefined,
}));
vi.mock('../src/lib/dockerPull.js', () => ({
  pullDockerImage: async (image: string) => forbidden(`pull ${image}`),
  ensureDockerImage: async (image: string) => forbidden(`ensure ${image}`),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/backupRemote.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/backupRemote.js')>()),
  uploadBackup: vi.fn(async () => undefined),
  deleteRemoteBackupForRetention: vi.fn(async () => 'deleted'),
}));
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { config: { ...actual.config, paths: { ...actual.config.paths, backupsDir: tmp, dataDir: tmp } } };
});

const caps = await import('../src/lib/agentCapabilities.js');
const { databasesRoutes, attachmentRoutes } = await import('../src/modules/databases.js');
const { databaseBackupRoutes } = await import('../src/modules/backups.js');
const { pgbouncerRoutes } = await import('../src/modules/pgbouncer.js');
const { databasePublicAccessRoutes } = await import('../src/modules/databasePublicAccess.js');
const { serverRoutes } = await import('../src/modules/servers.js');
const { remoteDatabaseRefusal } = await import('../src/lib/remoteDeploy.js');
const { attachedDatabasesHostMismatch } = await import('../src/lib/remoteDatabaseRefusal.js');
const { databaseRuntime } = await import('../src/lib/databaseRuntime.js');
const { connectServiceToNodeDatabases, nodeReachability, resetNodeReachability } = await import('../src/lib/nodeDatabase.js');
const { sweepNodeDatabases } = await import('../src/plugins/nodeDatabases.js');
const { createBackupReadStream, stageForRestore } = await import('../src/engine/database.js');
const { sniffFile } = await import('../src/lib/databaseImport.js');
const { encrypt, decrypt } = await import('../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const CAPS_ALL = `ND-AGENT ${JSON.stringify({ version: '0.15.3', caps: ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host', ...MULTI_NODE_CAPABILITIES] })}`;

let db: DB;
let closeDb: () => void = () => undefined;
afterEach(() => closeDb());
let serverId: number;
let otherServerId: number;

beforeEach(async () => {
  h.ping = CAPS_ALL;
  h.ops = [];
  h.unreachable = false;
  h.containers.clear();
  h.volumes.clear();
  h.networks.clear();
  h.local = [];
  h.restored = [];
  h.streams = [];
  caps.resetNodeCapabilityCache();
  resetNodeReachability();
  // File-backed: an in-memory libsql client cannot run the delete route's transaction.
  const file = path.join(tmp, `t6-${Math.random().toString(36).slice(2)}.db`).split(path.sep).join('/');
  const created = createDb({ url: `file:${file}` });
  db = created.db;
  closeDb = () => created.client?.close();
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true });
  const [node] = await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' }).returning();
  const [other] = await db.insert(servers).values({ name: 'edge-2', host: '10.0.0.6', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' }).returning();
  serverId = node!.id;
  otherServerId = other!.id;
});

async function appWith(...routes: Array<[Parameters<Awaited<ReturnType<typeof buildTestApp>>['register']>[0], string]>) {
  const app = await buildTestApp({ db });
  for (const [plugin, prefix] of routes) await app.register(plugin, { prefix });
  return app;
}

const ops = () => h.ops.map((o) => o.op);
const opParams = (op: string) => h.ops.filter((o) => o.op === op).map((o) => o.params);

async function createOnNode(app: Awaited<ReturnType<typeof buildTestApp>>, body: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/databases', headers: asUser(), payload: { name: 'orders', engine: 'postgres', serverId, ...body } });
}

describe('POST /v1/databases with serverId: the database runs on the node', () => {
  it('creates the network, the volume and the container on the node; the row carries the rollback marker', async () => {
    const app = await appWith([databasesRoutes, '/databases']);
    const res = await createOnNode(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ slug: 'orders', status: 'running', host: 'nd-db-orders', port: 5432, containerName: 'nd-db-orders', volumeName: 'nd-db-orders-data', serverId, serverName: 'edge-1', reachable: null });
    expect(body.connectionString).toMatch(/^postgres:\/\/nine:.+@nd-db-orders:5432\/app$/);
    const row = (await db.query.databases.findFirst({ where: eq(databases.slug, 'orders') }))!;
    expect(row).toMatchObject({ containerName: null, volumeName: null, serverId, nodeContainerName: 'nd-db-orders', nodeVolumeName: 'nd-db-orders-data', status: 'running' });
    expect(row.initializedAt).toBeInstanceOf(Date);
    // Capability (one ping), the route's volume check, the adoption gate, then the start sequence (design §5.4).
    expect(ops()).toEqual([
      'agent.ping',
      'docker.volumeInspect',
      'docker.volumeInspect',
      'docker.inspect',
      'docker.networkCreate',
      'docker.volumeInspect',
      'docker.volumeCreate',
      'docker.pull',
      'docker.rm',
      'file.writeEnv',
      'docker.runSpec',
      'file.deleteEnv',
    ]);
    expect(opParams('docker.volumeCreate')[0]).toMatchObject({
      name: 'nd-db-orders-data',
      labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.slug': 'orders', 'ninedeploy.database.engine': 'postgres', 'ninedeploy.database.id': String(row.id) },
    });
    expect(opParams('file.writeEnv')[0]).toEqual({ name: 'nd-db-orders', env: { POSTGRES_USER: 'nine', POSTGRES_PASSWORD: decrypt(row.passwordEncrypted), POSTGRES_DB: 'app' } });
    // O7: its own bridge only, never the node's shared `ninedeploy` network.
    expect(opParams('docker.runSpec')[0]).toEqual({
      name: 'nd-db-orders',
      image: 'postgres:18',
      restart: 'unless-stopped',
      network: 'nd-dbnet-orders',
      volumes: [{ name: 'nd-db-orders-data', mount: '/var/lib/postgresql' }],
      labels: { 'ninedeploy.database.slug': 'orders', 'ninedeploy.database.id': String(row.id) },
      managed: 'database',
      envFile: '.agent-env/nd-db-orders.env',
    });
    // The agent's own validator accepts the spec as sent.
    const { parseRunSpec, runSpecArgv } = await import('../src/agentOps/runSpec.js');
    expect(runSpecArgv(parseRunSpec(opParams('docker.runSpec')[0]!), 'run')).toEqual([
      'run', '-d', '--name', 'nd-db-orders', '--restart', 'unless-stopped', '--network', 'nd-dbnet-orders',
      '--label', 'ninedeploy.managed=database', '--label', `ninedeploy.database.id=${row.id}`, '--label', 'ninedeploy.database.slug=orders',
      '-v', 'nd-db-orders-data:/var/lib/postgresql', '--env-file', '.agent-env/nd-db-orders.env', 'postgres:18',
    ]);
    expect(h.local).toEqual([]);
  });

  it('redis: the password follows the image as --requirepass (r644), no env file; limits ride the spec', async () => {
    const app = await appWith([databasesRoutes, '/databases']);
    expect((await createOnNode(app, { name: 'cache', engine: 'redis' })).statusCode).toBe(200);
    const spec = opParams('docker.runSpec')[0]!;
    const row = (await db.query.databases.findFirst({ where: eq(databases.slug, 'cache') }))!;
    expect(spec['cmd']).toEqual(['--requirepass', decrypt(row.passwordEncrypted)]);
    expect(spec['envFile']).toBeUndefined();
    expect(ops()).not.toContain('file.writeEnv');
    // PATCH limits: rm + a fresh runSpec with the limits.
    h.ops = [];
    const limits = await app.inject({ method: 'PATCH', url: `/databases/${row.id}/limits`, headers: asUser(), payload: { memLimitMb: 256, cpuLimitMilli: 500 } });
    expect(limits.statusCode).toBe(200);
    expect(ops()).toEqual(expect.arrayContaining(['docker.rm', 'docker.runSpec']));
    expect(opParams('docker.runSpec')[0]).toMatchObject({ memLimitMb: 256, cpuLimitMilli: 500 });
    expect(h.local).toEqual([]);
  });

  it('refusals: operator-only placement (403), an existing volume (409), an offline node (409), adoption of a named volume (422), a 0.15 agent (422)', async () => {
    const app = await appWith([databasesRoutes, '/databases']);
    const member = await app.inject({ method: 'POST', url: '/databases', headers: asUser({ isOperator: false }), payload: { name: 'orders', engine: 'postgres', serverId } });
    expect([member.statusCode, member.json().error.code]).toEqual([403, 'node_placement_operator_only']);
    h.volumes.set('nd-db-orders-data', {});
    const exists = await createOnNode(app);
    expect([exists.statusCode, exists.json().error.code]).toEqual([409, 'node_volume_exists']);
    expect(ops()).not.toContain('docker.runSpec');
    h.volumes.clear();
    const adopt = await createOnNode(app, { existingVolume: 'nd-db-old-data' });
    expect([adopt.statusCode, adopt.json().error.code]).toEqual([422, 'node_volume_adoption_refused']);
    await db.update(servers).set({ status: 'offline' }).where(eq(servers.id, serverId));
    const offline = await createOnNode(app);
    expect([offline.statusCode, offline.json().error.code]).toEqual([409, 'server_not_online']);
    expect(await db.select().from(databases)).toEqual([]);
    expect(h.local).toEqual([]);
  });

  it('a failed start leaves the row in error; the retry (reuseExisting) reuses its own volume, never a foreign one', async () => {
    const app = await appWith([databasesRoutes, '/databases']);
    const realRunSpec = h.containers.set.bind(h.containers);
    h.containers.set = ((n: string, s: string) => (n === 'nd-db-orders' ? (() => { throw new Error('boom'); })() : realRunSpec(n, s))) as never;
    const failed = await createOnNode(app, { reuseExisting: true });
    h.containers.set = realRunSpec as never;
    expect(failed.statusCode).toBe(400);
    expect((await db.query.databases.findFirst())!.status).toBe('error');
    expect(h.volumes.get('nd-db-orders-data')).toBeDefined();
    const retried = await createOnNode(app, { reuseExisting: true });
    expect(retried.statusCode).toBe(200);
    expect((await db.query.databases.findFirst())!.status).toBe('running');
    // A foreign volume under the name is never adopted on a retry either.
    await db.update(databases).set({ status: 'error', initializedAt: null });
    h.volumes.set('nd-db-orders-data', { 'ninedeploy.database.id': '999' });
    h.containers.clear();
    const foreign = await createOnNode(app, { reuseExisting: true });
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([409, 'node_volume_exists']);
  });
});

/** A node database row as the create route writes it, running on the fake node. */
async function nodeRow(values: Record<string, unknown> = {}) {
  const [d] = await db
    .insert(databases)
    .values({
      name: 'orders',
      slug: 'orders',
      engine: 'postgres',
      status: 'running',
      containerName: null,
      volumeName: null,
      serverId,
      nodeContainerName: 'nd-db-orders',
      nodeVolumeName: 'nd-db-orders-data',
      internalHost: 'nd-db-orders',
      internalPort: 5432,
      passwordEncrypted: encrypt('pw-orders'),
      ownerUserId: 1,
      initializedAt: new Date(),
      ...values,
    } as never)
    .returning();
  h.containers.set('nd-db-orders', 'running');
  h.volumes.set('nd-db-orders-data', { 'ninedeploy.database.id': String(d!.id) });
  h.networks.add('nd-dbnet-orders');
  return d!;
}

describe('lifecycle routes on a node database: every action reaches the node, none the panel host', () => {
  it('stop, start, restart, logs, storage and credentials', async () => {
    const d = await nodeRow();
    const app = await appWith([databasesRoutes, '/databases'], [databaseBackupRoutes, '/databases']);
    const call = (method: 'GET' | 'POST', url: string) => app.inject({ method, url: `/databases/${d.id}${url}`, headers: asUser() });

    expect((await call('POST', '/stop')).statusCode).toBe(200);
    expect(h.containers.has('nd-db-orders')).toBe(false);
    expect((await db.query.databases.findFirst())!.status).toBe('stopped');
    expect((await call('POST', '/start')).statusCode).toBe(200);
    expect(h.containers.get('nd-db-orders')).toBe('running');
    h.ops = [];
    expect((await call('POST', '/restart')).statusCode).toBe(200);
    expect(opParams('docker.restart')).toEqual([{ name: 'nd-db-orders' }]);
    expect((await call('GET', '/logs?lines=1')).json()).toEqual({ logs: ['2026-10-09T00:00:01Z accepting connections'] });
    expect((await call('GET', '/storage')).json()).toEqual({ sizeBytes: 4242 });
    expect(opParams('db.exec')[0]).toEqual({ container: 'nd-db-orders', engine: 'postgres', query: 'size', password: 'pw-orders' });
    const creds = (await call('GET', '/credentials')).json();
    expect(creds).toMatchObject({ internalHost: 'nd-db-orders', connectionString: 'postgres://nine:pw-orders@nd-db-orders:5432/app' });
    expect(h.local).toEqual([]);
  });

  it('Studio, PgBouncer and public access answer 422 remote_database and touch nothing', async () => {
    const d = await nodeRow();
    const app = await appWith([databasesRoutes, '/databases'], [pgbouncerRoutes, '/databases'], [databasePublicAccessRoutes, '/databases']);
    h.ops = [];
    for (const [method, url, payload] of [
      ['POST', 'studio', {}],
      ['POST', 'pgbouncer/enable', {}],
      ['PUT', 'public-access', { enabled: true, port: 25432, ipAllowlist: ['203.0.113.0/24'], tlsMode: 'none' }],
    ] as const) {
      const res = await app.inject({ method, url: `/databases/${d.id}/${url}`, headers: asUser(), payload });
      expect([url, res.statusCode, res.json().error.code]).toEqual([url, 422, 'remote_database']);
    }
    expect((await app.inject({ method: 'DELETE', url: `/databases/${d.id}/studio`, headers: asUser() })).statusCode).toBe(200);
    expect(h.ops).toEqual([]);
    expect(h.local).toEqual([]);
  });

  it('delete: the container and its bridge go, the volume stays unless purged; an unreachable node keeps the row unless forced', async () => {
    const d = await nodeRow();
    const app = await appWith([databasesRoutes, '/databases']);
    h.unreachable = true;
    const down = await app.inject({ method: 'DELETE', url: `/databases/${d.id}`, headers: asUser() });
    expect([down.statusCode, down.json().error.code]).toEqual([502, 'node_unreachable']);
    expect(await db.select().from(databases)).toHaveLength(1);
    h.unreachable = false;
    expect((await app.inject({ method: 'DELETE', url: `/databases/${d.id}`, headers: asUser() })).json()).toEqual({ ok: true });
    expect(h.containers.has('nd-db-orders')).toBe(false);
    expect(h.networks.has('nd-dbnet-orders')).toBe(false);
    expect(h.volumes.has('nd-db-orders-data')).toBe(true);
    expect(await db.select().from(databases)).toHaveLength(0);

    const again = await nodeRow();
    expect((await app.inject({ method: 'DELETE', url: `/databases/${again.id}?purgeVolume=true`, headers: asUser() })).statusCode).toBe(200);
    expect(h.volumes.has('nd-db-orders-data')).toBe(false);

    const forced = await nodeRow();
    h.unreachable = true;
    const res = await app.inject({ method: 'DELETE', url: `/databases/${forced.id}?force=true`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toMatch(/nd-db-orders .*may still run on node/);
    expect(h.local).toEqual([]);
  });
});

describe('backups, restores and imports over the stream channel', () => {
  it('a manual backup lands in the backups directory encrypted, the row records the node; it decrypts to the dump and restores back', async () => {
    const d = await nodeRow();
    const app = await appWith([databaseBackupRoutes, '/databases']);
    const res = await app.inject({ method: 'POST', url: `/databases/${d.id}/backups`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    const [b] = await db.select().from(backups);
    expect(b).toMatchObject({ databaseId: d.id, scope: 'db', status: 'completed', serverId });
    expect(h.streams[0]).toEqual({ kind: 'db.dump', params: { container: 'nd-db-orders', engine: 'postgres', password: 'pw-orders' } });
    // Encrypted at rest (never the plaintext dump on disk) …
    expect(readFileSync(b!.path).includes(h.dumpBytes)).toBe(false);
    // … in the panel host's envelope: the local restore path and the 0.14
    // import's format detection read it exactly like a panel dump (format test).
    const chunks: Buffer[] = [];
    for await (const c of await createBackupReadStream(b!.path)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(h.dumpBytes);
    const staged = await stageForRestore(b!.path);
    expect(await sniffFile(staged.path)).toMatchObject({ kind: 'text' });
    staged.cleanup();

    const restore = await app.inject({ method: 'POST', url: `/databases/${d.id}/backups/${b!.id}/restore`, headers: asUser() });
    expect(restore.statusCode).toBe(200);
    expect(h.streams[1]).toEqual({ kind: 'db.restore', params: { container: 'nd-db-orders', engine: 'postgres', password: 'pw-orders', mode: 'restore' } });
    expect(Buffer.concat(h.restored)).toEqual(h.dumpBytes);
    expect(h.local).toEqual([]);
  });

  it('a panel-host dump file restores into a node database (the reverse direction), and an unsupported engine refuses as on the panel', async () => {
    const d = await nodeRow();
    const plain = path.join(tmp, 'legacy.dump');
    writeFileSync(plain, 'SELECT 1;\n');
    await databaseRuntime(db, d).restore(plain, () => undefined);
    expect(Buffer.concat(h.restored).toString()).toBe('SELECT 1;\n');
    const ch = await nodeRow({ name: 'ch', slug: 'ch', engine: 'clickhouse', nodeContainerName: 'nd-db-ch', nodeVolumeName: 'nd-db-ch-data' });
    await expect(databaseRuntime(db, ch).backup(path.join(tmp, 'ch.dump'), () => undefined)).rejects.toThrow('backup not supported for clickhouse');
    await expect(databaseRuntime(db, ch).restore(plain, () => undefined)).rejects.toThrow('restore not supported for clickhouse');
  });

  it('0.14 import: the safety backup and the import under one lock, plan fields on the stream, the probe on the node', async () => {
    const d = await nodeRow();
    const file = path.join(tmp, 'import.sql');
    writeFileSync(file, 'CREATE TABLE x (id int);\n');
    const order: string[] = [];
    await databaseRuntime(db, d).import(
      file,
      {
        format: 'pg_plain',
        singleTransaction: true,
        sandboxFlag: null,
        safetyBackup: { file: path.join(tmp, 'pre.dump'), onDone: async () => void order.push('done'), onFailed: async () => void order.push('failed') },
      },
      () => undefined,
    );
    expect(order).toEqual(['done']);
    expect(h.streams.map((s) => s.kind)).toEqual(['db.dump', 'db.restore']);
    expect(h.streams[1]!.params).toEqual({ container: 'nd-db-orders', engine: 'postgres', password: 'pw-orders', mode: 'import', format: 'pg_plain', singleTransaction: true, sandboxFlag: null });
    expect(Buffer.concat(h.restored).toString()).toBe('CREATE TABLE x (id int);\n');
    expect(await databaseRuntime(db, d).probeCredentials(1, 0)).toBe(true);
    expect(await databaseRuntime(db, { ...d, engine: 'mariadb' }).probeMysqlSandboxFlag()).toBe('--sandbox');
    expect(h.local).toEqual([]);
  });
});

describe('the 0.14 import job on a node database', () => {
  it('safety backup on the node (recorded with the node), the dump over the stream, the credential probe on the node', async () => {
    const { databaseImports } = await import('@ninedeploy/db');
    const { runImportJob } = await import('../src/lib/databaseImport.js');
    const d = await nodeRow();
    const staged = path.join(tmp, `import-${d.id}.sql`);
    const sql = 'CREATE TABLE imported (id int);';
    writeFileSync(staged, sql);
    const [row] = await db
      .insert(databaseImports)
      .values({ databaseId: d.id, source: 'upload', status: 'running', format: 'pg_plain', sizeBytes: 32, receivedBytes: 32, stagingPath: staged, options: {}, createdByUserId: 1 } as never)
      .returning();
    await runImportJob(db, row!.id, { actorId: 1, isOperator: true, sandboxFlag: null });
    const done = (await db.select().from(databaseImports))[0]!;
    expect(done).toMatchObject({ status: 'completed', error: null });
    expect(h.streams.map((x) => x.kind)).toEqual(['db.dump', 'db.restore']);
    expect(h.streams[1]!.params).toMatchObject({ mode: 'import', format: 'pg_plain', container: 'nd-db-orders' });
    expect(Buffer.concat(h.restored).toString()).toBe(sql);
    const [safety] = await db.select().from(backups);
    expect(safety).toMatchObject({ label: 'pre-import', status: 'completed', serverId });
    expect(done.safetyBackupId).toBe(safety!.id);
    expect(opParams('db.exec').map((p) => p['query'])).toContain('probe');
    expect(h.local).toEqual([]);
  });
});

describe('the same-host rule (design §5.5, O2)', () => {
  const svc = async (values: Record<string, unknown>) =>
    (await db.insert(services).values({ name: 'web', slug: `web-${Math.random().toString(36).slice(2, 8)}`, type: 'docker', image: 'nginx', ownerUserId: 1, ...values } as never).returning())[0]!;

  it('attach: 409 attachment_host_mismatch across hosts; same node attaches; fan-out targets refused', async () => {
    const d = await nodeRow();
    const app = await appWith([attachmentRoutes, '/services']);
    const panel = await svc({});
    const other = await svc({ serverId: otherServerId });
    for (const s of [panel, other]) {
      const res = await app.inject({ method: 'POST', url: `/services/${s.id}/attachments`, headers: asUser(), payload: { databaseId: d.id } });
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'attachment_host_mismatch']);
      expect(res.json().error.message).toMatch(/runs on (the panel host|node "edge-2").*database "orders" runs on node "edge-1"/);
    }
    const fan = await svc({ serverId });
    await db.insert(serviceTargets).values({ serviceId: fan.id, serverId: otherServerId, status: 'idle' });
    const fanRes = await app.inject({ method: 'POST', url: `/services/${fan.id}/attachments`, headers: asUser(), payload: { databaseId: d.id } });
    expect([fanRes.statusCode, fanRes.json().error.code]).toEqual([409, 'fanout_database_host']);
    const same = await svc({ serverId, runtimeId: 'web-7' });
    const ok = await app.inject({ method: 'POST', url: `/services/${same.id}/attachments`, headers: asUser(), payload: { databaseId: d.id } });
    expect(ok.statusCode).toBe(200);
    expect(await db.select().from(databaseAttachments)).toHaveLength(1);
    // Detach takes the service's container off the database's bridge on the node.
    h.ops = [];
    expect((await app.inject({ method: 'DELETE', url: `/services/${same.id}/attachments/${ok.json().id}`, headers: asUser() })).statusCode).toBe(200);
    expect(h.ops).toEqual([{ op: 'docker.networkDisconnect', params: { network: 'nd-dbnet-orders', container: 'web-7' } }]);
    expect(h.local).toEqual([]);
  });

  it('the manifest (database.ref) attaches a node database only to a service on that node, with a warning otherwise', async () => {
    const { applyManifestToService } = await import('../src/lib/applyManifestToService.js');
    await nodeRow();
    const manifest = { database: { ref: 'orders', env: 'DATABASE_URL' } } as never;
    const panel = await svc({});
    const skipped = await applyManifestToService(db, panel.id, manifest, 1);
    expect(skipped.databaseAttached).toBe(false);
    expect(skipped.warnings.join(' ')).toMatch(/runs on node #\d+, but this service runs on the panel host; a managed database is reachable only from services on its own host/);
    const onNode = await svc({ serverId });
    expect((await applyManifestToService(db, onNode.id, manifest, 1)).databaseAttached).toBe(true);
    expect((await db.select().from(databaseAttachments)).map((a) => a.serviceId)).toEqual([onNode.id]);
  });

  it('a service never moves away from its node database; a panel-host attachment keeps the 0.15 behaviour', async () => {
    const d = await nodeRow();
    const s = await svc({ serverId });
    await db.insert(databaseAttachments).values({ serviceId: s.id, databaseId: d.id, envAlias: 'DATABASE_URL' });
    expect(await attachedDatabasesHostMismatch(db, s, otherServerId)).toMatchObject({ statusCode: 409, code: 'attachment_host_mismatch' });
    expect(await attachedDatabasesHostMismatch(db, s, null)).toMatchObject({ statusCode: 409 });
    expect(await attachedDatabasesHostMismatch(db, s, serverId)).toBeNull();
  });

  it('remoteDatabaseRefusal: same node passes for a capable agent; another node or the panel host is refused; 0.15 text unchanged', async () => {
    const d = await nodeRow();
    const panelDb = (await db.insert(databases).values({ name: 'pg', slug: 'pg', engine: 'postgres', status: 'running', containerName: 'nd-db-pg', volumeName: 'nd-db-pg-data', passwordEncrypted: encrypt('x') }).returning())[0]!;
    const onNode = await svc({ serverId });
    await db.insert(databaseAttachments).values({ serviceId: onNode.id, databaseId: d.id, envAlias: 'DATABASE_URL' });
    expect(await remoteDatabaseRefusal(db, onNode)).toBeNull();
    // A 0.15 agent cannot host it: the update message.
    h.ping = 'ND-AGENT {"version":"0.15.1","caps":["terminal"]}';
    expect(await remoteDatabaseRefusal(db, onNode)).toMatch(/cannot host a managed database\. Update the node agent to v0\.15\.3/);
    h.ping = CAPS_ALL;
    const elsewhere = await svc({ serverId: otherServerId });
    await db.insert(databaseAttachments).values({ serviceId: elsewhere.id, databaseId: d.id, envAlias: 'DATABASE_URL' });
    expect(await remoteDatabaseRefusal(db, elsewhere)).toMatch(/runs on another node/);
    const legacy = await svc({ serverId });
    await db.insert(databaseAttachments).values({ serviceId: legacy.id, databaseId: panelDb.id, envAlias: 'DATABASE_URL' });
    expect(await remoteDatabaseRefusal(db, legacy)).toBe(
      'Deployments to a remote server are not available for a service with an attached managed database: the database runs on the panel host and its hostname does not resolve on the node. Detach it (use an external database URL) or clear the target server.',
    );
    // r269 template on a capable node: provisioned there by the reconcile; on an older agent the 0.15 refusal + the update hint.
    const tpl = await svc({ serverId, templateDatabaseEnv: { DB_HOST: 'host' } });
    expect(await remoteDatabaseRefusal(db, tpl)).toBeNull();
    h.ping = 'ND-AGENT {"version":"0.15.1","caps":["terminal"]}';
    expect(await remoteDatabaseRefusal(db, tpl)).toMatch(/^Deployments to a remote server are not available for this service: its template provisions a managed database.*Update the node agent to v0\.15\.3/);
  });

  it('the pipeline joins the new container to each same-node database bridge (and fails the deploy when it cannot)', async () => {
    await connectServiceToNodeDatabases(db, serverId, 'web-9', [{ id: 1, slug: 'orders' }], () => undefined);
    expect(h.ops).toEqual([{ op: 'docker.networkConnect', params: { network: 'nd-dbnet-orders', container: 'web-9' } }]);
    h.unreachable = true;
    await expect(connectServiceToNodeDatabases(db, serverId, 'web-9', [{ id: 1, slug: 'orders' }], () => undefined)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('server delete guard (M7) and the servers list', () => {
  it('DELETE /v1/servers/:id answers 409 server_hosts_databases even with ?force=true; the FK is the backstop', async () => {
    await nodeRow();
    const app = await appWith([serverRoutes, '/servers']);
    for (const url of [`/servers/${serverId}`, `/servers/${serverId}?force=true`]) {
      const res = await app.inject({ method: 'DELETE', url, headers: asUser() });
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'server_hosts_databases']);
      expect(res.json().error.message).toMatch(/hosts 1 managed database \("orders" \(#\d+\)\)/);
    }
    expect(await db.select().from(servers)).toHaveLength(2);
    const fk = await db.delete(servers).where(eq(servers.id, serverId)).then(() => null, (e: Error & { cause?: Error }) => e);
    expect(String(fk?.cause?.message ?? fk?.message)).toMatch(/FOREIGN KEY/);
    // A server without databases deletes as before.
    expect((await app.inject({ method: 'DELETE', url: `/servers/${otherServerId}`, headers: asUser() })).statusCode).toBe(200);
    // GET /v1/servers counts the hosted databases (additive).
    const list = (await app.inject({ method: 'GET', url: '/servers', headers: asUser() })).json() as Array<{ id: number; databases: number }>;
    expect(list.find((s) => s.id === serverId)!.databases).toBe(1);
  });

  it('0.16 T7: DELETE /v1/servers/:id answers 409 server_swarm_member for a Swarm member, even with ?force=true; after leave it deletes', async () => {
    const memberId = 'wrk0000000000000000000001';
    await db.update(servers).set({ swarmNodeId: memberId, swarmRole: 'worker' }).where(eq(servers.id, otherServerId));
    const app = await appWith([serverRoutes, '/servers']);
    for (const url of [`/servers/${otherServerId}`, `/servers/${otherServerId}?force=true`]) {
      const res = await app.inject({ method: 'DELETE', url, headers: asUser() });
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'server_swarm_member']);
      expect(res.json().error.message).toMatch(new RegExp(`member of the panel's Docker Swarm \\(node ${memberId}\\).*POST /v1/servers/${otherServerId}/swarm/leave`));
    }
    expect((await db.select().from(servers).where(eq(servers.id, otherServerId))).length).toBe(1);
    // What leave leaves behind: no swarm node id, so the delete goes through.
    await db.update(servers).set({ swarmNodeId: null, swarmRole: null }).where(eq(servers.id, otherServerId));
    expect((await app.inject({ method: 'DELETE', url: `/servers/${otherServerId}`, headers: asUser() })).statusCode).toBe(200);
  });
});

describe('status sweep (plugins/nodeDatabases.ts, design §5.6)', () => {
  it('moves running ↔ error from the node state; an unreachable node changes nothing and reads reachable: false', async () => {
    const d = await nodeRow();
    const stopped = await nodeRow({ name: 'idle', slug: 'idle', status: 'stopped', nodeContainerName: 'nd-db-idle', nodeVolumeName: 'nd-db-idle-data' });
    h.containers.set('nd-db-orders', 'exited');
    expect(await sweepNodeDatabases(db)).toEqual([{ id: d.id, from: 'running', to: 'error' }]);
    expect(nodeReachability(serverId)).toMatchObject({ reachable: true });
    h.containers.set('nd-db-orders', 'running');
    expect(await sweepNodeDatabases(db)).toEqual([{ id: d.id, from: 'error', to: 'running' }]);
    // The operator's stop is never undone, and an unreachable node changes nothing.
    expect((await db.query.databases.findFirst({ where: eq(databases.id, stopped.id) }))!.status).toBe('stopped');
    h.unreachable = true;
    h.containers.delete('nd-db-orders');
    expect(await sweepNodeDatabases(db)).toEqual([]);
    expect((await db.query.databases.findFirst({ where: eq(databases.id, d.id) }))!.status).toBe('running');
    expect(nodeReachability(serverId)).toMatchObject({ reachable: false });
    h.unreachable = false;
    const app = await appWith([databasesRoutes, '/databases']);
    const listed = (await app.inject({ method: 'GET', url: '/databases', headers: asUser() })).json() as Array<{ id: number; reachable: boolean | null; serverName: string | null }>;
    expect(listed.find((r) => r.id === d.id)).toMatchObject({ reachable: false, serverName: 'edge-1' });
    expect(h.local).toEqual([]);
  });
});

describe('0.15.6: keydb and dragonfly on a node', () => {
  const NEW_AGENT = `ND-AGENT ${JSON.stringify({ version: '0.15.6', caps: ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host', ...MULTI_NODE_CAPABILITIES] })}`;

  it('keydb: the spec carries --requirepass then --dir /data (the agent accepts it as sent), no env file, a redis:// URI', async () => {
    h.ping = NEW_AGENT;
    const app = await appWith([databasesRoutes, '/databases']);
    const res = await createOnNode(app, { name: 'kv', engine: 'keydb', version: 'x86_64_v6.3.4' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ engine: 'keydb', port: 6379, serverId, username: null, database: null });
    expect(res.json().connectionString).toMatch(/^redis:\/\/:.+@nd-db-kv:6379$/);
    const row = (await db.query.databases.findFirst({ where: eq(databases.slug, 'kv') }))!;
    const spec = opParams('docker.runSpec')[0]!;
    expect(spec).toMatchObject({ image: 'eqalpha/keydb:x86_64_v6.3.4', volumes: [{ name: 'nd-db-kv-data', mount: '/data' }], managed: 'database' });
    expect(spec['cmd']).toEqual(['--requirepass', decrypt(row.passwordEncrypted), '--dir', '/data']);
    expect(spec['envFile']).toBeUndefined();
    expect(opParams('docker.pull').map((p) => p['image'])).toEqual(['eqalpha/keydb:x86_64_v6.3.4']);
    const { parseRunSpec, runSpecArgv } = await import('../src/agentOps/runSpec.js');
    expect(runSpecArgv(parseRunSpec(spec), 'run').slice(-4)).toEqual(['--requirepass', decrypt(row.passwordEncrypted), '--dir', '/data']);
    expect(h.local).toEqual([]);
  });

  it('dragonfly: only its own image is pulled on the node; the flags ride the spec and pass the agent validator', async () => {
    h.ping = NEW_AGENT;
    const app = await appWith([databasesRoutes, '/databases']);
    const res = await createOnNode(app, { name: 'fly', engine: 'dragonfly' });
    expect(res.statusCode).toBe(200);
    expect(res.json().connectionString).toMatch(/^redis:\/\/:.+@nd-db-fly:6379$/);
    const row = (await db.query.databases.findFirst({ where: eq(databases.slug, 'fly') }))!;
    expect(opParams('docker.pull').map((p) => p['image'])).toEqual([expect.stringMatching(/^ghcr\.io\/dragonflydb\/dragonfly:v\d+\.\d+\.\d+$/)]);
    const spec = opParams('docker.runSpec')[0]!;
    expect(spec['cmd']).toEqual([
      '--requirepass', decrypt(row.passwordEncrypted),
      '--logtostderr', '--dir=/data', '--dbfilename=dump', '--df_snapshot_format=false', '--snapshot_cron=*/15 * * * *',
    ]);
    const { parseRunSpec, runSpecArgv } = await import('../src/agentOps/runSpec.js');
    expect(runSpecArgv(parseRunSpec(spec), 'run')).toContain('--snapshot_cron=*/15 * * * *');
    expect(h.local).toEqual([]);
  });

  it('an agent older than 0.15.6 is told to update, before anything is created; redis is unaffected', async () => {
    const app = await appWith([databasesRoutes, '/databases']);
    for (const engine of ['keydb', 'dragonfly']) {
      const res = await createOnNode(app, { name: `n-${engine}`, engine });
      expect([res.statusCode, res.json().error.code]).toEqual([422, 'node_agent_outdated']);
      const message = res.json().error.message as string;
      expect(message).toContain(`(version 0.15.3) cannot run ${engine} databases.`);
      expect(message).toContain('Update the node agent to v0.15.6 or newer');
    }
    expect(await db.select().from(databases)).toEqual([]);
    expect(ops()).not.toContain('docker.runSpec');
    expect((await createOnNode(app, { name: 'cache', engine: 'redis' })).statusCode).toBe(200);
    expect(h.local).toEqual([]);
  });

  it('backup and restore go over the stream channel with the engine named, in the panel host format', async () => {
    h.ping = NEW_AGENT;
    for (const engine of ['keydb', 'dragonfly'] as const) {
      h.streams = [];
      h.restored = [];
      h.dumpBytes = Buffer.from('REDIS0012-rdb-bytes');
      const d = await nodeRow({ name: engine, slug: engine, engine, internalPort: 6379, nodeContainerName: `nd-db-${engine}`, nodeVolumeName: `nd-db-${engine}-data` });
      const app = await appWith([databaseBackupRoutes, '/databases']);
      const res = await app.inject({ method: 'POST', url: `/databases/${d.id}/backups`, headers: asUser() });
      expect(res.statusCode).toBe(200);
      const [b] = await db.select().from(backups).where(eq(backups.databaseId, d.id));
      expect(h.streams[0]).toEqual({ kind: 'db.dump', params: { container: `nd-db-${engine}`, engine, password: 'pw-orders' } });
      const staged = await stageForRestore(b!.path);
      expect(await sniffFile(staged.path)).toMatchObject({ kind: 'rdb' });
      staged.cleanup();
      const restore = await app.inject({ method: 'POST', url: `/databases/${d.id}/backups/${b!.id}/restore`, headers: asUser() });
      expect(restore.statusCode).toBe(200);
      expect(h.streams[1]).toEqual({ kind: 'db.restore', params: { container: `nd-db-${engine}`, engine, password: 'pw-orders', mode: 'restore' } });
      expect(Buffer.concat(h.restored)).toEqual(h.dumpBytes);
    }
    expect(h.local).toEqual([]);
  });
});
