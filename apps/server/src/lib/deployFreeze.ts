import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { environments, projects, serviceProjects, services, serviceWorkspaces, users, workspaces, type DB } from '@ninedeploy/db';
import {
  DEPLOY_FREEZES_MAX,
  deployFreezeCreate,
  type DeployFreeze,
  type DeployFreezeCreate,
  type DeployFreezeScope,
} from '@ninedeploy/schemas';
import { badRequest, notFound } from './errors.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G5.5 deploy freezes. An operator blocks deploys for the whole instance, a
 * workspace, a project or an environment (lane), with a reason and an
 * optional expiry. The worker checks {@link freezeHolding} at claim time, so
 * every trigger (UI, API, git push, deploy hook, schedule, image poll,
 * rollback) is held without each insert knowing: a held deploy stays
 * `queued` and starts once the freeze ends or is lifted.
 *
 * No migration: the freezes are one settings row (a JSON list). An expired
 * freeze stops holding at once and is pruned on the next write or list.
 */

const SETTING_KEY = 'deploy_freezes';

interface StoredFreeze {
  id: string;
  scope: DeployFreezeScope;
  targetId: number | null;
  reason: string;
  until: string | null;
  createdAt: string;
  createdByUserId: number | null;
}

const active = (f: StoredFreeze, now = Date.now()) => f.until === null || Date.parse(f.until) > now;

async function readAll(db: DB): Promise<StoredFreeze[]> {
  const list = await getSettingJson<StoredFreeze[]>(db, SETTING_KEY, []);
  return Array.isArray(list) ? list : [];
}

/** Writes of the list are serialized: two operators freezing at once must not lose one. */
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

async function targetExists(db: DB, scope: DeployFreezeScope, id: number): Promise<boolean> {
  const table = scope === 'workspace' ? workspaces : scope === 'project' ? projects : environments;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  return row !== undefined;
}

async function present(db: DB, list: StoredFreeze[]): Promise<DeployFreeze[]> {
  const ids = (scope: DeployFreezeScope) => list.filter((f) => f.scope === scope).map((f) => f.targetId!);
  const names = new Map<string, string>();
  const load = async (scope: DeployFreezeScope, table: typeof workspaces | typeof projects | typeof environments) => {
    const wanted = ids(scope);
    if (wanted.length === 0) return;
    for (const r of await db.select({ id: table.id, name: table.name }).from(table).where(inArray(table.id, wanted))) {
      names.set(`${scope}:${r.id}`, r.name);
    }
  };
  await load('workspace', workspaces);
  await load('project', projects);
  await load('environment', environments);
  const creatorIds = [...new Set(list.map((f) => f.createdByUserId).filter((v): v is number => v !== null))];
  const creators = new Map<number, string>();
  if (creatorIds.length > 0) {
    for (const u of await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, creatorIds))) {
      creators.set(u.id, u.name || u.email);
    }
  }
  return list.map((f) => ({
    id: f.id,
    scope: f.scope,
    targetId: f.targetId,
    targetName: f.targetId === null ? null : (names.get(`${f.scope}:${f.targetId}`) ?? null),
    reason: f.reason,
    until: f.until,
    createdAt: f.createdAt,
    createdBy: f.createdByUserId === null ? null : (creators.get(f.createdByUserId) ?? null),
  }));
}

/** The freezes in force now, newest first. */
export async function listDeployFreezes(db: DB): Promise<DeployFreeze[]> {
  const now = Date.now();
  return present(db, (await readAll(db)).filter((f) => active(f, now)).reverse());
}

export async function createDeployFreeze(db: DB, raw: DeployFreezeCreate, userId: number | null): Promise<DeployFreeze> {
  const input = deployFreezeCreate.parse(raw);
  if (input.until !== null && Date.parse(input.until) <= Date.now()) throw badRequest('The freeze would already be over: pick a later end');
  if (input.targetId !== null && !(await targetExists(db, input.scope, input.targetId))) throw notFound(`No such ${input.scope}`);
  const freeze: StoredFreeze = {
    id: randomUUID(),
    scope: input.scope,
    targetId: input.targetId,
    reason: input.reason,
    until: input.until === null ? null : new Date(input.until).toISOString(),
    createdAt: new Date().toISOString(),
    createdByUserId: userId,
  };
  await serialized(async () => {
    const now = Date.now();
    const list = (await readAll(db)).filter((f) => active(f, now));
    if (list.length >= DEPLOY_FREEZES_MAX) throw badRequest(`At most ${DEPLOY_FREEZES_MAX} deploy freezes can be in force; lift one first`);
    await setSettingJson(db, SETTING_KEY, [...list, freeze]);
  });
  return (await present(db, [freeze]))[0]!;
}

