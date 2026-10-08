/**
 * The access-resolution world shared by the 0.15 grant tests (DESIGN §4.7):
 * one seeded SQLite with every shape of user, service, project, database and
 * environment the v0.14 resolution code distinguishes, plus a `snapshot` that
 * records every access decision an implementation makes on it.
 *
 * `accessGrantsEquivalence.test.ts` compares the live code with the frozen
 * v0.14 copy (`resourceAccess014.ts`) on this world; the property tests add
 * random grants to it.
 */
import { type SQL, sql } from 'drizzle-orm';
import {
  databases,
  environments,
  labels,
  projects,
  serviceProjects,
  serviceWorkspaces,
  services,
  users,
  workspaceMembers,
  workspaces,
  type DB,
} from '@ninedeploy/db';

export const ROLES = ['viewer', 'member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export interface WorldUser {
  key: string;
  id: number;
  isOperator: boolean;
}

/** Fixed ids, so every run (and every implementation) sees the same world. */
export const W = { W1: 1, W2: 2, W3: 3 } as const;
export const P = { P1: 1, P2: 2, P0: 3, P1b: 4 } as const;
export const E = { E1: 1, E1b: 2, E2: 3 } as const;
export const U = {
  operator: 1,
  ownerW1: 2,
  adminW1: 3,
  memberW1: 4,
  viewerW1: 5,
  multi: 6,
  ownerW2: 7,
  leaver: 8,
  outsider: 9,
  deactivated: 10,
  deactOperator: 11,
  viewerW2: 12,
} as const;
/** An untagged service each user owns, for the HTTP environment-selection probe. */
export const probeServiceId = (userId: number) => 200 + userId;

interface SvcSpec {
  id: number;
  owner: number | null;
  ws: number[];
  projects: number[];
  env: number | null;
}
export const SERVICES: SvcSpec[] = [
  { id: 101, owner: U.leaver, ws: [], projects: [], env: null },
  { id: 102, owner: U.memberW1, ws: [], projects: [], env: E.E1 },
  { id: 103, owner: null, ws: [], projects: [], env: null },
  { id: 104, owner: U.leaver, ws: [W.W1], projects: [P.P1], env: E.E1 },
  { id: 105, owner: U.memberW1, ws: [W.W1], projects: [], env: E.E1b },
  { id: 106, owner: U.multi, ws: [W.W1, W.W2], projects: [P.P1, P.P2], env: E.E2 },
  { id: 107, owner: U.ownerW2, ws: [W.W2], projects: [P.P2], env: null },
  { id: 108, owner: null, ws: [W.W1], projects: [P.P0], env: E.E1 },
  { id: 109, owner: U.deactOperator, ws: [W.W2], projects: [P.P2], env: E.E2 },
  { id: 110, owner: U.viewerW1, ws: [W.W1], projects: [P.P1], env: E.E1 },
  { id: 111, owner: U.deactivated, ws: [W.W1], projects: [P.P1, P.P1b], env: E.E1b },
  { id: 112, owner: U.outsider, ws: [W.W2], projects: [P.P1], env: E.E1 },
];
export const DATABASES: Array<{ id: number; owner: number | null; project: number | null }> = [
  { id: 301, owner: U.leaver, project: null },
  { id: 302, owner: null, project: null },
  { id: 303, owner: U.memberW1, project: P.P0 },
  { id: 304, owner: U.leaver, project: P.P1 },
  { id: 305, owner: null, project: P.P1 },
  { id: 306, owner: U.multi, project: P.P2 },
  { id: 307, owner: U.memberW1, project: P.P1 },
  { id: 308, owner: U.viewerW1, project: P.P1b },
  { id: 309, owner: U.outsider, project: P.P2 },
];

/** Every caller shape, as `req.user` would carry it. */
export function worldUsers(): WorldUser[] {
  const out: WorldUser[] = Object.entries(U).map(([key, id]) => ({
    key,
    id,
    // The auth plugin's flag: the column, and never for a deactivated account.
    isOperator: id === U.operator,
  }));
  // An operator behind a scope-restricted API token runs as a non-operator.
  out.push({ key: 'operatorNarrowed', id: U.operator, isOperator: false });
  // A request that still carries the flag for a deactivated operator (the
  // resolver refuses them; the helpers must agree on what the flag means).
  out.push({ key: 'deactOperatorFlag', id: U.deactOperator, isOperator: true });
  // A user id with no row at all.
  out.push({ key: 'ghost', id: 999, isOperator: false });
  return out;
}

