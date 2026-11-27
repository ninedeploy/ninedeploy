/**
 * N12: the node's hands of the upgrade (lib/nodeDatabaseUpgrade.ts) over a
 * scripted agent — what each request of the journal becomes on the wire, and
 * every refusal. The whole journal over a fake node is
 * test/lib/databaseUpgradeNode.test.ts; here one call at a time.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Database, type DB } from '@ninedeploy/db';

type Answer = { exitCode: number; lines?: string[] } | Error;
const h = vi.hoisted(() => ({
  /** What the agent answers per op, in order (the last answer repeats). */
  answers: {} as Record<string, Answer | Answer[]>,
  calls: [] as Array<{ op: string; params: Record<string, unknown> }>,
}));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-node-upgrade-deps-'));
mkdirSync(path.join(tmp, 'backups'), { recursive: true });
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows may still hold a closed libsql file briefly */
  }
});
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { config: { ...actual.config, paths: { ...actual.config.paths, backupsDir: path.join(tmp, 'backups'), dataDir: tmp } } };
});

vi.mock('../../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentClient.js')>()),
  agentOp: vi.fn(async (_db: unknown, _id: number, op: string, params: Record<string, unknown>) => {
    h.calls.push({ op, params });
    const scripted = h.answers[op];
    const next = Array.isArray(scripted) ? (scripted.length > 1 ? scripted.shift() : scripted[0]) : scripted;
    if (next instanceof Error) throw next;
    return next ?? { exitCode: 0, lines: [] };
  }),
}));

// The panel host's own Docker is never asked for a node database.
const forbidden = (what: string) => () => {
  throw new Error(`local docker must not run: ${what}`);
};
vi.mock('../../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/exec.js')>()),
  run: async (cmd: string, args: string[]) => forbidden(`${cmd} ${args.join(' ')}`)(),
  capture: async (cmd: string, args: string[]) => forbidden(`${cmd} ${args.join(' ')}`)(),
}));

const { nodeDatabaseUpgradeDeps, NODE_STOP_BOUND_SEC } = await import('../../src/lib/nodeDatabaseUpgrade.js');
const { tableCountStatement, upgradeStatement } = await import('../../src/lib/databaseUpgradeSql.js');
const { withDatabaseOperationLock } = await import('../../src/engine/database.js');
const { sleep } = await import('../../src/lib/exec.js');
const { encrypt } = await import('../../src/lib/crypto.js');

const REPLY = 'ND-DB-UPGRADE ';
const id = { databaseId: 20, slug: 'shop', engine: 'mysql', container: 'nd-db-shop' };
const reply = (value: unknown) => ({ exitCode: 0, lines: [`${REPLY}${JSON.stringify(value)}`] });
const noop = () => undefined;

let row: Database;
let db: DB;
// Release each native connection before another test allocates one (a libsql finalizer can crash on Windows).
let dbClient: ReturnType<typeof createDb>['client'] | undefined;
afterEach(() => {
  dbClient?.close();
  dbClient = undefined;
});
const deps = () => nodeDatabaseUpgradeDeps(db, row, { pollMs: 0, wait: async () => undefined });

beforeEach(async () => {
  h.calls.length = 0;
  h.answers = {};
  ({ db, client: dbClient } = createDb({ url: ':memory:' }));
  row = { id: 20, slug: 'shop', name: 'shop', engine: 'mysql', version: '8.0', serverId: 3, status: 'running', containerName: null, volumeName: null, passwordEncrypted: encrypt('pw-shop'), memLimitMb: 0 } as Database;
});

describe('who it is for', () => {
  it('is for a node database only', () => {
    expect(() => nodeDatabaseUpgradeDeps(db, { ...row, serverId: null }, {})).toThrow('not a node database');
  });

  it('every request names the one database', async () => {
    h.answers['db.upgrade'] = reply({ state: 'running', exitCode: 0, imageId: 'sha256:old', imageTag: 'mysql:8.0' });
    await deps().containerImage('nd-db-shop');
    expect(h.calls).toEqual([{ op: 'db.upgrade', params: { database: id, action: 'state', target: { kind: 'database' } } }]);
  });

  it('asks only the database container or one of its helpers, never anything else', async () => {
    await expect(deps().psql('nd-db-victim', upgradeStatement('postgres.ping'))).rejects.toThrow('is neither this database\'s container nor one of its upgrade helpers');
    await expect(deps().dataDirBytes('nd-db-victim', '/var/lib/mysql')).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });
});

