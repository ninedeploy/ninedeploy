import { and, eq } from 'drizzle-orm';
import { alertRules, alertState, type DB } from '@ninedeploy/db';
import { audit } from './audit.js';

/** The collector samples every 30s — duration windows are counted in samples. */
export const SAMPLE_INTERVAL_MS = 30_000;

/** Minimum time between repeated notifications for the same rule. */
export const NOTIFY_COOLDOWN_MS = 30 * 60_000;

/**
 * Metric snapshot in rule units: cpu %, memory MiB, cert-expiry days, disk %
 * used, server_offline minutes unseen. Null serviceId = host-wide.
 *
 * A rule whose metric no snapshot carries is skipped and its state left
 * untouched — which is also what keeps a rule written by a NEWER panel (a
 * metric this build does not know, after a rollback) inert instead of fatal.
 */
export interface MetricSnapshot {
  serviceId: number | null;
  kind: string;
  value: number;
  /** Fleet-wide metrics (disk, server_offline): which hosts the value came from, named in the fired notification. */
  detail?: string;
}

interface RuleRow {
  id: number;
  serviceId: number | null;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  durationWindows: number;
  enabled: number | boolean;
}

interface StateRow {
  ruleId: number;
  status: string;
  breachSince: Date | null;
  firedAt: Date | null;
  lastNotifiedAt: Date | null;
  lastValue: number | null;
}

function breaches(value: number, operator: string, threshold: number): boolean {
  return operator === '<' ? value < threshold : value > threshold;
}

function asDate(v: Date | number | null | undefined): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v);
}

/**
 * Evaluate all enabled alert rules against the latest metric snapshots.
 *
 * Lifecycle per rule: ok → breaching (first breach, timestamped) → firing
 * (breach sustained for durationWindows samples, one notification, cooldown
 * before re-notify) → ok (recovery notification when it clears).
 */
export async function evaluateAlerts(db: DB, snapshots: MetricSnapshot[], now = new Date()): Promise<void> {
  let rules: RuleRow[];
  try {
    rules = (await db.select().from(alertRules)) as unknown as RuleRow[];
  } catch {
    return; // table might not exist yet
  }

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const snap = snapshots.find((s) => s.serviceId === rule.serviceId && s.kind === rule.metric);
    // No sample for this rule's target this tick — leave state untouched.
    if (!snap) continue;

    const [existing] = (await db.select().from(alertState).where(eq(alertState.ruleId, rule.id))) as unknown as StateRow[];
    const state: StateRow = existing ?? {
      ruleId: rule.id,
      status: 'ok',
      breachSince: null,
      firedAt: null,
      lastNotifiedAt: null,
      lastValue: null,
    };
    const isBreaching = breaches(snap.value, rule.operator, rule.threshold);
    const prevStatus = state.status;

    if (!isBreaching) {
      if (prevStatus !== 'ok') {
        await db.update(alertState).set({ status: 'ok', breachSince: null, lastValue: snap.value }).where(eq(alertState.ruleId, rule.id));
        // Only notify recovery if the alert had actually fired.
        if (prevStatus === 'firing') {
          void audit(
            db,
            null,
            'alert.recovered',
            `${rule.name} (${rule.metric}=${snap.value}) back within threshold`,
            rule.serviceId != null ? { serviceId: rule.serviceId } : undefined,
          );
        }
      } else {
        await db.update(alertState).set({ lastValue: snap.value }).where(eq(alertState.ruleId, rule.id));
      }
      continue;
    }

    // r405: `durationWindows` counts the CONSECUTIVE BREACHING SAMPLES the
    // condition must hold for, per its schema comment. The first breaching
    // sample IS sample #1 (breachSince), so the Nth arrives (N-1) intervals
    // later — the old `N × interval` elapsed bound fired one sample late
    // (durationWindows: 1 fired on the second sample, 60 s in).
    const breachSince = asDate(state.breachSince) ?? now;
    const requiredMs = (Math.max(1, rule.durationWindows) - 1) * SAMPLE_INTERVAL_MS;
    const elapsed = now.getTime() - breachSince.getTime();

    if (elapsed >= requiredMs) {
      const lastNotified = asDate(state.lastNotifiedAt);
      const cooldownPassed = !lastNotified || now.getTime() - lastNotified.getTime() >= NOTIFY_COOLDOWN_MS;
      if (prevStatus !== 'firing' || cooldownPassed) {
        await db
          .update(alertState)
          .set({ status: 'firing', firedAt: now, lastNotifiedAt: now, lastValue: snap.value })
          .where(eq(alertState.ruleId, rule.id));
        void audit(
          db,
          null,
          'alert.fired',
          `${rule.name} (${rule.metric}=${snap.value}, threshold ${rule.operator} ${rule.threshold})${snap.detail ? ` — ${snap.detail}` : ''}`,
          rule.serviceId != null ? { serviceId: rule.serviceId } : undefined,
        );
      } else {
        await db.update(alertState).set({ lastValue: snap.value }).where(eq(alertState.ruleId, rule.id));
      }
    } else {
      // Stamp/hold the breach window: the first breaching sample sets
      // `breaching` + breachSince; later pre-window samples only refresh the
      // value.
      const held: 'breaching' | 'firing' = prevStatus === 'firing' ? 'firing' : 'breaching';
      await db
        .update(alertState)
        .set({ status: held, breachSince, lastValue: snap.value })
        .where(eq(alertState.ruleId, rule.id));
    }
  }
}

/** Persist a fresh state row for a newly created rule (idempotent). */
export async function ensureAlertState(db: DB, ruleId: number): Promise<void> {
  const [existing] = await db.select().from(alertState).where(eq(alertState.ruleId, ruleId));
  if (!existing) await db.insert(alertState).values({ ruleId });
}

/** Reset a rule's state (used after edits so stale breach data can't misfire). */
export async function resetAlertState(db: DB, ruleId: number): Promise<void> {
  await db.delete(alertState).where(and(eq(alertState.ruleId, ruleId)));
}