export async function seedWorld(db: DB): Promise<void> {
  const past = new Date(Date.now() - 86_400_000);
  const user = (id: number, key: string, extra: Partial<typeof users.$inferInsert> = {}) => ({
    id,
    email: `${key.toLowerCase()}@world.test`,
    passwordHash: 'x',
    name: key,
    ...extra,
  });
  await db.insert(users).values(
    Object.entries(U).map(([key, id]) =>
      user(id, key, {
        isInstanceOperator: id === U.operator || id === U.deactOperator,
        ...(id === U.deactivated || id === U.deactOperator ? { deactivatedAt: past } : {}),
      }),
    ),
  );
  await db.insert(workspaces).values([
    { id: W.W1, name: 'W1', slug: 'w1', ownerId: U.ownerW1 },
    { id: W.W2, name: 'W2', slug: 'w2', ownerId: U.ownerW2 },
    // Nobody holds a seat in W3.
    { id: W.W3, name: 'W3', slug: 'w3', ownerId: U.ownerW1 },
  ]);
  await db.insert(workspaceMembers).values([
    { workspaceId: W.W1, userId: U.ownerW1, role: 'owner' },
    { workspaceId: W.W1, userId: U.adminW1, role: 'admin' },
    { workspaceId: W.W1, userId: U.memberW1, role: 'member' },
    { workspaceId: W.W1, userId: U.viewerW1, role: 'viewer' },
    { workspaceId: W.W1, userId: U.multi, role: 'member' },
    { workspaceId: W.W2, userId: U.multi, role: 'admin' },
    { workspaceId: W.W2, userId: U.ownerW2, role: 'owner' },
    { workspaceId: W.W1, userId: U.deactivated, role: 'member' },
    { workspaceId: W.W2, userId: U.deactOperator, role: 'viewer' },
    { workspaceId: W.W2, userId: U.viewerW2, role: 'viewer' },
  ]);
  await db.insert(projects).values([
    { id: P.P1, workspaceId: W.W1, name: 'P1', slug: 'p1' },
    { id: P.P2, workspaceId: W.W2, name: 'P2', slug: 'p2' },
    { id: P.P0, workspaceId: null, name: 'P0', slug: 'p0' },
    { id: P.P1b, workspaceId: W.W1, name: 'P1b', slug: 'p1b' },
  ]);
  await db.insert(environments).values([
    { id: E.E1, workspaceId: W.W1, name: 'alpha', slug: 'alpha' },
    { id: E.E1b, workspaceId: W.W1, name: 'beta', slug: 'beta' },
    { id: E.E2, workspaceId: W.W2, name: 'gamma', slug: 'gamma' },
  ]);
  await db.insert(labels).values([
    { id: 1, workspaceId: W.W1, name: 'L1' },
    { id: 2, workspaceId: W.W2, name: 'L2' },
    { id: 3, workspaceId: null, name: 'L0' },
  ]);
  const svc = (id: number, owner: number | null, env: number | null) => ({
    id,
    ownerUserId: owner,
    name: `svc-${id}`,
    slug: `svc-${id}`,
    type: 'docker' as const,
    image: 'nginx:alpine',
    port: 80,
    status: 'idle' as const,
    environmentId: env,
  });
  await db.insert(services).values([
    ...SERVICES.map((s) => svc(s.id, s.owner, s.env)),
    ...Object.values(U).map((uid) => svc(probeServiceId(uid), uid, null)),
  ]);
  const tags = SERVICES.flatMap((s) => s.ws.map((workspaceId) => ({ serviceId: s.id, workspaceId })));
  if (tags.length) await db.insert(serviceWorkspaces).values(tags);
  const links = SERVICES.flatMap((s) => s.projects.map((projectId) => ({ serviceId: s.id, projectId })));
  if (links.length) await db.insert(serviceProjects).values(links);
  await db.insert(databases).values(
    DATABASES.map((d) => ({
      id: d.id,
      projectId: d.project,
      ownerUserId: d.owner,
      name: `db-${d.id}`,
      slug: `db-${d.id}`,
      engine: 'postgres' as const,
      status: 'running' as const,
      containerName: `nd-db-db-${d.id}`,
      internalHost: `nd-db-db-${d.id}`,
      internalPort: 5432,
      username: 'app',
      dbName: 'app',
      volumeName: `nd-db-db-${d.id}-data`,
      passwordEncrypted: 'x',
    })),
  );
}