/** Lift a freeze; held deploys start on the worker's next pass. Returns the lifted freeze. */
export async function liftDeployFreeze(db: DB, id: string): Promise<DeployFreeze> {
  return serialized(async () => {
    const now = Date.now();
    const list = await readAll(db);
    const found = list.find((f) => f.id === id && active(f, now));
    if (!found) throw notFound('No such deploy freeze in force');
    await setSettingJson(
      db,
      SETTING_KEY,
      list.filter((f) => f.id !== id && active(f, now)),
    );
    return (await present(db, [found]))[0]!;
  });
}

/** True while any freeze is in force: the worker's cheap check before {@link freezeHolding}. */
export async function anyDeployFreeze(db: DB): Promise<boolean> {
  const now = Date.now();
  return (await readAll(db)).some((f) => active(f, now));
}

/**
 * The freeze that holds a deploy of this service now, or null. A PR preview
 * also takes its parent's lane, workspaces and projects: it runs the parent's
 * configuration, so a freeze on the parent covers it.
 */
export async function freezeHolding(
  db: DB,
  service: { serviceId: number; environmentId: number | null; previewParentServiceId: number | null },
): Promise<DeployFreeze | null> {
  const now = Date.now();
  const list = (await readAll(db)).filter((f) => active(f, now));
  if (list.length === 0) return null;
  const instance = list.find((f) => f.scope === 'instance');
  if (instance) return (await present(db, [instance]))[0]!;

  const ids = [service.serviceId];
  const envIds = new Set<number>();
  if (service.environmentId !== null) envIds.add(service.environmentId);
  if (service.previewParentServiceId !== null) {
    ids.push(service.previewParentServiceId);
    const parent = await db.query.services.findFirst({
      where: eq(services.id, service.previewParentServiceId),
      columns: { environmentId: true },
    });
    if (parent?.environmentId != null) envIds.add(parent.environmentId);
  }
  const workspaceIds = new Set<number>();
  const projectIds = new Set<number>();
  if (list.some((f) => f.scope === 'workspace')) {
    for (const r of await db.select({ id: serviceWorkspaces.workspaceId }).from(serviceWorkspaces).where(inArray(serviceWorkspaces.serviceId, ids))) {
      workspaceIds.add(r.id);
    }
    // A lane belongs to a workspace: freezing the workspace covers its lanes' services.
    if (envIds.size > 0) {
      for (const r of await db.select({ id: environments.workspaceId }).from(environments).where(inArray(environments.id, [...envIds]))) {
        workspaceIds.add(r.id);
      }
    }
  }
  if (list.some((f) => f.scope === 'project')) {
    for (const r of await db.select({ id: serviceProjects.projectId }).from(serviceProjects).where(inArray(serviceProjects.serviceId, ids))) {
      projectIds.add(r.id);
    }
  }
  const hit = list.find(
    (f) =>
      (f.scope === 'environment' && envIds.has(f.targetId!)) ||
      (f.scope === 'workspace' && workspaceIds.has(f.targetId!)) ||
      (f.scope === 'project' && projectIds.has(f.targetId!)),
  );
  return hit ? (await present(db, [hit]))[0]! : null;
}

/** The deploy-log line for a held deploy. */
export function freezeLogLine(f: DeployFreeze): string {
  const what = f.scope === 'instance' ? 'all deploys' : `${f.scope} ${f.targetName ? `"${f.targetName}"` : `#${f.targetId}`}`;
  const until = f.until ? ` until ${f.until}` : ' until an operator lifts it';
  return `⏸ Deploy freeze on ${what}${until}: ${f.reason}. This deploy waits in the queue and starts once the freeze ends.`;
}
