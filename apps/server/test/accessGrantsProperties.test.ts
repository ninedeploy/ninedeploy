/**
 * 0.15 T5 — property tests for raise-only access grants (DESIGN §4.7, owner
 * decision O5), over the shared access world (fixtures/accessWorld.ts) with
 * seeded random grants — every shape the table can hold, including rows the
 * API would refuse (a target outside the grant's workspace, role `owner`,
 * suspended rows):
 *
 *   • monotone — adding a grant never lowers anyone's role, never turns an
 *     allowed decision into a refusal, never shrinks a visible set;
 *   • local    — it never changes any OTHER user's decision;
 *   • workspace-level decisions (seats, labels, default tags) never move;
 *   • removing every grant restores exactly the frozen v0.14 decisions.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { accessGrants, createDb, type DB } from '@ninedeploy/db';

const world = await import('./fixtures/accessWorld.js');
const v014 = await import('./fixtures/resourceAccess014.js');
const { U, W, P, E } = world;
const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const RUNS = 200;

let dir: string;
let db: DB;
let close: () => void;
let live: import('./fixtures/accessWorld.js').AccessImpl;

beforeAll(async () => {
  vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-grant-props-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await world.seedWorld(db);
  live = await world.liveImpl(db);
  for (const s of await db.query.services.findMany()) ownerOfService.set(s.id, s.ownerUserId);
}, 60_000);

afterAll(() => {
  close?.();
  vi.unstubAllEnvs();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

/** mulberry32: a small seeded PRNG, so a failing run is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x0515_0071;
const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

interface RandomGrant {
  userId: number;
  workspaceId: number;
  projectId: number | null;
  environmentId: number | null;
  role: string;
  suspended: boolean;
}
/** Each target's workspace, so most random grants are ones the API would write. */
const PROJECT_WS: Record<number, number | null> = { [P.P1]: W.W1, [P.P1b]: W.W1, [P.P2]: W.W2, [P.P0]: null };
const ENV_WS: Record<number, number> = { [E.E1]: W.W1, [E.E1b]: W.W1, [E.E2]: W.W2 };
function randomGrant(rnd: () => number): RandomGrant {
  const kind = pick(rnd, ['p', 'e', 'pe'] as const);
  const projectId = kind === 'e' ? null : pick(rnd, Object.values(P));
  const environmentId = kind === 'p' ? null : pick(rnd, Object.values(E));
  // Mostly consistent (what the API writes); sometimes not — what a moved
  // project or a hand-written row leaves behind, which must count for nothing.
  const natural = projectId != null ? PROJECT_WS[projectId] : ENV_WS[environmentId!];
  const workspaceId = natural != null && rnd() < 0.85 ? natural : pick(rnd, Object.values(W));
  return {
    userId: pick(rnd, Object.values(U)),
    workspaceId,
    projectId,
    environmentId,
    role: rnd() < 0.05 ? 'owner' : pick(rnd, ['viewer', 'member', 'admin']),
    suspended: rnd() < 0.1,
  };
}
async function insert(g: RandomGrant): Promise<number | null> {
  const targetKey = g.projectId != null && g.environmentId != null ? `pe:${g.projectId}:${g.environmentId}` : g.projectId != null ? `p:${g.projectId}` : `e:${g.environmentId}`;
  const dup = await db.query.accessGrants.findFirst({ where: (t, { and, eq: e }) => and(e(t.userId, g.userId), e(t.targetKey, targetKey)) });
  if (dup) return null;
  const { suspended, ...target } = g;
  const [row] = await db
    .insert(accessGrants)
    .values({ ...target, targetKey, role: g.role as 'viewer', suspendedAt: suspended ? new Date() : null })
    .returning();
  return row!.id;
}

// ── ordering of one decision: "after ≥ before" ──
const ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
function atLeast(before: unknown, after: unknown): boolean {
  if (JSON.stringify(before) === JSON.stringify(after)) return true;
  if (before === null && typeof after === 'string' && after in ROLE_RANK) return true; // role: none → some
  if (typeof before === 'string' && before in ROLE_RANK) return typeof after === 'string' && ROLE_RANK[after]! >= ROLE_RANK[before]!;
  if (typeof before === 'string') return before !== 'ok' && (after === 'ok' || typeof after === 'string'); // a refusal may lift, 'ok' may not drop
  if (typeof before === 'boolean') return before === false && after === true;
  if (Array.isArray(before)) {
    if (after === null) return false;
    const set = new Set(after as unknown[]);
    return before.every((x) => set.has(x));
  }
  if (before === null) return Array.isArray(after); // projectScopeFilter: nothing → some
  return false;
}
/** Decisions no grant may ever move, for anyone (workspace-level, DESIGN §4.1). */
const WORKSPACE_LEVEL = /\|(assertWorkspaceRole|isWorkspaceMember|assertWorkspaceMember|userWorkspaceIds|userWorkspaceMemberships|isOperatorColumn|defaultWorkspaceIds|visibleLabelIds)/;

const usersOf = (id: number) => world.worldUsers().filter((u) => u.id === id);
const userKeyIds = new Map(world.worldUsers().map((u) => [u.key, u.id]));
/** Every service's owner (probe services included): the pipeline judges links by it. */
const ownerOfService = new Map<number, number | null>();

