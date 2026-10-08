/**
 * 0.14 public database access (DESIGN §1) — lib coverage against a real
 * migrated SQLite and a fake Docker CLI. Nothing here reaches a daemon: the
 * exec module is replaced by an in-memory model of `docker run/rm/inspect/ps`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, type Database, databasePublicAccess, databases, services, settings } from '@ninedeploy/db';

const h = vi.hoisted(() => {
  process.env['DOCKER_HOST'] = 'tcp://127.0.0.1:9';
  interface Container {
    running: boolean;
    fp: string;
    port: number;
    source: string;
    dbId: string;
    args: string[];
  }
  return {
    tmp: '',
    containers: new Map<string, Container>(),
    runs: [] as string[][],
    removed: [] as string[],
    busyPorts: new Set<number>(),
    dieOnStart: false,
    dockerDown: false,
    covering: [] as Array<{ certPem: string; keyPem: string }>,
    refreshes: 0,
  };
});

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  const { mkdtempSync: mk } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  h.tmp = mk(join(tmpdir(), 'nd-dbpub-'));
  return {
    ...actual,
    config: { ...actual.config, port: 3000, publicUrl: 'https://panel.example.test', paths: { ...actual.config.paths, dataDir: h.tmp } },
  };
});

vi.mock('../../src/lib/exec.js', () => {
  const docker = (args: string[], sink?: (l: string) => void): string => {
    if (h.dockerDown) throw new Error('Cannot connect to the Docker daemon');
    const [cmd, ...rest] = args;
    if (cmd === 'rm') {
      const name = rest[rest.length - 1]!;
      h.removed.push(name);
      h.containers.delete(name);
      return '';
    }
    if (cmd === 'run') {
      h.runs.push(args);
      const at = (flag: string) => args[args.indexOf(flag) + 1]!;
      const name = at('--name');
      const port = Number(at('-p').split(':')[0]);
      const labels = args.flatMap((a, i) => (args[i - 1] === '--label' ? [a] : []));
      const label = (k: string) => labels.find((l) => l.startsWith(`${k}=`))!.slice(k.length + 1);
      if (h.busyPorts.has(port)) {
        h.containers.set(name, { running: false, fp: '', port, source: '', dbId: '', args });
        sink?.(`docker: Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:${port} failed: port is already allocated.`);
        throw new Error('`docker run` exited with code 125');
      }
      h.containers.set(name, {
        running: !h.dieOnStart,
        fp: label('ninedeploy.dbpub.config-sha'),
        port,
        source: at('-v').replace(/:\/etc\/traefik:ro$/, ''),
        dbId: label('ninedeploy.public-db'),
        args,
      });
      return 'container-id';
    }
    if (cmd === 'inspect') {
      const c = h.containers.get(rest[0]!);
      if (!c) throw new Error('No such object');
      const format = rest[rest.length - 1]!;
      if (format.includes('.Mounts')) return c.source;
      return `${c.running}|${c.fp}\n`;
    }
    if (cmd === 'ps') {
      return [...h.containers.entries()].map(([n, c]) => `${n}|${c.dbId}`).join('\n');
    }
    if (cmd === 'logs') return 'traefik: error while building configuration';
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return {
    capture: vi.fn(async (tool: string, args: string[]) => {
      if (tool !== 'docker') throw new Error(`unexpected ${tool}`);
      return docker(args);
    }),
    run: vi.fn(async (tool: string, args: string[], _opts: unknown, sink: (l: string) => void) => {
      if (tool !== 'docker') throw new Error(`unexpected ${tool}`);
      docker(args, sink);
    }),
    sleep: vi.fn(async () => undefined),
  };
});
vi.mock('../../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/hostPath.js', () => ({ hostPathFor: vi.fn(async (p: string) => p) }));
vi.mock('../../src/lib/customCertificates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/customCertificates.js')>();
  return {
    ...actual,
    refreshCustomCertificates: vi.fn(async () => {
      h.refreshes++;
      return [];
    }),
    certificatesCovering: vi.fn(() => h.covering),
  };
});

const lib = await import('../../src/lib/publicDatabaseAccess.js');
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let pg: Database;
let mysql: Database;
const log = vi.fn();

const dirOf = (slug: string) => path.join(h.tmp, 'dbproxy', slug);
const dynamicOf = (slug: string) => path.join(dirOf(slug), 'dynamic', 'routes.yml');
const input = (over: Partial<Parameters<typeof lib.applyPublicAccess>[2]> = {}) => ({
  port: 15432,
  ipAllowlist: ['203.0.113.0/24'],
  tlsMode: 'none' as const,
  ...over,
});
const row = async (id = pg.id) =>
  db.query.databasePublicAccess.findFirst({ where: eq(databasePublicAccess.databaseId, id) });

beforeEach(async () => {
  h.containers.clear();
  h.runs.length = 0;
  h.removed.length = 0;
  h.busyPorts.clear();
  h.dieOnStart = false;
  h.dockerDown = false;
  h.covering = [];
  log.mockClear();
  rmSync(path.join(h.tmp, 'dbproxy'), { recursive: true, force: true });
  const created = createDb({ url: ':memory:' });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  [pg] = await db
    .insert(databases)
    .values({ name: 'pg', slug: 'pg', engine: 'postgres', status: 'running', passwordEncrypted: 'v1:x', containerName: 'nd-db-pg', internalPort: 5432 })
    .returning() as [Database];
  [mysql] = await db
    .insert(databases)
    .values({ name: 'my', slug: 'my', engine: 'mysql', status: 'running', passwordEncrypted: 'v1:x' })
    .returning() as [Database];
});

afterEach(() => close());
afterAll(() => {
  try {
    rmSync(h.tmp, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

describe('allow-list validation (node:net, never by stripping)', () => {
  it.each([
    ['203.0.113.7/24', '203.0.113.0/24'],
    ['198.51.100.4', '198.51.100.4/32'],
    ['  10.1.2.3/8 ', '10.0.0.0/8'],
    ['2001:DB8::1/48', '2001:db8::/48'],
    ['::1', '::1/128'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1/128'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3/128'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8/128'],
    ['64:ff9b::192.0.2.33', '64:ff9b::c000:221/128'],
    ['fe80::1234/10', 'fe80::/10'],
    ['192.0.2.1/1', '128.0.0.0/1'],
  ])('%s → %s', (raw, expected) => {
    expect(lib.normaliseAllowlistEntry(raw)).toBe(expected);
  });

  it.each([
    ['0.0.0.0/0', /\/0 is refused/],
    ['::/0', /\/0 is refused/],
    ['10.0.0.1/33', /longer than \/32/],
    ['::1/129', /longer than \/128/],
    ['10.0.0.1/', /invalid prefix/],
    ['10.0.0.1/a', /invalid prefix/],
    ['10.0.0.1/0024', /invalid prefix/],
    ['1.2.3', /not an IP/],
    ['01.2.3.4', /not an IP/],
    ['example.com', /not an IP/],
    ['10.0.0.0/8; rm -rf /', /not an IP|invalid prefix/],
    ['1.2.3.4/24/1', /not an IP/],
    ['fe80::1%eth0', /not an IP/],
    ['::ffff:1.2.3.4', /IPv4-mapped/],
    ['::ffff:0.0.0.0/96', /IPv4-mapped/],
    ['', /not an IP/],
    ['1'.repeat(65), /not an IP/],
  ])('refuses %j', (raw, why) => {
    expect(() => lib.normaliseAllowlistEntry(raw)).toThrow(why);
    try {
      lib.normaliseAllowlistEntry(raw);
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
    }
  });

  it('refuses a non-string entry', () => {
    expect(() => lib.normaliseAllowlistEntry(42 as unknown as string)).toThrow(/not an IP/);
  });

  it('requires 1–100 entries and dedupes the normalised form', () => {
    expect(() => lib.normaliseAllowlist([])).toThrow(/at least one/);
    expect(lib.normaliseAllowlist(['203.0.113.7/24', '203.0.113.0/24', '::1'])).toEqual(['203.0.113.0/24', '::1/128']);
    const many = Array.from({ length: 101 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(() => lib.normaliseAllowlist(many)).toThrow(/at most 100/);
    expect(lib.normaliseAllowlist(many.slice(0, 100))).toHaveLength(100);
  });
});

describe('port validation', () => {
  it.each([1023, 65536, 15432.5])('refuses %d with 400', async (port) => {
    await expect(lib.assertPublicPortAvailable(db, port, pg.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses the ports NineDeploy itself listens on', async () => {
    await expect(lib.assertPublicPortAvailable(db, 3000, pg.id)).rejects.toThrow(/reserved/);
    for (const port of [22, 80, 443]) {
      await expect(lib.assertPublicPortAvailable(db, port, pg.id)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('refuses another database’s public port and a service’s published port (409), not its own', async () => {
    await db.insert(databasePublicAccess).values({ databaseId: mysql.id, publicPort: 13306, ipAllowlist: ['10.0.0.0/8'] });
    await db.insert(services).values({ name: 'api', slug: 'api', publishedPort: 18080 });
    await expect(lib.assertPublicPortAvailable(db, 13306, pg.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(lib.assertPublicPortAvailable(db, 18080, pg.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(lib.assertPublicPortAvailable(db, 13306, mysql.id)).resolves.toBeUndefined();
    await expect(lib.assertPublicPortAvailable(db, 15432, pg.id)).resolves.toBeUndefined();
  });
});

describe('engine and placement rules', () => {
  it.each(['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongo'])('%s is supported', (engine) => {
    expect(lib.publicAccessSupported(engine)).toBe(true);
    expect(() => lib.assertPublicAccessEngine(engine, 'none')).not.toThrow();
  });

  it.each(['clickhouse', 'meilisearch', 'rabbitmq'])('%s is refused with 422', (engine) => {
    expect(lib.publicAccessSupported(engine)).toBe(false);
    expect(() => lib.assertPublicAccessEngine(engine, 'none')).toThrow(expect.objectContaining({ statusCode: 422 }));
  });

  it('names the HTTP engines’ alternative', () => {
    expect(() => lib.assertPublicAccessEngine('clickhouse', 'none')).toThrow(/speaks HTTP/);
    expect(() => lib.assertPublicAccessEngine('rabbitmq', 'none')).toThrow(/not supported/);
  });

  it.each(['mysql', 'mariadb'])('refuses TLS termination for %s', (engine) => {
    expect(() => lib.assertPublicAccessEngine(engine, 'terminate')).toThrow(expect.objectContaining({ statusCode: 422 }));
  });

  it.each(['postgres', 'redis', 'valkey', 'mongo'])('allows TLS termination for %s', (engine) => {
    expect(() => lib.assertPublicAccessEngine(engine, 'terminate')).not.toThrow();
  });

  it('refuses a database placed on a remote server (the 0.16 hook)', () => {
    expect(() => lib.assertOnPanelHost({ ...pg, serverId: 4 } as Database)).toThrow(expect.objectContaining({ statusCode: 422 }));
    expect(() => lib.assertOnPanelHost({ ...pg, serverId: null } as Database)).not.toThrow();
    expect(() => lib.assertOnPanelHost(pg)).not.toThrow();
  });
});

describe('rendering', () => {
  it('static config: one :7000 entrypoint, a watched directory provider, no read timeout', () => {
    const s = lib.PUBLIC_DB_STATIC_CONFIG;
    expect(s).toContain('address: ":7000"');
    expect(s).toContain('directory: /etc/traefik/dynamic');
    expect(s).toContain('watch: true');
    expect(s).toContain('readTimeout: 0');
    expect(s).toContain('checkNewVersion: false');
  });

  it('dynamic config without TLS: HostSNI(*), the allow-list, the database target', () => {
    const y = lib.renderPublicDbDynamicConfig({ target: 'nd-db-pg:5432', allowlist: ['203.0.113.0/24', '::1/128'], tlsMode: 'none' });
    expect(y).toContain('rule: "HostSNI(`*`)"');
    expect(y).toContain('middlewares: [db-allow]');
    expect(y).toContain('ipAllowList:');
    expect(y).toContain('- "203.0.113.0/24"');
    expect(y).toContain('- "::1/128"');
    expect(y).toContain('- address: "nd-db-pg:5432"');
    expect(y).not.toContain('tls');
  });

  it('terminate without a covering upload uses Traefik’s default certificate', () => {
    const y = lib.renderPublicDbDynamicConfig({ target: 'nd-db-pg:5432', allowlist: ['10.0.0.0/8'], tlsMode: 'terminate', certificates: [] });
    expect(y).toContain('      tls: {}');
    expect(y).not.toMatch(/^tls:/m);
  });

  it('terminate with covering uploads inlines them and makes the first the default', () => {
    const certs = [
      { certPem: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n', keyPem: '-----BEGIN PRIVATE KEY-----\nKKK\n-----END PRIVATE KEY-----\n' },
    ];
    const y = lib.renderPublicDbDynamicConfig({ target: 'nd-db-pg:5432', allowlist: ['10.0.0.0/8'], tlsMode: 'terminate', certificates: certs });
    expect(y).toMatch(/^tls:\n {2}certificates:\n/m);
    expect(y).toContain('defaultCertificate:');
    expect(y).toContain(JSON.stringify(certs[0]!.certPem));
  });

  it('certificates are ignored outside terminate mode', () => {
    const y = lib.renderPublicDbDynamicConfig({
      target: 'nd-db-pg:5432', allowlist: ['10.0.0.0/8'], tlsMode: 'none', certificates: [{ certPem: 'c', keyPem: 'k' }],
    });
    expect(y).not.toContain('certificates');
  });

  it('the fingerprint covers the static config, the port and the image', () => {
    const a = lib.sidecarFingerprint(15432);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(lib.sidecarFingerprint(15432)).toBe(a);
    expect(lib.sidecarFingerprint(15433)).not.toBe(a);
    expect(lib.sidecarFingerprint(15432, 'traefik:v3.7')).not.toBe(a);
  });

  it('docker argv: label, fingerprint, read-only mount, -p port:7000, limits, no privileges', () => {
    const args = lib.sidecarRunArgs({ name: 'nd-dbpub-pg', databaseId: 7, port: 15432, fingerprint: 'f'.repeat(64), hostDir: '/data/dbproxy/pg', user: '1000:1000' });
    const joined = args.join(' ');
    expect(args.slice(0, 2)).toEqual(['run', '-d']);
    expect(joined).toContain('--name nd-dbpub-pg');
    expect(joined).toContain('--network ninedeploy');
    expect(joined).toContain('--restart unless-stopped');
    expect(joined).toContain('--memory 128m --memory-swap 128m --cpus 0.5');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--user 1000:1000');
    expect(joined).toContain('--label ninedeploy.public-db=7');
    expect(joined).toContain(`--label ninedeploy.dbpub.config-sha=${'f'.repeat(64)}`);
    expect(joined).toContain('-p 15432:7000');
    expect(joined).toContain('-v /data/dbproxy/pg:/etc/traefik:ro');
    expect(args[args.length - 1]).toBe('traefik:3');
    expect(joined).not.toContain('--privileged');
    expect(lib.sidecarRunArgs({ name: 'n', databaseId: 1, port: 2000, fingerprint: 'x', hostDir: '/d' })).not.toContain('--user');
  });

  it('the config directory refuses a slug that could leave dbproxy/', () => {
    expect(lib.sidecarConfigDir('pg')).toBe(dirOf('pg'));
    expect(() => lib.sidecarConfigDir('../etc')).toThrow(/invalid database slug/);
    expect(lib.sidecarName('pg')).toBe('nd-dbpub-pg');
  });
});

describe('applyPublicAccess', () => {
  it('enables: writes both configs, starts the sidecar and stores the normalised row', async () => {
    const res = await lib.applyPublicAccess(db, pg, input({ ipAllowlist: ['203.0.113.9/24', '203.0.113.0/24'] }), { userId: null, log });
    expect(res.mode).toBe('started');
    expect(res.previous).toBeNull();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toContain('15432:7000');
    expect(readFileSync(path.join(dirOf('pg'), 'traefik.yml'), 'utf8')).toBe(lib.PUBLIC_DB_STATIC_CONFIG);
    expect(readFileSync(dynamicOf('pg'), 'utf8')).toContain('- address: "nd-db-pg:5432"');
    if (process.platform !== 'win32') expect(statSync(dynamicOf('pg')).mode & 0o777).toBe(0o600);
    const r = await row();
    expect(r).toMatchObject({ enabled: true, publicPort: 15432, tlsMode: 'none', ipAllowlist: ['203.0.113.0/24'], containerName: 'nd-dbpub-pg', lastError: null });
    expect(r!.appliedAt).toBeInstanceOf(Date);
  });

  it('falls back to the conventional name and the engine port when the row has none', async () => {
    await lib.applyPublicAccess(db, mysql, input({ port: 13306 }), { userId: null, log });
    expect(readFileSync(dynamicOf('my'), 'utf8')).toContain('- address: "nd-db-my:3306"');
  });

  it('an allow-list or TLS change on the same port rewrites routes.yml only (hot reload)', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    const res = await lib.applyPublicAccess(db, pg, input({ ipAllowlist: ['198.51.100.0/24'], tlsMode: 'terminate', tlsHostname: 'DB.Example.com' }), {
      userId: null,
      log,
    });
    expect(res.mode).toBe('hot');
    expect(res.previous?.enabled).toBe(true);
    expect(h.runs).toHaveLength(1);
    const y = readFileSync(dynamicOf('pg'), 'utf8');
    expect(y).toContain('198.51.100.0/24');
    expect(y).toContain('tls: {}');
    expect(await row()).toMatchObject({ tlsMode: 'terminate', tlsHostname: 'db.example.com', ipAllowlist: ['198.51.100.0/24'] });
  });

  it('a port change recreates the sidecar on the new port', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    const res = await lib.applyPublicAccess(db, pg, input({ port: 15433 }), { userId: null, log });
    expect(res.mode).toBe('started');
    expect(h.runs).toHaveLength(2);
    expect(h.containers.get('nd-dbpub-pg')?.port).toBe(15433);
    expect((await row())!.publicPort).toBe(15433);
  });

  it('a stopped sidecar on the same port is recreated, not hot-reloaded', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    h.containers.get('nd-dbpub-pg')!.running = false;
    const res = await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    expect(res.mode).toBe('started');
  });

  it('a busy port fails with 409 and Docker’s message, restoring the previous sidecar and row', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    const before = readFileSync(dynamicOf('pg'), 'utf8');
    h.busyPorts.add(15433);
    const err = await lib.applyPublicAccess(db, pg, input({ port: 15433, ipAllowlist: ['10.0.0.0/8'] }), { userId: null, log }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409 });
    expect(err.message).toMatch(/port is already allocated/);
    expect(lib.isApplyFailure(err)).toBe(true);
    // Previous sidecar back on its previous port with its previous routes.
    expect(h.containers.get('nd-dbpub-pg')).toMatchObject({ running: true, port: 15432 });
    expect(readFileSync(dynamicOf('pg'), 'utf8')).toBe(before);
    expect(await row()).toMatchObject({ enabled: true, publicPort: 15432, ipAllowlist: ['203.0.113.0/24'] });
    expect((await row())!.lastError).toMatch(/port is already allocated/);
  });

  it('restores from the row when the previous routes file is gone', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    rmSync(dynamicOf('pg'));
    h.busyPorts.add(15433);
    await expect(lib.applyPublicAccess(db, pg, input({ port: 15433 }), { userId: null, log })).rejects.toMatchObject({ statusCode: 409 });
    expect(readFileSync(dynamicOf('pg'), 'utf8')).toContain('203.0.113.0/24');
    expect(h.containers.get('nd-dbpub-pg')?.port).toBe(15432);
  });

  it('logs (and survives) a failed restore', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    h.busyPorts.add(15433);
    h.busyPorts.add(15432);
    await expect(lib.applyPublicAccess(db, pg, input({ port: 15433 }), { userId: null, log })).rejects.toMatchObject({ statusCode: 409 });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/restoring the previous proxy failed/));
    expect(h.containers.has('nd-dbpub-pg')).toBe(false);
  });

  it('a first enable that fails leaves no row, no container and no config directory', async () => {
    h.dieOnStart = true;
    const err = await lib.applyPublicAccess(db, pg, input(), { userId: null, log }).catch((e) => e);
    expect(err.message).toMatch(/did not stay running: traefik: error/);
    expect(lib.isApplyFailure(err)).toBe(true);
    expect(await row()).toBeUndefined();
    expect(h.containers.has('nd-dbpub-pg')).toBe(false);
    expect(existsSync(dirOf('pg'))).toBe(false);
  });

  it('a generic docker failure surfaces its output', async () => {
    h.dockerDown = true;
    await expect(lib.applyPublicAccess(db, pg, input(), { userId: null, log })).rejects.toThrow(/Cannot connect|exited|No such/);
  });

  it('a validation refusal is not an apply failure and changes nothing', async () => {
    const err = await lib.applyPublicAccess(db, pg, input({ ipAllowlist: ['0.0.0.0/0'] }), { userId: null, log }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400 });
    expect(lib.isApplyFailure(err)).toBe(false);
    expect(lib.isApplyFailure('text')).toBe(false);
    await expect(lib.applyPublicAccess(db, mysql, input({ tlsMode: 'terminate' }), { userId: null, log })).rejects.toMatchObject({ statusCode: 422 });
    await expect(lib.applyPublicAccess(db, pg, input({ port: 443 }), { userId: null, log })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.runs).toHaveLength(0);
    expect(await row()).toBeUndefined();
  });

  it('terminate mode inlines the uploaded certificates covering tlsHostname', async () => {
    h.covering = [{ certPem: 'CERT\n', keyPem: 'KEY\n' }];
    await lib.applyPublicAccess(db, pg, input({ tlsMode: 'terminate', tlsHostname: 'db.example.com' }), { userId: null, log });
    const y = readFileSync(dynamicOf('pg'), 'utf8');
    expect(y).toContain('certificates:');
    expect(y).toContain('"CERT\\n"');
  });

  it('serialises operations on one database', async () => {
    const order: string[] = [];
    await Promise.all([
      lib.applyPublicAccess(db, pg, input(), { userId: null, log }).then(() => order.push('apply')),
      lib.disablePublicAccess(db, pg, log).then(() => order.push('disable')),
    ]);
    expect(order).toEqual(['apply', 'disable']);
    expect((await row())!.enabled).toBe(false);
  });
});

describe('disable, delete hook', () => {
  it('disable removes the sidecar and its directory and keeps the configuration', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    const prev = await lib.disablePublicAccess(db, pg, log);
    expect(prev?.enabled).toBe(true);
    expect(h.containers.has('nd-dbpub-pg')).toBe(false);
    expect(existsSync(dirOf('pg'))).toBe(false);
    expect(await row()).toMatchObject({ enabled: false, publicPort: 15432, ipAllowlist: ['203.0.113.0/24'], containerName: null });
  });

  it('disable without a row is a no-op', async () => {
    expect(await lib.disablePublicAccess(db, pg, log)).toBeNull();
    expect(h.removed).toEqual([]);
  });

  it('the delete hook removes the sidecar and never throws', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    await lib.removePublicAccessSidecar(db, pg, log);
    expect(h.containers.has('nd-dbpub-pg')).toBe(false);
    expect(existsSync(dirOf('pg'))).toBe(false);
    const broken = { query: { databasePublicAccess: { findFirst: async () => { throw new Error('db gone'); } } } } as unknown as DB;
    await expect(lib.removePublicAccessSidecar(broken, pg, log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/removal failed/));
  });

  it('the delete hook makes no Docker call for a database that never had public access', async () => {
    await lib.removePublicAccessSidecar(db, mysql, log);
    expect(h.removed).toEqual([]);
  });

  it('the delete hook still clears a leftover config directory without a row', async () => {
    mkdirSync(dirOf('my'), { recursive: true });
    await lib.removePublicAccessSidecar(db, mysql, log);
    expect(h.removed).toEqual(['nd-dbpub-my']);
    expect(existsSync(dirOf('my'))).toBe(false);
  });

  it('the FK cascade removes the row with the database', async () => {
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    await db.delete(databases).where(eq(databases.id, pg.id));
    expect(await row()).toBeUndefined();
  });
});

describe('reconcilePublicAccess (boot + watchdog)', () => {
  const enableRow = (over: Partial<typeof databasePublicAccess.$inferInsert> = {}) =>
    db.insert(databasePublicAccess).values({ databaseId: pg.id, enabled: true, publicPort: 15432, ipAllowlist: ['203.0.113.0/24'], ...over });

  it('recreates a missing sidecar and writes its configs', async () => {
    await enableRow();
    const res = await lib.reconcilePublicAccess(db, log);
    expect(res).toEqual({ started: 1, failed: 0, orphansRemoved: 0 });
    expect(h.containers.get('nd-dbpub-pg')).toMatchObject({ running: true, port: 15432 });
    expect(existsSync(dynamicOf('pg'))).toBe(true);
    expect((await row())!.containerName).toBe('nd-dbpub-pg');
  });

  it('leaves a current sidecar alone and recreates one with a stale fingerprint', async () => {
    await enableRow({ lastError: 'old' });
    await lib.reconcilePublicAccess(db, log);
    expect(h.runs).toHaveLength(1);
    expect(await lib.reconcilePublicAccess(db, log)).toEqual({ started: 0, failed: 0, orphansRemoved: 0 });
    expect(h.runs).toHaveLength(1);
    h.containers.get('nd-dbpub-pg')!.fp = 'stale';
    expect((await lib.reconcilePublicAccess(db, log)).started).toBe(1);
  });

  it('clears a stale last_error once the sidecar is healthy', async () => {
    await enableRow();
    await lib.reconcilePublicAccess(db, log);
    await db.update(databasePublicAccess).set({ lastError: 'transient' });
    await lib.reconcilePublicAccess(db, log);
    expect((await row())!.lastError).toBeNull();
  });

  it('records a failure in last_error', async () => {
    await enableRow();
    h.busyPorts.add(15432);
    expect((await lib.reconcilePublicAccess(db, log)).failed).toBe(1);
    expect((await row())!.lastError).toMatch(/port is already allocated/);
  });

  it('refuses (and records) a row whose engine can no longer be served', async () => {
    await db.insert(databasePublicAccess).values({ databaseId: mysql.id, enabled: true, publicPort: 13306, tlsMode: 'terminate', ipAllowlist: ['10.0.0.0/8'] });
    expect((await lib.reconcilePublicAccess(db, log)).failed).toBe(1);
    expect((await row(mysql.id))!.lastError).toMatch(/TLS termination/);
  });

  it('removes orphans under this data dir and keeps foreign sidecars', async () => {
    await enableRow();
    await lib.reconcilePublicAccess(db, log);
    const own = (name: string, dbId: string) =>
      h.containers.set(name, { running: true, fp: 'x', port: 1, source: path.join(dirOf(name), ''), dbId, args: [] });
    own('nd-dbpub-gone', '999');
    own('nd-dbpub-bad', 'not-a-number');
    own('nd-dbpub-renamed', String(pg.id));
    h.containers.set('nd-dbpub-elsewhere', { running: true, fp: 'x', port: 2, source: '/srv/other-install/dbproxy/x', dbId: '999', args: [] });
    await db.insert(databasePublicAccess).values({ databaseId: mysql.id, enabled: false, publicPort: 13306, ipAllowlist: ['10.0.0.0/8'] });
    own('nd-dbpub-my', String(mysql.id));
    const res = await lib.reconcilePublicAccess(db, log);
    expect(res.orphansRemoved).toBe(4);
    expect([...h.containers.keys()].sort()).toEqual(['nd-dbpub-elsewhere', 'nd-dbpub-pg']);
  });

  it('skips the orphan sweep when docker is unreachable', async () => {
    h.dockerDown = true;
    expect(await lib.reconcilePublicAccess(db, log)).toEqual({ started: 0, failed: 0, orphansRemoved: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/orphan sweep skipped/));
  });
});

describe('rerenderTlsSidecars (certificate changes)', () => {
  it('rewrites only the terminate sidecars whose certificates changed', async () => {
    await lib.applyPublicAccess(db, pg, input({ tlsMode: 'terminate', tlsHostname: 'db.example.com' }), { userId: null, log });
    await lib.applyPublicAccess(db, mysql, input({ port: 13306 }), { userId: null, log });
    const refreshes = h.refreshes;
    expect(await lib.rerenderTlsSidecars(db, log)).toBe(0);
    h.covering = [{ certPem: 'NEW\n', keyPem: 'K\n' }];
    expect(await lib.rerenderTlsSidecars(db, log)).toBe(1);
    expect(h.refreshes).toBeGreaterThan(refreshes);
    expect(readFileSync(dynamicOf('pg'), 'utf8')).toContain('"NEW\\n"');
    expect(h.runs).toHaveLength(2);
  });

  it('logs a failed re-render and carries on', async () => {
    await db.insert(databasePublicAccess).values({ databaseId: pg.id, enabled: true, publicPort: 15432, tlsMode: 'terminate', ipAllowlist: ['10.0.0.0/8'] });
    mkdirSync(dirOf('pg'), { recursive: true });
    // A directory where the routes file belongs makes the write fail.
    mkdirSync(dynamicOf('pg'), { recursive: true });
    writeFileSync(path.join(dynamicOf('pg'), 'x'), '');
    expect(await lib.rerenderTlsSidecars(db, log)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/TLS re-render failed/));
  });
});

describe('read side', () => {
  it('reports an unconfigured database (the upgrade default)', async () => {
    expect(await lib.publicAccessStatus(db, pg)).toEqual({
      supported: true,
      configured: false,
      enabled: false,
      port: null,
      tlsMode: 'none',
      tlsHostname: null,
      ipAllowlist: [],
      status: 'off',
      lastError: null,
      appliedAt: null,
      publicHost: 'panel.example.test',
    });
    expect((await lib.publicAccessStatus(db, { ...pg, engine: 'clickhouse' })).supported).toBe(false);
  });

  it('reports running, error and off', async () => {
    await lib.applyPublicAccess(db, pg, input({ tlsHostname: 'db.example.com' }), { userId: null, log });
    expect(await lib.publicAccessStatus(db, pg)).toMatchObject({ configured: true, enabled: true, status: 'running', port: 15432, publicHost: 'db.example.com' });
    expect((await lib.publicAccessStatus(db, pg)).appliedAt).toMatch(/^\d{4}-/);
    h.containers.get('nd-dbpub-pg')!.running = false;
    expect((await lib.publicAccessStatus(db, pg)).status).toBe('error');
    await lib.disablePublicAccess(db, pg, log);
    expect(await lib.publicAccessStatus(db, pg)).toMatchObject({ configured: true, enabled: false, status: 'off', ipAllowlist: ['203.0.113.0/24'] });
  });

  it('publicHost: tlsHostname, else the panel domain, else the public URL host', async () => {
    expect(await lib.resolvePublicHost(db, 'db.example.com')).toBe('db.example.com');
    expect(await lib.resolvePublicHost(db, null)).toBe('panel.example.test');
    await db.insert(settings).values({ key: 'panel_domain', value: 'panel.example.com' });
    expect(await lib.resolvePublicHost(db, null)).toBe('panel.example.com');
  });

  it('summaries for the database serializer', async () => {
    expect(await lib.publicAccessSummaries(db, [])).toEqual(new Map());
    await lib.applyPublicAccess(db, pg, input(), { userId: null, log });
    const m = await lib.publicAccessSummaries(db, [pg.id, mysql.id]);
    expect(m.get(pg.id)).toEqual({ enabled: true, port: 15432 });
    expect(m.has(mysql.id)).toBe(false);
    const broken = { query: { databasePublicAccess: { findMany: async () => { throw new Error('no table'); } } } } as unknown as DB;
    expect(await lib.publicAccessSummaries(broken, [1])).toEqual(new Map());
  });
});
