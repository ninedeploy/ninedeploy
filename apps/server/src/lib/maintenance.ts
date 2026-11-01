import { eq, like, or } from 'drizzle-orm';
import { domains, settings, type DB } from '@ninedeploy/db';
import {
  ERROR_PAGE_STATUSES,
  errorPagesInput,
  maintenanceConfig,
  type ErrorPageStatus,
  type ErrorPagesView,
  type MaintenanceConfig,
  type MaintenanceView,
  type ComposeRoute,
} from '@ninedeploy/schemas';
import { COMPOSE_ROUTE_PREFIX, parseComposeRoute } from './composeRoutes.js';
import { forwardAuthDomains } from './forwardAuth.js';
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

/**
 * Why a service may not run on a node yet (a move or a fan-out target), or
 * null. Node proxies do not route what the panel serves: a node would keep
 * serving the app through maintenance, the setting would sit unseen after a
 * move (its card is hidden for node services) and come back on a move back,
 * and a domain behind panel sign-in (G2.3) would not be routed there.
 */
export async function panelHostOnlyRefusal(db: DB, serviceId: number): Promise<string | null> {
  if (await getMaintenance(db, serviceId)) return 'Turn maintenance mode off before the service runs on a node';
  if (Object.keys((await getErrorPages(db, serviceId)).pages).length) return 'Remove the custom error pages before the service runs on a node';
  const signIn = await forwardAuthDomains(db);
  if (signIn.size) {
    const own = await db.select({ id: domains.id }).from(domains).where(eq(domains.serviceId, serviceId));
    if (own.some((d) => signIn.has(d.id))) return 'Turn panel sign-in off on its domains before the service runs on a node';
  }
  return null;
}

/**
 * For the proxy render, in one read: services in maintenance, services with
 * custom error pages, and (G2.1) compose domains routed to another service.
 */
export async function routingOverrides(db: DB): Promise<{
  maintenance: Map<number, StoredMaintenance>;
  errorPages: Map<number, ErrorPageStatus[]>;
  composeRoutes: Map<number, ComposeRoute>;
}> {
  const maintenance = new Map<number, StoredMaintenance>();
  const errorPages = new Map<number, ErrorPageStatus[]>();
  const composeRoutes = new Map<number, ComposeRoute>();
  let rows: Array<{ key: string; value: unknown }> = [];
  try {
    rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(or(like(settings.key, `${MAINT}%`), like(settings.key, `${PAGES}%`), like(settings.key, `${COMPOSE_ROUTE_PREFIX}%`)));
  } catch {
    // A fake or partial db in a test: no overrides, the render is unchanged.
    return { maintenance, errorPages, composeRoutes };
  }
  for (const row of rows) {
    const value = typeof row.value === 'string' ? safeJson(row.value) : row.value;
    if (row.key.startsWith(MAINT)) {
      const id = Number(row.key.slice(MAINT.length));
      const m = value && typeof value === 'object' ? parseMaintenance(value) : null;
      if (Number.isInteger(id) && m) maintenance.set(id, m);
    } else if (row.key.startsWith(PAGES)) {
      const id = Number(row.key.slice(PAGES.length));
      const pages = (value as { pages?: Record<string, unknown> } | null)?.pages ?? {};
      const statuses = ERROR_PAGE_STATUSES.filter((s) => typeof pages[s] === 'string' && (pages[s] as string).trim() !== '');
      if (Number.isInteger(id) && statuses.length) errorPages.set(id, statuses);
    } else if (row.key.startsWith(COMPOSE_ROUTE_PREFIX)) {
      const id = Number(row.key.slice(COMPOSE_ROUTE_PREFIX.length));
      const route = parseComposeRoute(value);
      if (Number.isInteger(id) && route) composeRoutes.set(id, route);
    }
  }
  return { maintenance, errorPages, composeRoutes };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