/** What an access call did: `ok`, or the HTTP status and message it threw. */
export async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    return e.statusCode ? `${e.statusCode}:${e.message}` : `throw:${e.message}`;
  }
}

type AnyUser = { id: number; isOperator: boolean };
type Row<T> = T extends (...a: never[]) => Promise<infer R> ? R : never;

/**
 * Every decision the snapshot records. Both the v0.14 fixture and the live
 * code are adapted to this shape; a method missing from one side is a test
 * bug, not a skipped check.
 */
export interface AccessImpl {
  loadServiceForUser(db: DB, id: number, user: AnyUser): Promise<{ id: number }>;
  serviceRole(db: DB, svc: { id: number; ownerUserId: number | null }, user: AnyUser): Promise<string | null>;
  assertServiceRole(db: DB, svc: { id: number; ownerUserId: number | null }, user: AnyUser, r: Role): Promise<void>;
  visibleServiceIdSet(db: DB, user: AnyUser): Promise<Set<number> | null>;
  loadProjectForUser(db: DB, id: number, user: AnyUser): Promise<{ id: number }>;
  projectScopeFilter(db: DB, user: AnyUser): Promise<unknown>;
  loadDatabaseForUser(db: DB, id: number, user: AnyUser): Promise<{ id: number }>;
  visibleDatabaseIds(db: DB, user: AnyUser): Promise<number[] | null>;
  databaseRole(db: DB, row: { ownerUserId: number | null; projectId: number | null }, user: AnyUser): Promise<string | null>;
  assertDatabaseRole(db: DB, row: { ownerUserId: number | null; projectId: number | null }, user: AnyUser, r: Role): Promise<void>;
  assertWorkspaceRole(db: DB, wsId: number, user: AnyUser, r: Role | Role[]): Promise<void>;
  isWorkspaceMember(db: DB, wsId: number, user: { id: number }): Promise<boolean>;
  assertWorkspaceMember(db: DB, wsId: number, user: AnyUser): Promise<void>;
  userWorkspaceIds(db: DB, userId: number): Promise<number[]>;
  userWorkspaceMemberships(db: DB, userId: number): Promise<Array<{ workspaceId: number; role: string }>>;
  isOperator(db: DB, user: { id: number }): Promise<boolean>;
  requireResourceAccess(db: DB, kind: 'service' | 'project' | 'database', id: number, user: AnyUser): Promise<unknown>;
  assertCanManageService(svc: { id: number; ownerUserId: number | null }, user: AnyUser): void;
  /** The project-targeted call sites (databases.ts create, env.ts project env writes) for a project WITH a workspace. */
  projectWrite(db: DB, project: { id: number; workspaceId: number }, user: AnyUser, r: Role): Promise<void>;
  visibleProjectIds(db: DB, user: AnyUser, ids: number[], minRole: Role): Promise<number[]>;
  filterTrustworthyProjectLinks(db: DB, svc: { ownerUserId: number | null }, links: Array<{ projectId: number }>): Promise<Array<{ projectId: number }>>;
  defaultWorkspaceIdsForUser(db: DB, user: { id: number }): Promise<number[]>;
  visibleLabelIds(db: DB, user: AnyUser, ids: number[]): Promise<number[]>;
  /** The environment-selection predicate (services.ts create and PATCH). */
  environmentSelectable(user: AnyUser, envId: number): Promise<boolean>;
  /** GET /v1/environments: the ids listed. */
  visibleEnvironmentIds(user: AnyUser): Promise<number[]>;
}

const sorted = (xs: Iterable<number>) => [...xs].sort((a, b) => a - b);

/**
 * Record every decision `impl` makes for `who` in `world`. Keys read
 * `<user>|<check>|<target>`; values are plain JSON, so two snapshots compare
 * with `toEqual` and a diff names the exact decision that moved.
 */
