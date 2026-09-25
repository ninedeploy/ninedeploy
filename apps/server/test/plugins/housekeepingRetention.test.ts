/**
 * r302 — retention for the tables that had none (backup drills, workspace
 * invitations, domain transfers, registry build-cache rows), the deploy-log
 * exemption for live deployments, and the sweep of leftover drill scratch
 * files. Runs against a real migrated SQLite database: the sweeps are SQL
 * conditions (NULL handling, a correlated keep-newest subquery, a
 * seconds-vs-Date column), which a fake db would accept whatever they said.
 */
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupDrills,
  backups,
  cacheRegistryBlobs,
  createDb,
  databases,
  type DB,
  deployments,
  domainTransfers,
  domains,
  services,
  users,
  workspaceInvitations,
  workspaces,
} from '@ninedeploy/db';
import { pruneDrillLeftovers } from '../../src/lib/backupDrill.js';
import { pruneRetiredRecords, unsweepableDeploymentIds } from '../../src/plugins/housekeeping.js';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY);
const agoSec = (days: number) => Math.floor((NOW - days * DAY) / 1000);

let db: DB;
let close: () => void;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-retention-'));
  const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

describe('r302: pruneRetiredRecords', () => {
  it('sweeps finished drills past the window but keeps the newest finished drill per database and every live one', async () => {
    const [d1] = await db.insert(databases).values({ name: 'a', slug: 'a', engine: 'postgres', passwordEncrypted: 'x' }).returning();
    const [d2] = await db.insert(databases).values({ name: 'b', slug: 'b', engine: 'redis', passwordEncrypted: 'x' }).returning();
    const [b1] = await db.insert(backups).values({ databaseId: d1!.id, scope: 'db', path: '/a' }).returning();
    const [b2] = await db.insert(backups).values({ databaseId: d2!.id, scope: 'db', path: '/b' }).returning();
    const drill = (databaseId: number, backupId: number, status: 'passed' | 'failed' | 'running', days: number) =>
      db.insert(backupDrills).values({ databaseId, backupId, status, engine: 'x', startedAt: ago(days) }).returning();
    const [oldPassed] = await drill(d1!.id, b1!.id, 'passed', 200);
    const [oldFailed] = await drill(d1!.id, b1!.id, 'failed', 150);
    const [stuckRunning] = await drill(d1!.id, b1!.id, 'running', 300);
    const [recent] = await drill(d1!.id, b1!.id, 'passed', 5);
    // d2's only finished drill is old — it is still that database's last answer.
    const [onlyD2] = await drill(d2!.id, b2!.id, 'failed', 400);

    await pruneRetiredRecords(db, NOW);

    const left = (await db.select({ id: backupDrills.id }).from(backupDrills)).map((r) => r.id).sort();
    expect(left).toEqual([stuckRunning!.id, recent!.id, onlyD2!.id].sort());
    expect(left).not.toContain(oldPassed!.id);
    expect(left).not.toContain(oldFailed!.id);
  });

  // r356: `unverifiable` (the check could not run) is a finished drill too —
  // it used to fall outside the sweep and pile up forever — but it verified
  // nothing, so it never displaces a database's kept "last answer".
  it('r356: sweeps old unverifiable drills and never keeps one as the last answer', async () => {
    const [d1] = await db.insert(databases).values({ name: 'u', slug: 'u', engine: 'redis', passwordEncrypted: 'x' }).returning();
    const [b1] = await db.insert(backups).values({ databaseId: d1!.id, scope: 'db', path: '/u' }).returning();
    const drill = (status: 'passed' | 'unverifiable', days: number) =>
      db.insert(backupDrills).values({ databaseId: d1!.id, backupId: b1!.id, status, engine: 'redis', startedAt: ago(days) }).returning();
    const [lastVerdict] = await drill('passed', 400);
    const [oldUnverifiable] = await drill('unverifiable', 200);
    const [recentUnverifiable] = await drill('unverifiable', 3);

    await pruneRetiredRecords(db, NOW);

    const left = (await db.select({ id: backupDrills.id }).from(backupDrills)).map((r) => r.id);
    expect(left).toContain(lastVerdict!.id);
    expect(left).toContain(recentUnverifiable!.id);
    expect(left).not.toContain(oldUnverifiable!.id);
  });

  it('sweeps invitations revoked, accepted or expired past the grace period, never a live one', async () => {
    const [u] = await db.insert(users).values({ email: 'o@example.com', passwordHash: 'x' }).returning();
    const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: u!.id }).returning();
    let n = 0;
    const inv = (over: Partial<typeof workspaceInvitations.$inferInsert>) =>
      db
        .insert(workspaceInvitations)
        .values({
          workspaceId: ws!.id,
          email: `e${++n}@example.com`,
          token: String(n).padStart(64, '0'),
          invitedByUserId: u!.id,
          expiresAt: ago(-7),
          ...over,
        })
        .returning();
    const [live] = await inv({});
    const [oldRevoked] = await inv({ revokedAt: ago(40), expiresAt: ago(35) });
    const [recentRevoked] = await inv({ revokedAt: ago(2) });
    const [oldAccepted] = await inv({ acceptedAt: ago(45), expiresAt: ago(40) });
    const [oldExpired] = await inv({ expiresAt: ago(31) });
    const [recentExpired] = await inv({ expiresAt: ago(3) });

    await pruneRetiredRecords(db, NOW);

    const left = (await db.select({ id: workspaceInvitations.id }).from(workspaceInvitations)).map((r) => r.id).sort();
    expect(left).toEqual([live!.id, recentRevoked!.id, recentExpired!.id].sort());
    for (const gone of [oldRevoked, oldAccepted, oldExpired]) expect(left).not.toContain(gone!.id);
  });

  it('sweeps domain transfers only once they are past expiry plus the grace period', async () => {
    const [u] = await db.insert(users).values({ email: 'o@example.com', passwordHash: 'x' }).returning();
    const [svc] = await db.insert(services).values({ name: 's', slug: 's' }).returning();
    const [dom] = await db.insert(domains).values({ serviceId: svc!.id, hostname: 'a.example.com' }).returning();
    let n = 0;
    const transfer = (status: 'pending' | 'accepted' | 'cancelled', expiresAt: number) =>
      db
        .insert(domainTransfers)
        .values({ domainId: dom!.id, sourceUserId: u!.id, targetEmail: 't@example.com', tokenSha256: `h${++n}`, status, expiresAt })
        .returning();
    const [pending] = await transfer('pending', agoSec(-5));
    const [recentlyLapsed] = await transfer('pending', agoSec(10));
    const [oldLapsed] = await transfer('pending', agoSec(31));
    const [oldAccepted] = await transfer('accepted', agoSec(60));
    const [oldCancelled] = await transfer('cancelled', agoSec(45));

    await pruneRetiredRecords(db, NOW);

    const left = (await db.select({ id: domainTransfers.id }).from(domainTransfers)).map((r) => r.id).sort();
    expect(left).toEqual([pending!.id, recentlyLapsed!.id].sort());
    for (const gone of [oldLapsed, oldAccepted, oldCancelled]) expect(left).not.toContain(gone!.id);
  });

  it('sweeps registry build-cache rows that have gone cold', async () => {
    const row = (key: string, days: number) =>
      db
        .insert(cacheRegistryBlobs)
        .values({ key, backend: 'registry', repo: 'r', digest: 'sha256:x', sizeBytes: 1, lastHitAt: ago(days) })
        .returning();
    const [warm] = await row('warm', 10);
    await row('cold', 120);

    await pruneRetiredRecords(db, NOW);

    expect((await db.select({ id: cacheRegistryBlobs.id }).from(cacheRegistryBlobs)).map((r) => r.id)).toEqual([warm!.id]);
  });
});