describe('a statement goes by name', () => {
  it('the text is built on the node: the request carries the name and what the statement reads', async () => {
    h.answers['db.upgrade'] = { exitCode: 0, lines: ['7', '8'] };
    const out = await deps().sql(row, 'nd-db-shop', tableCountStatement([{ schema: 'shop', table: 'orders' }], 100));
    expect(out).toBe('7\n8\n');
    expect(h.calls[0]).toEqual({
      op: 'db.upgrade',
      params: { database: id, action: 'sql', target: { kind: 'database' }, statement: 'mysql.tableCounts', args: { tables: [{ schema: 'shop', table: 'orders' }], offset: 100 }, password: 'pw-shop' },
    });
    expect(JSON.stringify(h.calls[0]!.params)).not.toMatch(/COUNT|FROM/);
  });

  it('a helper is named by its role', async () => {
    await deps().psql('nd-db-upg-shop-new', upgradeStatement('postgres.analyze'));
    expect(h.calls[0]!.params).toMatchObject({ target: { kind: 'helper', helper: 'new' }, statement: 'postgres.analyze' });
    expect(h.calls[0]!.params['password']).toBe('');
    expect(h.calls[0]!.params['args']).toBeUndefined();
  });

  it('a failed statement throws with what the node said; an answer the channel would have cut is refused', async () => {
    h.answers['db.upgrade'] = { exitCode: 1, lines: ['ERROR 1064 (42000): You have an error in your SQL syntax'] };
    await expect(deps().sql(row, 'nd-db-shop', upgradeStatement('mysql.ping'))).rejects.toThrow('the statement mysql.ping failed on the node: ERROR 1064 (42000): You have an error in your SQL syntax');
    h.answers['db.upgrade'] = { exitCode: 0, lines: ['… 12 earlier output line(s) omitted by the agent', 'x'] };
    await expect(deps().sql(row, 'nd-db-shop', upgradeStatement('mysql.userTables'))).rejects.toThrow('was too large for the agent channel; nothing was compared');
  });
});

describe('reading the node', () => {
  it('the image and the state come from `state`; a missing container is null', async () => {
    h.answers['db.upgrade'] = reply({ state: 'running', exitCode: 0, imageId: 'sha256:old', imageTag: 'mysql:8.0' });
    expect(await deps().containerImage('nd-db-shop')).toEqual({ id: 'sha256:old', tag: 'mysql:8.0' });
    h.answers['db.upgrade'] = reply({ state: 'missing' });
    expect(await deps().containerImage('nd-db-shop')).toBeNull();
    h.answers['docker.inspect'] = { exitCode: 0, lines: ['running|172.20.0.2'] };
    expect(await deps().containerRunning('nd-db-shop')).toBe(true);
    h.answers['docker.inspect'] = { exitCode: 1, lines: ['Error: No such object'] };
    expect(await deps().containerRunning('nd-db-shop')).toBe(false);
  });

  it('the size and the free room are read inside the container', async () => {
    h.answers['db.upgrade'] = { exitCode: 0, lines: ['123456\t/var/lib/mysql'] };
    expect(await deps().dataDirBytes('nd-db-shop', '/var/lib/mysql')).toBe(123_456);
    expect(h.calls[0]!.params).toMatchObject({ action: 'measure', what: 'size', dir: '/var/lib/mysql', target: { kind: 'database' } });
    h.answers['db.upgrade'] = { exitCode: 0, lines: ['Filesystem 1-blocks Used Available', '/dev/vda1 1000 500 322122547200 1%'] };
    expect(await deps().freeBytesIn('nd-db-shop', '/var/lib/mysql')).toBe(322_122_547_200);
    h.answers['db.upgrade'] = { exitCode: 0, lines: ['not a number'] };
    await expect(deps().dataDirBytes('nd-db-shop', '/var/lib/mysql')).rejects.toThrow('could not measure');
    await expect(deps().freeBytesIn('nd-db-shop', '/var/lib/mysql')).rejects.toThrow('could not read the free space');
  });
});