export async function snapshot(
  db: DB,
  impl: AccessImpl,
  who: WorldUser[] = worldUsers(),
  opts: { light?: boolean } = {},
): Promise<Record<string, unknown>> {
  // `light` skips the decisions derived from others (per-role asserts, the
  // generic dispatcher), for the property runs that take hundreds of snapshots.
  const full = opts.light !== true;
  const out: Record<string, unknown> = {};
  const svcRows = await db.select().from(services);
  const dbRows = await db.select().from(databases);
  const projRows = await db.select().from(projects);
  const projIds = sorted(projRows.map((p) => p.id));
  const envIds = Object.values(E);
  const wsIds = [...Object.values(W), 99];
  for (const u of who) {
    const user = { id: u.id, isOperator: u.isOperator };
    const k = (check: string, target: string | number = '-') => `${u.key}|${check}|${target}`;
    for (const s of svcRows) {
      out[k('loadService', s.id)] = await outcome(() => impl.loadServiceForUser(db, s.id, user));
      out[k('serviceRole', s.id)] = await impl.serviceRole(db, s, user);
      if (!full) continue;
      for (const r of ROLES) out[k(`assertServiceRole:${r}`, s.id)] = await outcome(() => impl.assertServiceRole(db, s, user, r));
      out[k('canManageService', s.id)] = await outcome(async () => impl.assertCanManageService(s, user));
      out[k('requireAccess:service', s.id)] = await outcome(() => impl.requireResourceAccess(db, 'service', s.id, user));
    }
    out[k('loadService', 99_999)] = await outcome(() => impl.loadServiceForUser(db, 99_999, user));
    const vis = await impl.visibleServiceIdSet(db, user);
    out[k('visibleServiceIdSet')] = vis === null ? null : sorted(vis);
    for (const p of projRows) {
      out[k('loadProject', p.id)] = await outcome(() => impl.loadProjectForUser(db, p.id, user));
      if (full) out[k('requireAccess:project', p.id)] = await outcome(() => impl.requireResourceAccess(db, 'project', p.id, user));
      if (p.workspaceId != null) {
        for (const r of full ? ROLES : (['member'] as const)) {
          out[k(`projectWrite:${r}`, p.id)] = await outcome(() =>
            impl.projectWrite(db, { id: p.id, workspaceId: p.workspaceId! }, user, r),
          );
        }
      }
    }
    const filter = await impl.projectScopeFilter(db, user);
    out[k('projectScopeFilter')] =
      filter === null
        ? null
        : sorted(
            (filter === undefined
              ? await db.select({ id: projects.id }).from(projects)
              : await db.select({ id: projects.id }).from(projects).where(filter as SQL)
            ).map((r) => r.id),
          );
    for (const d of dbRows) {
      out[k('loadDatabase', d.id)] = await outcome(() => impl.loadDatabaseForUser(db, d.id, user));
      out[k('databaseRole', d.id)] = await impl.databaseRole(db, d, user);
      if (!full) continue;
      for (const r of ROLES) out[k(`assertDatabaseRole:${r}`, d.id)] = await outcome(() => impl.assertDatabaseRole(db, d, user, r));
      out[k('requireAccess:database', d.id)] = await outcome(() => impl.requireResourceAccess(db, 'database', d.id, user));
    }
    const vdb = await impl.visibleDatabaseIds(db, user);
    out[k('visibleDatabaseIds')] = vdb === null ? null : sorted(vdb);
    for (const w of wsIds) {
      for (const r of full ? ROLES : (['viewer'] as const)) {
        out[k(`assertWorkspaceRole:${r}`, w)] = await outcome(() => impl.assertWorkspaceRole(db, w, user, r));
      }
      out[k('assertWorkspaceRole:[owner,viewer]', w)] = await outcome(() => impl.assertWorkspaceRole(db, w, user, ['owner', 'viewer']));
      out[k('isWorkspaceMember', w)] = await impl.isWorkspaceMember(db, w, user);
      out[k('assertWorkspaceMember', w)] = await outcome(() => impl.assertWorkspaceMember(db, w, user));
    }
    out[k('userWorkspaceIds')] = sorted(await impl.userWorkspaceIds(db, user.id));
    out[k('userWorkspaceMemberships')] = (await impl.userWorkspaceMemberships(db, user.id))
      .map((m) => `${m.workspaceId}:${m.role}`)
      .sort();
    out[k('isOperatorColumn')] = await impl.isOperator(db, user);
    for (const r of ROLES) out[k(`visibleProjectIds:${r}`)] = sorted(await impl.visibleProjectIds(db, user, [...projIds, 99], r));
    out[k('visibleProjectIds:empty')] = await impl.visibleProjectIds(db, user, [], 'viewer');
    out[k('defaultWorkspaceIds')] = sorted(await impl.defaultWorkspaceIdsForUser(db, user));
    out[k('visibleLabelIds')] = sorted(await impl.visibleLabelIds(db, user, [1, 2, 3, 99]));
    out[k('environmentList')] = sorted(await impl.visibleEnvironmentIds(user));
    for (const e of envIds) out[k('environmentSelectable', e)] = await impl.environmentSelectable(user, e);
  }
  // Not per caller: the pipeline judges a service's links by its OWNER.
  for (const s of svcRows) {
    const links = projIds.map((projectId) => ({ projectId }));
    out[`pipeline|trustworthyLinks|${s.id}`] = (await impl.filterTrustworthyProjectLinks(db, s, links)).map((l) => l.projectId);
  }
  return out;
}

