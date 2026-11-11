import { z } from 'zod';
import {
  ciPipeline,
  composeRoute,
  errorPagesInput,
  forwardAuthConfig,
  maintenanceConfig,
  restartLimitConfig,
  type CiPipeline,
  type ComposeRoute,
  type ForwardAuthConfig,
  type MaintenanceConfig,
  type RestartLimitConfig,
} from '@ninedeploy/schemas';
import { eq } from 'drizzle-orm';
import { settings, type DB, type Service } from '@ninedeploy/db';
import { getPipeline, setPipeline } from './ci.js';
import { getComposeRoute, setComposeRoute } from './composeRoutes.js';
import { getForwardAuth, setForwardAuth } from './forwardAuth.js';
import { getCommitStatusSetting, setCommitStatusSetting } from './gitCommitStatus.js';
import { getInlineDockerfile, setInlineDockerfile } from './inlineDockerfile.js';
import { getErrorPages, getMaintenance, setErrorPages, setMaintenance } from './maintenance.js';
import { getRestartLimit, restartLimitSupported, setRestartLimit } from './restartLimit.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * S3 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): per-service and per-domain
 * configuration that lives in settings rows, so a service export, import or
 * clone carries it instead of silently dropping it.
 *
 * What travels is the `copy` portability in `lib/ownedSettings.ts`. A bundle
 * is foreign JSON, so every value is validated with the same schema its own
 * route uses, and anything the new service cannot use (a panel-host feature on
 * a service that is not on the panel host) is skipped with a reason. Secrets
 * (registry-hook token, error-ingest key) never travel; the report names them
 * so the operator can create fresh ones.
 */

export interface PortableServiceSettings {
  restartLimit?: RestartLimitConfig;
  maintenance?: MaintenanceConfig;
  errorPages?: Partial<Record<'502' | '503' | '504', string>>;
  inlineDockerfile?: string;
  commitStatus?: { enabled: boolean };
  ciPipeline?: CiPipeline;
  stickySession?: boolean;
}

export interface PortableDomainSettings {
  forwardAuth?: ForwardAuthConfig;
  composeRoute?: ComposeRoute;
}

export interface PortableReport {
  /** Settings written to the new service or its domains. */
  applied: string[];
  /** Settings in the source that were not written, each with why. */
  skipped: Array<{ setting: string; reason: string }>;
}

const stickyKey = (serviceId: number) => `sticky_session:${serviceId}:enabled`;

/** The service's portable settings, without per-instance state (when maintenance started, when a limit tripped). */
export async function readPortableServiceSettings(db: DB, serviceId: number): Promise<PortableServiceSettings> {
  const out: PortableServiceSettings = {};
  const limit = await getRestartLimit(db, serviceId);
  if (limit) out.restartLimit = { maxRestarts: limit.maxRestarts, windowMinutes: limit.windowMinutes };
  const maint = await getMaintenance(db, serviceId);
  if (maint) {
    const { since: _since, ...config } = maint;
    out.maintenance = config;
  }
  const pages = (await getErrorPages(db, serviceId)).pages;
  if (pages && Object.keys(pages).length > 0) out.errorPages = pages;
  const dockerfile = await getInlineDockerfile(db, serviceId);
  if (dockerfile) out.inlineDockerfile = dockerfile;
  const status = await getCommitStatusSetting(db, serviceId);
  if (status.enabled) out.commitStatus = { enabled: true };
  const pipeline = await getPipeline(db, serviceId);
  if (pipeline) out.ciPipeline = pipeline;
  const sticky = await getSettingString(db, stickyKey(serviceId), null);
  if (sticky === 'true' || sticky === '1') out.stickySession = true;
  return out;
}

export async function readPortableDomainSettings(db: DB, domainId: number): Promise<PortableDomainSettings> {
  const out: PortableDomainSettings = {};
  const fa = await getForwardAuth(db, domainId);
  if (fa) out.forwardAuth = fa;
  const route = await getComposeRoute(db, domainId);
  if (route) out.composeRoute = route;
  return out;
}

/** Secrets a source service has that never travel; the operator creates fresh ones. */
export async function notCarriedSecrets(db: DB, serviceId: number): Promise<string[]> {
  const has = async (key: string) => !!(await db.query.settings.findFirst({ where: eq(settings.key, key), columns: { key: true } }));
  const out: string[] = [];
  if (await has(`registry_hook:${serviceId}`)) out.push('registry push webhook (create a new one under Service → Settings)');
  if (await has(`error_ingest:${serviceId}`)) out.push('error ingest key (create a new DSN under Service → Errors)');
  return out;
}

