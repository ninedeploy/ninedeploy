import { and, eq, isNotNull } from 'drizzle-orm';
import { databases, projects, serviceWorkspaces, services, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import { audit } from './audit.js';
import { isOperator } from './resourceAccess.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * r710: one-shot upgrade backfill for r695.
 *
 * Before 0.10.43 a SCIM suspend/deprovision removed the seat but left the
 * user as owner of the team services and databases they created (the API's
 * own member removal has re-homed them since r097). Since r694 such a creator
 * has no access, and the deploy pipeline consults the owner's seat before it
 * injects the project's shared env (filterTrustworthyProjectLinks), so those
 * services silently deployed without it. This hands each such resource to
 * its workspace owner — the hand-over r695 performs for new removals — once,
 * on the first boot of the release that ships it.
 *
 * Conservative by construction: operator-owned and personal (untagged)
 * resources are never touched, a creator still seated in any workspace the
 * resource lives in keeps it, and a service tagged into workspaces with
 * different owners is left alone (logged) rather than given to one of them.
 */
export const OWNERSHIP_BACKFILL_KEY = 'ownership_backfill_r710';

export interface OwnershipBackfillResult {
  services: number[];
  databases: number[];
  /** Services whose workspaces have different owners — left as they are. */
  ambiguous: number[];
}

/**
 * F1002 (r976): one-shot repair for installs whose r710 marker predates F976.
 * The pre-F976 backfill counted a deactivated creator's own workspace, so a
 * team service could stay on the dead account; the marker keeps the corrected
 * backfill from ever running there. This pass applies the same rules, limited
 * to resources whose owner is deactivated, under its own marker.
 */
export const DEACTIVATED_OWNER_REPAIR_KEY = 'ownership_repair_deactivated_owner_r976';

export interface OwnershipMove {
  kind: 'service' | 'database';
  id: number;
  from: number;
  to: number;
}

export interface RehomeOptions {
  /** F1002: only resources whose owner is deactivated (the r976 repair). */
  onlyDeactivatedOwners?: boolean;
  /** Called once for every resource handed over. */
  onMove?: (move: OwnershipMove) => void;
}

async function seated(db: DB, userId: number, workspaceId: number): Promise<boolean> {
  const row = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)),
  });
  return row != null;
}

/** Run the backfill now, regardless of the done-marker. Exported for tests. */
export async function rehomeSeatlessOwners(db: DB, opts: RehomeOptions = {}): Promise<OwnershipBackfillResult> {
  const result: OwnershipBackfillResult = { services: [], databases: [], ambiguous: [] };
  const operatorCache = new Map<number, boolean>();
  const ownerIsOperator = async (id: number) => {
    let v = operatorCache.get(id);
    if (v === undefined) {
      v = await isOperator(db, { id });
      operatorCache.set(id, v);
    }
    return v;
  };
  const deactivatedCache = new Map<number, boolean>();
  const ownerIsDeactivated = async (id: number) => {
    let v = deactivatedCache.get(id);
    if (v === undefined) {
      v = (await db.query.users.findFirst({ where: eq(users.id, id) }))?.deactivatedAt != null;
      deactivatedCache.set(id, v);
    }
    return v;
  };
  const wsOwner = new Map<number, number>();
  for (const ws of await db.select({ id: workspaces.id, ownerId: workspaces.ownerId }).from(workspaces)) {
    wsOwner.set(ws.id, ws.ownerId);
  }

  const owned = await db
    .select({ id: services.id, ownerUserId: services.ownerUserId })
    .from(services)
    .where(isNotNull(services.ownerUserId));
  for (const svc of owned) {
    const ownerId = svc.ownerUserId!;
    if (opts.onlyDeactivatedOwners && !(await ownerIsDeactivated(ownerId))) continue;
    if (await ownerIsOperator(ownerId)) continue;
    const tags = await db.query.serviceWorkspaces.findMany({ where: eq(serviceWorkspaces.serviceId, svc.id) });
    let wsIds = tags.map((t) => t.workspaceId).filter((id) => wsOwner.has(id));
    // F976: a deactivated creator's own workspaces neither keep a team service
    // nor inherit it (the F884/F952 hand-over); a seat in a team they still
    // hold (SCIM PATCH keeps it) still counts.
    if (await ownerIsDeactivated(ownerId)) wsIds = wsIds.filter((id) => wsOwner.get(id) !== ownerId);
    if (wsIds.length === 0) continue; // personal service: stays its creator's
    let stillSeated = false;
    for (const wsId of wsIds) {
      if (await seated(db, ownerId, wsId)) {
        stillSeated = true;
        break;
      }
    }
    if (stillSeated) continue;
    const heirs = new Set(wsIds.map((id) => wsOwner.get(id)!));
    if (heirs.size !== 1) {
      result.ambiguous.push(svc.id);
      continue;
    }
    const heir = [...heirs][0]!;
    if (heir === ownerId) continue;
    await db.update(services).set({ ownerUserId: heir }).where(and(eq(services.id, svc.id), eq(services.ownerUserId, ownerId)));
    result.services.push(svc.id);
    opts.onMove?.({ kind: 'service', id: svc.id, from: ownerId, to: heir });
  }

  const ownedDbs = await db
    .select({ id: databases.id, ownerUserId: databases.ownerUserId, workspaceId: projects.workspaceId })
    .from(databases)
    .innerJoin(projects, eq(projects.id, databases.projectId))
    .where(isNotNull(databases.ownerUserId));
  for (const row of ownedDbs) {
    const ownerId = row.ownerUserId!;
    if (row.workspaceId == null) continue;
    const heir = wsOwner.get(row.workspaceId);
    if (heir === undefined || heir === ownerId) continue;
    if (opts.onlyDeactivatedOwners && !(await ownerIsDeactivated(ownerId))) continue;
    if (await ownerIsOperator(ownerId)) continue;
    if (await seated(db, ownerId, row.workspaceId)) continue;
    await db.update(databases).set({ ownerUserId: heir }).where(and(eq(databases.id, row.id), eq(databases.ownerUserId, ownerId)));
    result.databases.push(row.id);
    opts.onMove?.({ kind: 'database', id: row.id, from: ownerId, to: heir });
  }
  return result;
}

