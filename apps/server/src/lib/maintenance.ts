import { eq, like, or } from 'drizzle-orm';
import { settings, type DB } from '@ninedeploy/db';
import {
  ERROR_PAGE_STATUSES,
  errorPagesInput,
  maintenanceConfig,
  type ErrorPageStatus,
  type ErrorPagesView,
  type MaintenanceConfig,
  type MaintenanceView,
} from '@ninedeploy/schemas';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G2.2 maintenance mode and custom error pages, per service. No migration:
 * `maintenance:<serviceId>` holds the maintenance page and its bypass list,
 * `error_pages:<serviceId>` the 502/503/504 HTML. The proxy render reads both
 * (engine/proxy.ts); the panel serves the pages (modules/maintenance.ts).
 */

const MAINT = 'maintenance:';
const PAGES = 'error_pages:';

interface StoredMaintenance extends MaintenanceConfig {
  since: string;
}

function parseMaintenance(raw: unknown): StoredMaintenance | null {
  if (!raw || typeof raw !== 'object') return null;
  const { since, ...config } = raw as { since?: unknown };
  const parsed = maintenanceConfig.safeParse(config);
  return parsed.success ? { ...parsed.data, since: typeof since === 'string' ? since : new Date(0).toISOString() } : null;
}

export async function getMaintenance(db: DB, serviceId: number): Promise<StoredMaintenance | null> {
  return parseMaintenance(await getSettingJson<object>(db, `${MAINT}${serviceId}`, null));
}

export function maintenanceView(stored: StoredMaintenance | null): MaintenanceView {
  if (!stored) return { maintenance: null, since: null };
  const { since, ...maintenance } = stored;
  return { maintenance, since };
}

export async function setMaintenance(db: DB, serviceId: number, config: MaintenanceConfig | null): Promise<void> {
  if (!config) {
    await db.delete(settings).where(eq(settings.key, `${MAINT}${serviceId}`));
    return;
  }
  const prev = await getMaintenance(db, serviceId);
  await setSettingJson(db, `${MAINT}${serviceId}`, { ...maintenanceConfig.parse(config), since: prev?.since ?? new Date().toISOString() });
}

export async function getErrorPages(db: DB, serviceId: number): Promise<ErrorPagesView> {
  const raw = await getSettingJson<{ pages?: unknown }>(db, `${PAGES}${serviceId}`, null);
  const parsed = errorPagesInput.safeParse({ pages: raw?.pages ?? {} });
  if (!parsed.success) return { pages: {} };
  const pages: Partial<Record<ErrorPageStatus, string>> = {};
  for (const s of ERROR_PAGE_STATUSES) if (parsed.data.pages[s]) pages[s] = parsed.data.pages[s];
  return { pages };
}

export async function setErrorPages(db: DB, serviceId: number, pages: Partial<Record<ErrorPageStatus, string>>): Promise<void> {
  const kept = Object.fromEntries(Object.entries(pages).filter(([, html]) => typeof html === 'string' && html.trim() !== ''));
  if (Object.keys(kept).length === 0) await db.delete(settings).where(eq(settings.key, `${PAGES}${serviceId}`));
  else await setSettingJson(db, `${PAGES}${serviceId}`, { pages: kept });
}

/** For the proxy render: services in maintenance, and services with custom error pages (one read each). */
export async function routingOverrides(db: DB): Promise<{ maintenance: Map<number, StoredMaintenance>; errorPages: Map<number, ErrorPageStatus[]> }> {
  const maintenance = new Map<number, StoredMaintenance>();
  const errorPages = new Map<number, ErrorPageStatus[]>();
  let rows: Array<{ key: string; value: unknown }> = [];
  try {
    rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(or(like(settings.key, `${MAINT}%`), like(settings.key, `${PAGES}%`)));
  } catch {
    // A fake or partial db in a test: no overrides, the render is unchanged.
    return { maintenance, errorPages };
  }
  for (const row of rows) {
    const value = typeof row.value === 'string' ? safeJson(row.value) : row.value;
    if (row.key.startsWith(MAINT)) {
      const id = Number(row.key.slice(MAINT.length));
      const m = value && typeof value === 'object' ? parseMaintenance(value) : null;
      if (Number.isInteger(id) && m) maintenance.set(id, m);
    } else {
      const id = Number(row.key.slice(PAGES.length));
      const pages = (value as { pages?: Record<string, unknown> } | null)?.pages ?? {};
      const statuses = ERROR_PAGE_STATUSES.filter((s) => typeof pages[s] === 'string' && (pages[s] as string).trim() !== '');
      if (Number.isInteger(id) && statuses.length) errorPages.set(id, statuses);
    }
  }
  return { maintenance, errorPages };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
