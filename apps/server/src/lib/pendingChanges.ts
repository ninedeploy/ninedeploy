import { eq, inArray } from 'drizzle-orm';
import { buildConfigs, settings, users, type DB, type Service } from '@ninedeploy/db';
import { updateService, type PendingChange, type PendingChangesView } from '@ninedeploy/schemas';
import { badRequest } from './errors.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G5.2 pending changes tray. With staging on, a service's edits are stored as
 * one merged `PATCH /v1/services/:id` body instead of applying. Applying sends
 * that body through the real PATCH route with the caller's own credentials
 * (`modules/pendingChanges.ts`), so every check it makes — roles, protected
 * lanes, operator-only fields, validation — applies unchanged, and the
 * changes land together or not at all.
 *
 * Security review (confused deputy): the PATCH runs with the APPLIER's
 * authority, so a member could stage an operator-only field and have an
 * operator apply it unseen. Every field therefore records who staged it, the
 * tray shows full values and stagers, and applying changes someone else
 * staged needs an explicit `includeOthers` — the applier then vouches for
 * them, as a reviewer merging someone's change does.
 *
 * No migration: one settings row per service (`pending_changes:<id>`).
 */

const key = (serviceId: number) => `pending_changes:${serviceId}`;

interface Stored {
  staging: boolean;
  patch: Record<string, unknown>;
  /** Who staged each change: `field`, or `build.<key>` for a build setting. */
  stagedBy: Record<string, number>;
  updatedAt: string | null;
  updatedByUserId: number | null;
}

const EMPTY: Stored = { staging: false, patch: {}, stagedBy: {}, updatedAt: null, updatedByUserId: null };
const TAG_FIELDS = ['tagProjectIds', 'tagWorkspaceIds', 'tagLabelIds'];

async function read(db: DB, serviceId: number): Promise<Stored> {
  const s = await getSettingJson<Stored>(db, key(serviceId), null);
  return s && typeof s === 'object' && s.patch && typeof s.patch === 'object' ? { ...EMPTY, ...s, stagedBy: { ...(s.stagedBy ?? {}) } } : { ...EMPTY };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The service's current value of each patched field (build settings from its build config). */
async function currentValues(db: DB, svc: Service, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'build' && value && typeof value === 'object') {
      const bc = (await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, svc.id) })) as Record<string, unknown> | undefined;
      out['build'] = Object.fromEntries(Object.keys(value).map((k) => [k, bc?.[k] ?? null]));
    } else {
      out[field] = (svc as unknown as Record<string, unknown>)[field] ?? null;
    }
  }
  return out;
}

/** Each change as `{ field, current, next }`, with `build` split per key. */
async function diff(db: DB, svc: Service, patch: Record<string, unknown>): Promise<Array<{ field: string; current: unknown; next: unknown }>> {
  const current = await currentValues(db, svc, patch);
  const out: Array<{ field: string; current: unknown; next: unknown }> = [];
  for (const [field, next] of Object.entries(patch)) {
    if (field === 'build' && next && typeof next === 'object') {
      for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
        const cur = (current['build'] as Record<string, unknown>)[k] ?? null;
        if (!same(cur, v)) out.push({ field: `build.${k}`, current: cur, next: v });
      }
    } else if (!same(current[field], next)) {
      out.push({ field, current: current[field], next });
    }
  }
  return out;
}

async function names(db: DB, ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<number, string>();
  if (unique.length === 0) return out;
  for (const u of await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, unique))) {
    out.set(u.id, u.name || u.email);
  }
  return out;
}