/**
 * Boot hook: run the backfill once per install. The marker is written only
 * after a complete pass, so a failure retries on the next boot; re-running
 * is harmless (every rule above is idempotent).
 */
export async function ensureOwnershipBackfilled(
  db: DB,
  log?: (msg: string, detail: Record<string, unknown>) => void,
): Promise<OwnershipBackfillResult | null> {
  if ((await getSettingString(db, OWNERSHIP_BACKFILL_KEY, null)) !== null) return null;
  const result = await rehomeSeatlessOwners(db);
  if (result.services.length > 0 || result.databases.length > 0) {
    const summary = `re-homed to their workspace owner: services [${result.services.join(', ')}], databases [${result.databases.join(', ')}]`;
    await audit(db, null, 'ownership.backfill', summary, { ...result });
    log?.('resources created by users who no longer hold a seat were handed to the workspace owner (r710)', { ...result });
  }
  if (result.ambiguous.length > 0) {
    log?.('services whose creator holds no seat span workspaces with different owners — left unchanged; reassign them by hand (r710)', {
      services: result.ambiguous,
    });
  }
  await setSettingString(db, OWNERSHIP_BACKFILL_KEY, new Date().toISOString());
  return result;
}

/**
 * F1002 boot hook: run the r976 repair once per install, whether or not the
 * r710 marker is set (on a fresh install the corrected backfill has already
 * done the work and this finds nothing). Each hand-over is audited and logged
 * on its own; ambiguous services are logged and left alone, as in r710. The
 * marker is written only after a complete pass.
 */
export async function ensureDeactivatedOwnersRepaired(
  db: DB,
  log?: (msg: string, detail: Record<string, unknown>) => void,
): Promise<OwnershipBackfillResult | null> {
  if ((await getSettingString(db, DEACTIVATED_OWNER_REPAIR_KEY, null)) !== null) return null;
  const moves: OwnershipMove[] = [];
  const result = await rehomeSeatlessOwners(db, { onlyDeactivatedOwners: true, onMove: (m) => moves.push(m) });
  for (const m of moves) {
    const summary = `${m.kind} #${m.id} re-homed from deactivated user #${m.from} to workspace owner #${m.to}`;
    await audit(db, null, 'ownership.backfill', summary, { ...m, repair: 'r976' });
    log?.(`a ${m.kind} owned by a deactivated user was handed to the workspace owner (r976)`, { ...m });
  }
  if (result.ambiguous.length > 0) {
    log?.('services owned by a deactivated user span workspaces with different owners — left unchanged; reassign them by hand (r976)', {
      services: result.ambiguous,
    });
  }
  await setSettingString(db, DEACTIVATED_OWNER_REPAIR_KEY, new Date().toISOString());
  return result;
}
