import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Database, type DB, databases, runMigrations, servers } from '@ninedeploy/db';
import { databases015 } from './fixtures/schema015.js';

/**
 * Multi-node T6, the rollback fail-safe (design §5.8, owner decision O6, §5.9
 * "the marker property").
 *
 * A node database row stores `container_name` and `volume_name` as NULL; its
 * real names live in `node_container_name` / `node_volume_name`, which 0.15
 * does not know. A panel rolled back to 0.15 reads the row through its own
 * drizzle schema (`fixtures/schema015.ts`) and runs its own database code
 * (`fixtures/database015.ts`, `fixtures/pgbouncer015.ts`, vendored verbatim
 * from v0.15.0) against it. Every action must REFUSE or DO NOTHING — never a
 * `docker` call on the panel host, never a pull, a volume, a container — with
 * the local `run` / `capture` / pull stubbed to throw.
 *
 * The same matrix runs against the LIVE engine/database.ts with the runtime
 * dispatch bypassed (calling the engine function directly, as a missed
 * dispatch would): a call site 0.16 forgot to route to the node also fails
 * closed instead of acting on the panel host.
 */

const h = vi.hoisted(() => ({ calls: [] as string[] }));
const forbidden = (what: string) => {
  h.calls.push(what);
  throw new Error(`local docker must not run: ${what}`);
};
vi.mock('../src/lib/exec.js', () => ({
  run: async (cmd: string, args: string[]) => forbidden(`run ${cmd} ${args.join(' ')}`),
  capture: async (cmd: string, args: string[]) => forbidden(`capture ${cmd} ${args.join(' ')}`),
  sleep: async () => undefined,
}));
vi.mock('../src/lib/dockerPull.js', () => ({
  pullDockerImage: async (image: string) => forbidden(`pull ${image}`),
  ensureDockerImage: async (image: string) => forbidden(`ensure ${image}`),
}));
vi.mock('../src/lib/secretFile.js', () => ({
  writeSecretFile: (prefix: string) => forbidden(`secret file ${prefix}`),
}));
vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/config.js')>();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-marker-'));
  return { ...orig, config: { ...orig.config, paths: { ...orig.config.paths, dataDir: dir, backupsDir: dir } } };
});

const v015 = await import('./fixtures/database015.js');
const pgb015 = await import('./fixtures/pgbouncer015.js');
const live = await import('../src/engine/database.js');
const { planRetention } = await import('../src/lib/backupPolicy.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { config } = await import('../src/config.js');

type EngineModule = typeof v015;

let db: DB;
let nodeRow015: Database;
let mysqlRow015: Database;

beforeAll(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  const [node] = await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' }).returning();
  // What 0.16 writes for a node database: the marker (NULL local names), the real names in node_*.
  for (const [slug, engine] of [['pg', 'postgres'], ['my', 'mysql']] as const) {
    await db.insert(databases).values({
      name: slug,
      slug,
      engine,
      status: 'running',
      containerName: null,
      volumeName: null,
      serverId: node!.id,
      nodeContainerName: `nd-db-${slug}`,
      nodeVolumeName: `nd-db-${slug}-data`,
      internalHost: `nd-db-${slug}`,
      internalPort: engine === 'postgres' ? 5432 : 3306,
      passwordEncrypted: encrypt('pw'),
      pgbouncerEnabled: false,
    });
  }
  // A rolled-back 0.15 panel reads the rows through its own schema.
  const rows = await db.select().from(databases015);
  nodeRow015 = rows.find((r) => r.slug === 'pg') as unknown as Database;
  mysqlRow015 = rows.find((r) => r.slug === 'my') as unknown as Database;
});

beforeEach(() => {
  h.calls.length = 0;
});

describe('what 0.15 reads for a node database row', () => {
  it('NULL local names, and no 0.16 column at all (D6: drizzle selects declared columns only)', () => {
    expect(nodeRow015.containerName).toBeNull();
    expect(nodeRow015.volumeName).toBeNull();
    expect(Object.keys(nodeRow015)).not.toContain('serverId');
    expect(Object.keys(nodeRow015)).not.toContain('nodeContainerName');
    expect(nodeRow015.internalHost).toBe('nd-db-pg');
  });
});