/** The stored patch as a field-level diff against the service as it is now. */
export async function pendingChanges(db: DB, svc: Service): Promise<PendingChangesView> {
  const s = await read(db, svc.id);
  const changes = await diff(db, svc, s.patch);
  const who = await names(db, [...Object.values(s.stagedBy), ...(s.updatedByUserId !== null ? [s.updatedByUserId] : [])]);
  return {
    serviceId: svc.id,
    staging: s.staging,
    changes: changes.map(
      (c): PendingChange => ({
        ...c,
        stagedByUserId: s.stagedBy[c.field] ?? null,
        stagedBy: s.stagedBy[c.field] != null ? (who.get(s.stagedBy[c.field]!) ?? null) : null,
      }),
    ),
    updatedAt: s.updatedAt,
    updatedBy: s.updatedByUserId !== null ? (who.get(s.updatedByUserId) ?? null) : null,
  };
}

/**
 * Merge an edit into the tray. The body is validated as a PATCH body would
 * be; a field set back to its current value leaves the tray.
 */
export async function stageChanges(db: DB, svc: Service, body: unknown, userId: number): Promise<PendingChangesView> {
  const raw = (body ?? {}) as Record<string, unknown>;
  const tags = TAG_FIELDS.filter((k) => raw[k] !== undefined);
  if (tags.length > 0) throw badRequest(`${tags.join(', ')} cannot be staged — use PUT /v1/services/${svc.id}/tags`, 'tags_via_put');
  const parsed = updateService.parse(raw) as Record<string, unknown>;
  // Keep exactly what the caller sent (validated), not the schema's defaults.
  const edit = Object.fromEntries(Object.keys(raw).filter((k) => k in parsed).map((k) => [k, parsed[k]]));
  const s = await read(db, svc.id);
  const patch: Record<string, unknown> = { ...s.patch };
  const stagedBy = { ...s.stagedBy };
  for (const [field, value] of Object.entries(edit)) {
    if (field === 'build' && value && typeof value === 'object') {
      patch['build'] = { ...((patch['build'] as object | undefined) ?? {}), ...(value as object) };
      for (const k of Object.keys(value)) stagedBy[`build.${k}`] = userId;
    } else {
      patch[field] = value;
      stagedBy[field] = userId;
    }
  }
  // Drop fields that would change nothing, and their stagers.
  const current = await currentValues(db, svc, patch);
  for (const field of Object.keys(patch)) {
    if (field === 'build') {
      const b = Object.fromEntries(
        Object.entries(patch['build'] as Record<string, unknown>).filter(([k, v]) => !same((current['build'] as Record<string, unknown>)[k], v)),
      );
      if (Object.keys(b).length === 0) delete patch['build'];
      else patch['build'] = b;
    } else if (same(current[field], patch[field])) {
      delete patch[field];
    }
  }
  const live = new Set((await diff(db, svc, patch)).map((c) => c.field));
  for (const f of Object.keys(stagedBy)) if (!live.has(f)) delete stagedBy[f];
  await setSettingJson(db, key(svc.id), { ...s, patch, stagedBy, updatedAt: new Date().toISOString(), updatedByUserId: userId } satisfies Stored);
  return pendingChanges(db, svc);
}

export async function setStaging(db: DB, svc: Service, staging: boolean): Promise<PendingChangesView> {
  const s = await read(db, svc.id);
  await setSettingJson(db, key(svc.id), { ...s, staging } satisfies Stored);
  return pendingChanges(db, svc);
}

/** The body `apply` sends to PATCH, or null when the tray is empty. */
export async function pendingPatch(db: DB, serviceId: number): Promise<Record<string, unknown> | null> {
  const s = await read(db, serviceId);
  return Object.keys(s.patch).length > 0 ? s.patch : null;
}

/** Empty the tray (after an apply, or to discard). Staging stays as it was. */
export async function clearPending(db: DB, serviceId: number): Promise<void> {
  const s = await read(db, serviceId);
  if (!s.staging) {
    await db.delete(settings).where(eq(settings.key, key(serviceId)));
    return;
  }
  await setSettingJson(db, key(serviceId), { ...s, patch: {}, stagedBy: {}, updatedAt: null, updatedByUserId: null } satisfies Stored);
}