const SERVICE_FIELDS = {
  restartLimit: restartLimitConfig,
  maintenance: maintenanceConfig,
  errorPages: errorPagesInput.shape.pages,
  inlineDockerfile: z.string(),
  commitStatus: z.object({ enabled: z.boolean() }).strict(),
  ciPipeline: ciPipeline,
  stickySession: z.boolean(),
} as const;
const FIELD_LABEL: Record<keyof typeof SERVICE_FIELDS, string> = {
  restartLimit: 'restart limit',
  maintenance: 'maintenance mode',
  errorPages: 'error pages',
  inlineDockerfile: 'inline Dockerfile',
  commitStatus: 'commit statuses',
  ciPipeline: 'CI pipeline',
  stickySession: 'sticky sessions',
};

/** Each field validated on its own, so one bad value does not discard the rest. */
function parseServiceSettings(raw: unknown, report: PortableReport): PortableServiceSettings {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    report.skipped.push({ setting: 'settings', reason: 'not an object' });
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in SERVICE_FIELDS)) {
      report.skipped.push({ setting: key.slice(0, 64), reason: 'not a setting this panel knows' });
      continue;
    }
    const field = key as keyof typeof SERVICE_FIELDS;
    const parsed = SERVICE_FIELDS[field].safeParse(value);
    if (parsed.success) out[field] = parsed.data;
    else report.skipped.push({ setting: FIELD_LABEL[field], reason: `not valid: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` });
  }
  return out as PortableServiceSettings;
}

const portableDomainShape = z.object({ forwardAuth: forwardAuthConfig.optional(), composeRoute: composeRoute.optional() }).strict();

type Target = Pick<Service, 'id' | 'type' | 'serverId' | 'orchestrator'>;

/**
 * Write `raw` (from a bundle or a source service) to `target`. `kind: 'clone'`
 * leaves maintenance mode off: a new copy should not start out "down for
 * maintenance". An import restores the same service, so it keeps it.
 */
export async function applyPortableServiceSettings(db: DB, target: Target, raw: unknown, opts: { kind: 'import' | 'clone' }): Promise<PortableReport> {
  const report: PortableReport = { applied: [], skipped: [] };
  const s = parseServiceSettings(raw, report);
  const panelHost = target.serverId == null && target.orchestrator !== 'swarm';
  // P2: a node serves these pages only once its agent is checked, which an import does not do.
  const pagesRefusal = panelHost ? null : target.orchestrator === 'swarm' ? 'not for Swarm services' : 'not carried to a node service by an import: turn it on under Service → Settings, which checks the node';
  const step = async (setting: string, present: boolean, fn: () => Promise<void>, refusal: string | null = null) => {
    if (!present) return;
    if (refusal) {
      report.skipped.push({ setting, reason: refusal });
      return;
    }
    try {
      await fn();
      report.applied.push(setting);
    } catch (err) {
      report.skipped.push({ setting, reason: err instanceof Error ? err.message : String(err) });
    }
  };
  await step('restart limit', !!s.restartLimit, () => setRestartLimit(db, target.id, s.restartLimit!), restartLimitSupported(target) ? null : 'only docker services, and PM2 services on the panel host, have one');
  await step(
    'maintenance mode',
    !!s.maintenance,
    () => setMaintenance(db, target.id, s.maintenance!),
    opts.kind === 'clone' ? 'a new copy starts outside maintenance mode' : pagesRefusal,
  );
  await step('error pages', !!s.errorPages && Object.keys(s.errorPages).length > 0, () => setErrorPages(db, target.id, s.errorPages!), pagesRefusal);
  await step('inline Dockerfile', !!s.inlineDockerfile, () => setInlineDockerfile(db, target.id, s.inlineDockerfile!));
  await step('commit statuses', s.commitStatus?.enabled === true, () => setCommitStatusSetting(db, target.id, { enabled: true }));
  await step('CI pipeline', !!s.ciPipeline, () => setPipeline(db, target.id, s.ciPipeline!));
  await step('sticky sessions', s.stickySession === true, () => setSettingString(db, stickyKey(target.id), 'true'));
  return report;
}

/** Write a domain's portable settings. Forward auth needs a panel-host service, as its route requires. */
export async function applyPortableDomainSettings(
  db: DB,
  domainId: number,
  hostname: string,
  service: Target,
  raw: unknown,
  report: PortableReport,
): Promise<void> {
  if (raw == null) return;
  const parsed = portableDomainShape.safeParse(raw);
  if (!parsed.success) {
    report.skipped.push({ setting: `${hostname} settings`, reason: `not valid: ${parsed.error.issues[0]?.message ?? 'unknown shape'}` });
    return;
  }
  const d = parsed.data;
  if (d.forwardAuth) {
    if (service.serverId != null) report.skipped.push({ setting: `${hostname} forward auth`, reason: 'only for services on the panel host' });
    else {
      await setForwardAuth(db, domainId, d.forwardAuth);
      report.applied.push(`${hostname} forward auth`);
    }
  }
  if (d.composeRoute) {
    if (service.type !== 'compose') report.skipped.push({ setting: `${hostname} compose route`, reason: 'the service is not a compose stack' });
    else {
      await setComposeRoute(db, domainId, d.composeRoute);
      report.applied.push(`${hostname} compose route`);
    }
  }
}