/** The matrix: every database action of `mod` against the node row — refused or a no-op, no local docker. */
function markerMatrix(name: string, load: () => EngineModule) {
  describe(`${name}: every database action refuses or does nothing for a node row`, () => {
    const log = () => undefined;
    const file = () => path.join(config.paths.backupsDir, `pg-${Math.random().toString(36).slice(2)}.dump`);

    it('start (create retry, start route, doctor "Start database", template reconcile): refused — no pull, volume or container', async () => {
      await expect(load().startDatabase(nodeRow015, log)).rejects.toThrow('database has no container/volume name');
      await expect(load().startDatabase(nodeRow015, log, { labels: { 'ninedeploy.template': 'ghost' } })).rejects.toThrow(/no container\/volume name/);
      expect(h.calls).toEqual([]);
    });

    it('retained-volume adoption: nothing to adopt (no volume name)', async () => {
      await expect(load().adoptRetainedVolume(nodeRow015, log)).resolves.toEqual({ action: 'fresh' });
      expect(h.calls).toEqual([]);
    });

    it('stop (stop route, delete, limits PATCH first half): a no-op', async () => {
      await expect(load().stopDatabase(nodeRow015, log)).resolves.toBeUndefined();
      expect(h.calls).toEqual([]);
    });

    it('restart (restart route, limits PATCH second half via start): refused', async () => {
      await expect(load().restartDatabase(nodeRow015, log)).rejects.toThrow('database not runnable');
      expect(h.calls).toEqual([]);
    });

    it('backup (manual, daily tick, policy cron): refused, no dump file left behind', async () => {
      const f = file();
      await expect(load().backupDatabase(nodeRow015, f, log)).rejects.toThrow('database not runnable');
      expect(existsSync(f)).toBe(false);
      expect(h.calls).toEqual([]);
    });

    it('restore: refused', async () => {
      await expect(load().restoreDatabase(nodeRow015, file(), log)).rejects.toThrow('database not runnable');
      expect(h.calls).toEqual([]);
    });

    it('import (0.14), with and without the safety backup: refused, the safety backup recorded failed', async () => {
      const onFailed = vi.fn(async () => undefined);
      const onDone = vi.fn(async () => undefined);
      await expect(
        load().importDatabase(nodeRow015, file(), { format: 'pg_plain', safetyBackup: { file: file(), onDone, onFailed } }, log),
      ).rejects.toThrow('database not runnable');
      expect(onFailed).toHaveBeenCalledTimes(1);
      expect(onDone).not.toHaveBeenCalled();
      await expect(load().importDatabase(nodeRow015, file(), { format: 'pg_plain' }, log)).rejects.toThrow('database not runnable');
      expect(h.calls).toEqual([]);
    });

    it('logs, size, the credential and sandbox probes: empty answers', async () => {
      expect(await load().databaseLogs(nodeRow015, 100)).toEqual([]);
      expect(await load().databaseSize(nodeRow015)).toBe(0);
      expect(await load().probeDatabaseCredentials(nodeRow015, 1, 0)).toBe(false);
      expect(await load().probeMysqlSandboxFlag(mysqlRow015)).toBeNull();
      expect(h.calls).toEqual([]);
    });

    it('the service-bridge attach (template reconcile): a no-op', async () => {
      await expect(load().attachDatabaseToServiceBridges(nodeRow015, ['web'], log)).resolves.toBeUndefined();
      expect(h.calls).toEqual([]);
    });
  });
}

markerMatrix('v0.15.0 (vendored, a rolled-back panel)', () => v015);
markerMatrix('live engine/database.ts with the runtime dispatch bypassed (fault injection)', () => live as unknown as EngineModule);

describe('v0.15.0 guards outside engine/database.ts', () => {
  it('PgBouncer enable (lib/pgbouncer.ts v0.15.0): refused before any docker call; disable is a no-op', async () => {
    await expect(pgb015.enablePgbouncer(db, nodeRow015, () => undefined)).rejects.toThrow('database has no container name');
    await expect(pgb015.disablePgbouncer(db, nodeRow015, () => undefined)).resolves.toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('the database terminal and the import start route refuse a NULL container (verbatim v0.15.0 predicates)', () => {
    // modules/terminals.ts:239 at v0.15.0:
    //   if (!d.containerName || d.status !== 'running') throw err(409, 'not_running', …)
    const terminalRefuses = (d: Database) => !d.containerName || d.status !== 'running';
    // modules/databaseImports.ts:244 at v0.15.0:
    //   if (d.status !== 'running' || !d.containerName) throw conflict('The database is not running');
    const importRefuses = (d: Database) => d.status !== 'running' || !d.containerName;
    // engine/doctor.ts:345 at v0.15.0 (the database health checks):
    //   if (!d.containerName) continue;
    const doctorSkips = (d: Database) => !d.containerName;
    expect(terminalRefuses(nodeRow015)).toBe(true);
    expect(importRefuses(nodeRow015)).toBe(true);
    expect(doctorSkips(nodeRow015)).toBe(true);
  });

  it('scheduled backups that fail every day never cost the older recovery points (retention after a failed dump)', () => {
    // 7 completed scheduled dumps from before the rollback, then 30 daily failures.
    const day = 86_400_000;
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, scope: 'scheduled', status: 'failed', remoteKey: null, createdAt: new Date(40 * day - i * day) })),
      ...Array.from({ length: 7 }, (_, i) => ({ id: 1 + i, scope: 'scheduled', status: 'completed', remoteKey: null, createdAt: new Date(7 * day - i * day) })),
    ];
    const plan = planRetention(rows as never, { retainCount: 7, retainRemoteCount: null });
    for (let id = 1; id <= 7; id++) expect(plan.has(id), `completed backup #${id}`).toBe(false);
  });
});