describe('what stops and removes', () => {
  it('a helper is removed by its role, the database by a graceful stop and a removal; anything else is refused', async () => {
    await deps().stopAndRemove('nd-db-upg-shop-copy', noop);
    expect(h.calls).toEqual([{ op: 'db.upgrade', params: { database: id, action: 'remove', helper: 'copy' } }]);
    await deps().stopAndRemove('nd-db-shop', noop);
    expect(h.calls.slice(1)).toEqual([
      { op: 'docker.stop', params: { name: 'nd-db-shop', graceSeconds: 60 } },
      { op: 'docker.rm', params: { name: 'nd-db-shop' } },
    ]);
    h.calls.length = 0;
    await expect(deps().stopAndRemove('nd-db-victim', noop)).rejects.toThrow('is not this database\'s container');
    expect(h.calls).toEqual([]);
  });

  it('a refused stop or removal of the database container is tolerated, as on the panel host', async () => {
    h.answers['docker.stop'] = { exitCode: 1, lines: ['Error: No such container'] };
    h.answers['docker.rm'] = { exitCode: 1, lines: ['Error: No such container'] };
    await expect(deps().stopAndRemove('nd-db-shop', noop)).resolves.toBeUndefined();
    // A helper that the node refuses to remove is a failure: it is still on the volume.
    h.answers['db.upgrade'] = { exitCode: 1, lines: ['Container nd-db-upg-shop-old is not an upgrade helper of database #20 on this node; nothing was done to it'] };
    await expect(deps().stopAndRemove('nd-db-upg-shop-old', noop)).rejects.toThrow('the node could not remove nd-db-upg-shop-old: Container nd-db-upg-shop-old is not an upgrade helper');
  });

  it('a helper starts with the row\'s credentials and what the step adds, under its memory limit', async () => {
    await deps().runIsolated({ ...row, memLimitMb: 256 }, { name: 'nd-db-upg-shop-new', image: 'mysql:8.4', volume: 'nd-db-shop-data-u1', mount: '/var/lib/mysql', env: { MARIADB_AUTO_UPGRADE: '1' } }, noop);
    expect(h.calls).toEqual([{
      op: 'db.upgrade',
      params: { database: id, action: 'run', helper: 'new', image: 'mysql:8.4', volume: 'nd-db-shop-data-u1', mount: '/var/lib/mysql', memLimitMb: 256, env: { MYSQL_ROOT_PASSWORD: 'pw-shop', MYSQL_DATABASE: 'app', MARIADB_AUTO_UPGRADE: '1' } },
    }]);
    await expect(deps().runIsolated(row, { name: 'nd-db-victim', image: 'mysql:8.4', volume: 'v', mount: '/var/lib/mysql' }, noop)).rejects.toThrow('is not an upgrade helper of shop');
  });

  it('a clean stop asks for the bound the panel host gives and answers the exit code', async () => {
    h.answers['db.upgrade'] = reply({ exitCode: 0 });
    expect(await deps().stopClean('nd-db-upg-shop-old', noop)).toBe(0);
    expect(h.calls[0]!.params).toMatchObject({ action: 'stop', helper: 'old', timeoutSec: NODE_STOP_BOUND_SEC });
    h.answers['db.upgrade'] = reply({ exitCode: null });
    expect(await deps().stopClean('nd-db-upg-shop-old', noop)).toBeNull();
    await expect(deps().stopClean('nd-db-shop', noop)).rejects.toThrow('is not an upgrade helper');
  });
});

describe('the copy is started, watched and removed', () => {
  const name = 'nd-db-upg-shop-copy';
  const start = () => reply({ started: name });
  it('runs until the copier exits 0, and the copier is gone before the answer', async () => {
    h.answers['db.upgrade'] = [start(), reply({ state: 'running', exitCode: 0, imageId: '', imageTag: '' }), reply({ state: 'exited', exitCode: 0, imageId: '', imageTag: '' })];
    await deps().copyVolume('nd-db-shop-data', 'nd-db-shop-data-u1', 'mysql:8.4', name, noop);
    expect(h.calls.map((c) => `${c.op}:${String(c.params['action'])}`)).toEqual(['db.upgrade:copy', 'db.upgrade:state', 'db.upgrade:state', 'db.upgrade:remove']);
    expect(h.calls.at(-1)).toEqual({ op: 'db.upgrade', params: { database: id, action: 'remove', helper: 'copy' } });
    expect(h.calls[1]!.params).toMatchObject({ action: 'state', target: { kind: 'helper', helper: 'copy' } });
    expect(h.calls[0]!.params).toMatchObject({ image: 'mysql:8.4', from: 'nd-db-shop-data', to: 'nd-db-shop-data-u1' });
  });

  it('a copier that exits non-zero fails the copy, and is removed all the same', async () => {
    h.answers['db.upgrade'] = [start(), reply({ state: 'exited', exitCode: 7, imageId: '', imageTag: '' })];
    await expect(deps().copyVolume('a', 'b', 'mysql:8.4', name, noop)).rejects.toThrow('copying the volume exited with 7');
    expect(h.calls.at(-1)).toMatchObject({ op: 'db.upgrade', params: { action: 'remove', helper: 'copy' } });
  });

  it('a copier that is gone, was never started, or runs past the bound is a failure', async () => {
    h.answers['db.upgrade'] = [start(), reply({ state: 'missing' })];
    await expect(deps().copyVolume('a', 'b', 'mysql:8.4', name, noop)).rejects.toThrow('the copy helper is gone before it finished');
    h.answers['db.upgrade'] = [start(), reply({ state: 'created', exitCode: 0, imageId: '', imageTag: '' })];
    await expect(deps().copyVolume('a', 'b', 'mysql:8.4', name, noop)).rejects.toThrow('was never started');
    h.calls.length = 0;
    h.answers['db.upgrade'] = [start(), reply({ state: 'running', exitCode: 0, imageId: '', imageTag: '' })];
    await expect(nodeDatabaseUpgradeDeps(db, row, { pollMs: 0, wait: async () => undefined, copyTimeoutMs: 0 }).copyVolume('a', 'b', 'mysql:8.4', name, noop)).rejects.toThrow('did not finish within 0 minutes');
    expect(h.calls.at(-1)).toMatchObject({ params: { action: 'state' } });
  });

  it('only the copier of this database may be named', async () => {
    await expect(deps().copyVolume('a', 'b', 'mysql:8.4', 'nd-db-victim', noop)).rejects.toThrow('is not the copier of shop');
    expect(h.calls).toEqual([]);
  });
});

