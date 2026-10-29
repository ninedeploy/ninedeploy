import { eq, like } from 'drizzle-orm';
import { alertRules, services, settings, type DB } from '@ninedeploy/db';
import type { AlertInvestigation } from '@ninedeploy/schemas';
import { aiComplete, loadAiConfig, loadStoredAiConfig } from './aiProvider.js';
import { buildRuntimeLogMessages, logTailForAi } from './aiDiagnosis.js';
import { audit } from './audit.js';
import { laneRules } from './protectedLanes.js';
import { readRuntimeLogs } from './runtimeLogs.js';
import { setSettingJson } from './settings.js';

/**
 * ROADMAP 0.16.8 item 6: when a service's alert rule fires, ask the
 * configured AI provider what the service's newest runtime logs say, and keep
 * the answer next to the rule (Monitoring shows it).
 *
 * Opt-in: the operator turns it on with the AI configuration
 * (`alertInvestigation`), because every investigation spends the operator's
 * key. The answer stays in the panel, readable by whoever may read the rule:
 * it is never put into a notification, so log lines do not reach external
 * channels. A protected lane's logs are for its admins only, and alert rules
 * are readable by every member of the service, so its alerts are not
 * investigated.
 */
export const ALERT_INVESTIGATION_PREFIX = 'alert_investigation:';
/** Instance-wide cap: a flapping fleet must not turn into a provider bill. */
export const ALERT_INVESTIGATIONS_PER_HOUR = 12;
/** Newest runtime log lines read (the sanitized tail sent is capped at 16 KB). */
export const ALERT_INVESTIGATION_TAIL = 300;
const MAX_TOKENS = 800;

const recent: number[] = [];

/** Test hook: forget the hourly cap. */
export function resetAlertInvestigationCap(): void {
  recent.length = 0;
}

export type AlertInvestigationOutcome = 'off' | 'unconfigured' | 'gone' | 'protected' | 'not_running' | 'capped' | 'no_logs' | 'done';

export async function investigateFiredAlert(
  db: DB,
  rule: { id: number; name: string; serviceId: number | null; metric: string; operator: string; threshold: number },
  value: number,
  detail?: string,
  nowMs: number = Date.now(),
): Promise<AlertInvestigationOutcome> {
  if (rule.serviceId == null) return 'gone';
  if ((await loadStoredAiConfig(db))?.alertInvestigation !== true) return 'off';
  const cfg = await loadAiConfig(db);
  if (!cfg) return 'unconfigured';
  const svc = await db.query.services.findFirst({ where: eq(services.id, rule.serviceId) });
  if (!svc) return 'gone';
  if ((await laneRules(db, svc))?.protected) return 'protected';
  if (!svc.runtimeId) return 'not_running';
  while (recent.length > 0 && recent[0]! <= nowMs - 60 * 60 * 1000) recent.shift();
  if (recent.length >= ALERT_INVESTIGATIONS_PER_HOUR) return 'capped';
  recent.push(nowMs);

  const raw = await readRuntimeLogs(db, svc, ALERT_INVESTIGATION_TAIL).catch(() => '');
  if (!raw.trim()) return 'no_logs';
  const [system, user] = buildRuntimeLogMessages(svc.name, logTailForAi(raw));
  const context = `The alert "${rule.name}" just fired: ${rule.metric} = ${value} (threshold ${rule.operator} ${rule.threshold})${detail ? `, ${detail}` : ''}. Say what in the logs explains it, if anything does.`;
  const analysis = await aiComplete(cfg, { system: system!.content, user: `${context}\n\n${user!.content}` }, MAX_TOKENS);
  const record: AlertInvestigation = { at: new Date(nowMs).toISOString(), model: cfg.model, value, analysis };
  await setSettingJson(db, `${ALERT_INVESTIGATION_PREFIX}${rule.id}`, record);
  void audit(db, null, 'ai.alert_investigation', `${rule.name} (service=${svc.name})`, { ruleId: rule.id, serviceId: svc.id });
  await pruneAlertInvestigations(db);
  return 'done';
}

/** The stored investigation per rule id. */
export async function loadAlertInvestigations(db: DB): Promise<Map<number, AlertInvestigation>> {
  const rows = await db.select().from(settings).where(like(settings.key, `${ALERT_INVESTIGATION_PREFIX}%`));
  const out = new Map<number, AlertInvestigation>();
  for (const row of rows) {
    const id = Number(row.key.slice(ALERT_INVESTIGATION_PREFIX.length));
    const value = typeof row.value === 'string' ? safeParse(row.value) : row.value;
    if (Number.isInteger(id) && value && typeof value === 'object') out.set(id, value as AlertInvestigation);
  }
  return out;
}

/** Drop investigations whose rule is gone (deleted, or removed with its service). */
export async function pruneAlertInvestigations(db: DB): Promise<void> {
  const ids = new Set((await db.select({ id: alertRules.id }).from(alertRules)).map((r) => r.id));
  for (const id of (await loadAlertInvestigations(db)).keys()) {
    if (!ids.has(id)) await db.delete(settings).where(eq(settings.key, `${ALERT_INVESTIGATION_PREFIX}${id}`));
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
