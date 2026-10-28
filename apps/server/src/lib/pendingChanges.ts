import { randomUUID } from 'node:crypto';
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
 * Security review:
 *  - Confused deputy: the PATCH runs with the APPLIER's authority, so every
 *    field records who staged it, and applying someone else's change needs
 *    an explicit `includeOthers`.
 *  - Disclosure: the diff shows a caller only what `GET /v1/services/:id`
 *    shows them (`VisibleView`); any other field is masked, now and after.
 *  - TOCTOU: apply names the opaque tray `version` it reviewed,
 *    and works from one snapshot; the tray is then cleared field by field,
 *    only where the stored value is still the applied one.
 *
 * No migration: one settings row per service (`pending_changes:<id>`).
 */

const key = (serviceId: number) => `pending_changes:${serviceId}`;

export interface Stored {
  staging: boolean;
  patch: Record<string, unknown>;
  /** Who staged each change: `field`, or `build.<key>` for a build setting. */
  stagedBy: Record<string, number>;
  updatedAt: string | null;
  version?: string | null;
  updatedByUserId: number | null;
}

/**
 * What the caller may see of the service, as `GET /v1/services/:id` answers
 * it: top-level fields, and the build settings. A field missing here is
 * masked in the tray.
 */
export interface VisibleView {
  fields: Record<string, unknown>;
  build: Record<string, unknown> | null;
}

const EMPTY: Stored = { staging: false, patch: {}, stagedBy: {}, updatedAt: null, updatedByUserId: null };
const TAG_FIELDS = ['tagProjectIds', 'tagWorkspaceIds', 'tagLabelIds'];

export async function readPending(db: DB, serviceId: number): Promise<Stored> {
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

/** Each change as `{ field, current, next }` (unmasked), with `build` split per key. */
export async function rawChanges(db: DB, svc: Service, patch: Record<string, unknown>): Promise<Array<{ field: string; current: unknown; next: unknown }>> {
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

/** Whether the caller's GET view shows this tray field. */
function visibleTo(view: VisibleView, field: string): boolean {
  if (field.startsWith('build.')) return view.build !== null && field.slice('build.'.length) in view.build;
  return field in view.fields;
}

/** The tray as a field-level diff for one caller (fields it cannot see are masked). */
export async function pendingChanges(db: DB, svc: Service, view: VisibleView, stored?: Stored): Promise<PendingChangesView> {
  const s = stored ?? (await readPending(db, svc.id));
  const changes = await rawChanges(db, svc, s.patch);
  const who = await names(db, [...Object.values(s.stagedBy), ...(s.updatedByUserId !== null ? [s.updatedByUserId] : [])]);
  return {
    serviceId: svc.id,
    staging: s.staging,
    changes: changes.map((c): PendingChange => {
      const masked = !visibleTo(view, c.field);
      return {
        field: c.field,
        current: masked ? null : c.current,
        next: masked ? null : c.next,
        masked,
        stagedByUserId: s.stagedBy[c.field] ?? null,
        stagedBy: s.stagedBy[c.field] != null ? (who.get(s.stagedBy[c.field]!) ?? null) : null,
      };
    }),
    updatedAt: s.updatedAt,
    version: s.version ?? s.updatedAt,
    updatedBy: s.updatedByUserId !== null ? (who.get(s.updatedByUserId) ?? null) : null,
  };
}

/**
 * Merge an edit into the tray. The body is validated as a PATCH body would
 * be; a field set back to its current value leaves the tray.
 */
export async function stageChanges(db: DB, svc: Service, body: unknown, userId: number, view: VisibleView): Promise<PendingChangesView> {
  const raw = (body ?? {}) as Record<string, unknown>;
  const tags = TAG_FIELDS.filter((k) => raw[k] !== undefined);
  if (tags.length > 0) throw badRequest(`${tags.join(', ')} cannot be staged — use PUT /v1/services/${svc.id}/tags`, 'tags_via_put');
  const parsed = updateService.parse(raw) as Record<string, unknown>;
  // Keep exactly what the caller sent (validated), not the schema's defaults.
  const edit = Object.fromEntries(Object.keys(raw).filter((k) => k in parsed).map((k) => [k, parsed[k]]));
  const s = await readPending(db, svc.id);
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
  const live = new Set((await rawChanges(db, svc, patch)).map((c) => c.field));
  for (const f of Object.keys(stagedBy)) if (!live.has(f)) delete stagedBy[f];
  await setSettingJson(db, key(svc.id), { ...s, patch, stagedBy, version: randomUUID(), updatedAt: new Date().toISOString(), updatedByUserId: userId } satisfies Stored);
  return pendingChanges(db, svc, view);
}

export async function setStaging(db: DB, svc: Service, staging: boolean, view: VisibleView): Promise<PendingChangesView> {
  const s = await readPending(db, svc.id);
  await setSettingJson(db, key(svc.id), { ...s, staging } satisfies Stored);
  return pendingChanges(db, svc, view);
}

/** Empty the tray (discard). Staging stays as it was. */
export async function clearPending(db: DB, serviceId: number): Promise<void> {
  const s = await readPending(db, serviceId);
  if (!s.staging) {
    await db.delete(settings).where(eq(settings.key, key(serviceId)));
    return;
  }
  await setSettingJson(db, key(serviceId), { ...s, patch: {}, stagedBy: {}, version: null, updatedAt: null, updatedByUserId: null } satisfies Stored);
}

/**
 * After an apply: remove from the tray exactly what was applied, field by
 * field, where the stored value is still the applied one. A change staged
 * in the meantime stays for the next review.
 */
export async function clearApplied(db: DB, serviceId: number, applied: Stored): Promise<void> {
  const s = await readPending(db, serviceId);
  const patch: Record<string, unknown> = { ...s.patch };
  const stagedBy = { ...s.stagedBy };
  for (const [field, value] of Object.entries(applied.patch)) {
    if (field === 'build' && value && typeof value === 'object' && patch['build'] && typeof patch['build'] === 'object') {
      const b = { ...(patch['build'] as Record<string, unknown>) };
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (same(b[k], v)) {
          delete b[k];
          delete stagedBy[`build.${k}`];
        }
      }
      if (Object.keys(b).length === 0) delete patch['build'];
      else patch['build'] = b;
    } else if (same(patch[field], value)) {
      delete patch[field];
      delete stagedBy[field];
    }
  }
  const empty = Object.keys(patch).length === 0;
  if (empty && !s.staging) {
    await db.delete(settings).where(eq(settings.key, key(serviceId)));
    return;
  }
  await setSettingJson(db, key(serviceId), {
    ...s,
    patch,
    stagedBy,
    version: empty ? null : randomUUID(),
    ...(empty ? { updatedAt: null, updatedByUserId: null } : {}),
  } satisfies Stored);
}