describe('access grant properties (seeded random grants)', () => {
  let baseline: Record<string, unknown>;

  it('baseline: with no grants the live code is v0.14.0 on this world', async () => {
    baseline = await world.snapshot(db, live, world.worldUsers(), { light: true });
    const frozen = await world.snapshot(db, { ...live, ...frozen014() }, world.worldUsers(), { light: true });
    expect(baseline).toEqual(frozen);
  }, 60_000);

  it(`monotone and local over ${RUNS} single random grants`, async () => {
    const rnd = prng(SEED);
    let applied = 0;
    for (let run = 0; run < RUNS; run++) {
      const g = randomGrant(rnd);
      const id = await insert(g);
      if (id === null) continue;
      applied++;
      // The granted user's every caller shape, plus a random bystander (every
      // bystander is checked at each step of the cumulative case below).
      const others = world.worldUsers().filter((u) => u.id !== g.userId);
      const sample = [...usersOf(g.userId), pick(rnd, others)];
      const after = await world.snapshot(db, live, sample, { light: true });
      const problems: string[] = [];
      for (const [k, v] of Object.entries(after)) {
        const before = baseline[k];
        const who = k.split('|')[0]!;
        const granted = who === 'pipeline' ? ownerOfService.get(Number(k.split('|')[2])) === g.userId : userKeyIds.get(who) === g.userId;
        if (!granted || WORKSPACE_LEVEL.test(k)) {
          if (JSON.stringify(before) !== JSON.stringify(v)) problems.push(`${k}: ${JSON.stringify(before)} → ${JSON.stringify(v)} (must not move)`);
        } else if (!atLeast(before, v)) {
          problems.push(`${k}: ${JSON.stringify(before)} → ${JSON.stringify(v)} (lowered)`);
        }
      }
      expect(problems, `run ${run} grant ${JSON.stringify(g)}`).toEqual([]);
      await db.delete(accessGrants).where(eq(accessGrants.id, id));
    }
    expect(applied).toBeGreaterThan(RUNS * 0.9);
  }, 300_000);

  it('cumulative random grants only ever add, and removing them all restores v0.14.0', async () => {
    const rnd = prng(SEED ^ 0xa11);
    let prev = baseline;
    let raised = 0;
    for (let step = 0; step < 15; step++) {
      await insert(randomGrant(rnd));
      const now = await world.snapshot(db, live, world.worldUsers(), { light: true });
      const lowered = Object.keys(now).filter((k) => !atLeast(prev[k], now[k]) || (WORKSPACE_LEVEL.test(k) && JSON.stringify(prev[k]) !== JSON.stringify(now[k])));
      expect(lowered.map((k) => `${k}: ${JSON.stringify(prev[k])} → ${JSON.stringify(now[k])}`), `step ${step}`).toEqual([]);
      raised += Object.keys(now).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(now[k])).length;
      prev = now;
    }
    // The grants did something: this is not a vacuous pass.
    expect(raised).toBeGreaterThan(5);
    await db.delete(accessGrants);
    expect(await world.snapshot(db, live, world.worldUsers(), { light: true })).toEqual(baseline);
  }, 300_000);
});

/** The frozen v0.14.0 functions over the live adapter (environment pieces included). */
function frozen014(): Partial<import('./fixtures/accessWorld.js').AccessImpl> {
  return {
    loadServiceForUser: v014.loadServiceForUser,
    serviceRole: v014.serviceRole,
    assertServiceRole: v014.assertServiceRole,
    visibleServiceIdSet: v014.visibleServiceIdSet,
    loadProjectForUser: v014.loadProjectForUser,
    projectScopeFilter: v014.projectScopeFilter,
    loadDatabaseForUser: v014.loadDatabaseForUser,
    visibleDatabaseIds: v014.visibleDatabaseIds,
    databaseRole: v014.databaseRole,
    assertDatabaseRole: v014.assertDatabaseRole,
    assertWorkspaceRole: v014.assertWorkspaceRole,
    isWorkspaceMember: v014.isWorkspaceMember,
    assertWorkspaceMember: v014.assertWorkspaceMember,
    userWorkspaceIds: v014.userWorkspaceIds,
    userWorkspaceMemberships: v014.userWorkspaceMemberships,
    isOperator: v014.isOperator,
    requireResourceAccess: v014.requireResourceAccess,
    assertCanManageService: v014.assertCanManageService,
    projectWrite: async (d, p, u, r) => {
      if (!u.isOperator) await v014.assertWorkspaceRole(d, p.workspaceId, u, r);
    },
    visibleProjectIds: (d, u, ids, r) => v014.visibleProjectIds014(d, u, ids, r),
    filterTrustworthyProjectLinks: v014.filterTrustworthyProjectLinks014,
    defaultWorkspaceIdsForUser: v014.defaultWorkspaceIdsForUser014,
    visibleLabelIds: v014.visibleLabelIds014,
    environmentSelectable: async (u, envId) => {
      const e = await db.query.environments.findFirst({ where: (t, { eq: x }) => x(t.id, envId) });
      return v014.environmentSelectable014(db, u, e!);
    },
    visibleEnvironmentIds: (u) => v014.visibleEnvironmentIds014(db, u),
  };
}