describe('r302: unsweepableDeploymentIds', () => {
  it('names the in-flight and live deployments whose log files must survive the mtime sweep', async () => {
    const [svc] = await db.insert(services).values({ name: 's', slug: 's' }).returning();
    const ids: Record<string, number> = {};
    for (const status of ['queued', 'building', 'running', 'failed', 'superseded'] as const) {
      const [d] = await db.insert(deployments).values({ serviceId: svc!.id, status }).returning();
      ids[status] = d!.id;
    }
    const keep = await unsweepableDeploymentIds(db);
    expect([...keep].sort()).toEqual([ids['queued'], ids['building'], ids['running']].sort());
  });
});

describe('r302: pruneDrillLeftovers', () => {
  it('deletes stale plaintext drill decryptions and fetched copies, nothing else', async () => {
    const stale = new Date(NOW - 7 * 60 * 60 * 1000);
    const file = (name: string, old: boolean) => {
      const p = path.join(dir, name);
      writeFileSync(p, 'x');
      if (old) utimesSync(p, stale, stale);
      return p;
    };
    const oldDec = file('pg-2026.dump.1234-drill.dec', true);
    const oldFetch = file('nd-drill-1234-1790000000000.dump', true);
    const freshDec = file('pg-2026.dump.99-drill.dec', false);
    const backup = file('pg-2026.dump', true);

    expect(await pruneDrillLeftovers([dir, path.join(dir, 'missing')], 6 * 60 * 60 * 1000)).toBe(2);
    expect(existsSync(oldDec)).toBe(false);
    expect(existsSync(oldFetch)).toBe(false);
    expect(existsSync(freshDec)).toBe(true);
    expect(existsSync(backup)).toBe(true);
  });
});