describe('waiting for a server', () => {
  it('asks until the server answers', async () => {
    h.answers['db.upgrade'] = [{ exitCode: 1, lines: ['ERROR 2002 (HY000): Can\'t connect'] }, { exitCode: 0, lines: ['1'] }];
    h.answers['docker.inspect'] = { exitCode: 0, lines: ['running|172.20.0.2'] };
    expect(await deps().waitReady('nd-db-upg-shop-new', row, noop)).toBe(true);
    expect(h.calls.filter((c) => c.op === 'db.upgrade').map((c) => c.params['statement'])).toEqual(['mysql.ping', 'mysql.ping']);
  });

  it('a container that exited ends the wait', async () => {
    h.answers['db.upgrade'] = { exitCode: 1, lines: ['ERROR 2002 (HY000): Can\'t connect'] };
    h.answers['docker.inspect'] = { exitCode: 0, lines: ['exited|'] };
    const lines: string[] = [];
    expect(await deps().waitReady('nd-db-upg-shop-new', row, (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual(['nd-db-upg-shop-new is exited before it accepted connections (the statement mysql.ping failed on the node: ERROR 2002 (HY000): Can\'t connect)']);
  });
});

describe('volumes, images and locks', () => {
  it('a new volume is created so that an existing one is refused; a removed one is checked', async () => {
    await deps().createVolume('nd-db-shop-data-u1', { 'ninedeploy.database.id': '20' }, noop);
    expect(h.calls[0]).toEqual({ op: 'docker.volumeCreate', params: { name: 'nd-db-shop-data-u1', labels: { 'ninedeploy.database.id': '20' }, ifExists: 'fail' } });
    h.answers['docker.volumeInspect'] = { exitCode: 0, lines: ['{}'] };
    expect(await deps().volumeExists('nd-db-shop-data-u1')).toBe(true);
    h.answers['docker.volumeInspect'] = { exitCode: 1, lines: ['Error: No such volume'] };
    expect(await deps().volumeExists('nd-db-shop-data-u1')).toBe(false);
    expect(await deps().removeVolume('nd-db-shop-data-u1', noop)).toBe(true);
    expect(h.calls.at(-2)).toEqual({ op: 'docker.volumeRm', params: { name: 'nd-db-shop-data-u1' } });
  });

  it('a volume that is still there after the removal answers false', async () => {
    h.answers['docker.volumeInspect'] = { exitCode: 0, lines: ['{}'] };
    expect(await deps().removeVolume('nd-db-shop-data-u1', noop)).toBe(false);
  });

  it('the new volume carries the row\'s id; the image is pulled on the node; there are no bridges to rejoin', async () => {
    expect(deps().volumeLabels?.(row)).toMatchObject({ 'ninedeploy.managed': 'database', 'ninedeploy.database.id': '20', 'ninedeploy.database.slug': 'shop' });
    await deps().pull('mysql:8.4', noop);
    expect(h.calls[0]).toEqual({ op: 'docker.pull', params: { image: 'mysql:8.4' } });
    await expect(deps().attachBridges(row, ['web'], noop)).resolves.toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  it('the journal holds the database\'s operation lock, the one its backups and restores take', async () => {
    const order: string[] = [];
    const first = deps().maintenance(row, noop, async () => {
      order.push('first began');
      await sleep(50);
      order.push('first ended');
    });
    // The lock a backup or a restore of this database takes: it waits for the journal.
    const second = withDatabaseOperationLock(row.id, noop, async () => {
      order.push('backup ran');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first began', 'first ended', 'backup ran']);
  });
});