export type Snapshot = Row<typeof snapshot>;

/** Raw row counts, to prove a snapshot run wrote nothing. */
export async function tableCounts(db: DB): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ['users', 'workspaces', 'workspace_members', 'services', 'databases', 'projects', 'environments', 'access_grants']) {
    const [row] = (await db.all(sql.raw(`SELECT count(*) AS n FROM ${t}`))) as Array<{ n: number }>;
    out[t] = row!.n;
  }
  return out;
}

/**
 * The live 0.15 helpers in the snapshot's shape, every decision asked as a
 * function (no HTTP). Loaded lazily so a test's `vi.mock`s apply first.
 */
export async function liveImpl(d: DB): Promise<AccessImpl> {
  const ra = await import('../../src/lib/resourceAccess.js');
  const { visibleProjectIds } = await import('../../src/modules/projects.js');
  const { filterTrustworthyProjectLinks } = await import('../../src/engine/pipeline.js');
  const { defaultWorkspaceIdsForUser } = await import('../../src/modules/serviceTags.js');
  const { visibleLabelIds } = await import('../../src/modules/labels.js');
  return {
    loadServiceForUser: ra.loadServiceForUser,
    serviceRole: ra.serviceRole,
    assertServiceRole: ra.assertServiceRole,
    visibleServiceIdSet: ra.visibleServiceIdSet,
    loadProjectForUser: ra.loadProjectForUser,
    projectScopeFilter: ra.projectScopeFilter,
    loadDatabaseForUser: ra.loadDatabaseForUser,
    visibleDatabaseIds: ra.visibleDatabaseIds,
    databaseRole: ra.databaseRole,
    assertDatabaseRole: ra.assertDatabaseRole,
    assertWorkspaceRole: ra.assertWorkspaceRole,
    isWorkspaceMember: ra.isWorkspaceMember,
    assertWorkspaceMember: ra.assertWorkspaceMember,
    userWorkspaceIds: ra.userWorkspaceIds,
    userWorkspaceMemberships: ra.userWorkspaceMemberships,
    isOperator: ra.isOperator,
    requireResourceAccess: ra.requireResourceAccess,
    assertCanManageService: ra.assertCanManageService,
    projectWrite: async (x, p, u, r) => {
      if (!u.isOperator) await ra.assertProjectRole(x, p, u, r);
    },
    visibleProjectIds: (x, u, ids, r) => visibleProjectIds(x, u, ids, r),
    filterTrustworthyProjectLinks,
    defaultWorkspaceIdsForUser,
    visibleLabelIds,
    environmentSelectable: async (u, envId) => {
      const e = await d.query.environments.findFirst({ where: (t, { eq }) => eq(t.id, envId) });
      return ra.mayUseEnvironment(d, u, e!);
    },
    visibleEnvironmentIds: async (u) => {
      const scope = await ra.environmentVisibility(d, u);
      const all = await d.query.environments.findMany();
      return all
        .filter((e) => scope === null || scope.workspaceIds.has(e.workspaceId) || scope.environmentIds.has(e.id))
        .map((e) => e.id);
    },
  };
}
