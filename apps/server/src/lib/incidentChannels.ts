import { createHash } from 'node:crypto';
import { guardedFetch } from './egressGuard.js';
import type { AppEvent } from './events.js';

/**
 * G3.7: incident channels. PagerDuty and Opsgenie open an incident for every
 * message they receive, so they get only the events that mean "something is
 * wrong" and the ones that say it is fixed, keyed so the fix closes the
 * incident the problem opened. A deploy success, a login or a backup that
 * worked never pages anyone.
 */

const FETCH_TIMEOUT_MS = 10_000;

export type IncidentSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface IncidentAction {
  kind: 'trigger' | 'resolve';
  /** Stable per problem: the resolve of a problem carries its trigger's key. */
  key: string;
  severity: IncidentSeverity;
}

export const INCIDENT_CHANNEL_TYPES: ReadonlySet<string> = new Set(['pagerduty', 'opsgenie']);

const metaNumber = (event: AppEvent, key: string): number | null =>
  typeof event.meta?.[key] === 'number' ? (event.meta[key] as number) : null;

/** A key for events with no id to correlate on: the action and entity, hashed. */
const fallbackKey = (event: AppEvent): string =>
  `${event.action}-${createHash('sha256').update(event.entity ?? '').digest('hex').slice(0, 16)}`;

/**
 * What an incident channel does with an event: open, close, or nothing (null).
 * `notification.test` opens and closes a test incident (see
 * {@link dispatchIncident}).
 */
export function incidentActionFor(event: AppEvent): IncidentAction | null {
  const ruleId = metaNumber(event, 'ruleId');
  const monitorId = metaNumber(event, 'monitorId');
  const serviceId = metaNumber(event, 'serviceId');
  switch (event.action) {
    case 'alert.fired':
      return { kind: 'trigger', key: ruleId != null ? `alert-rule-${ruleId}` : fallbackKey(event), severity: 'error' };
    case 'alert.recovered':
      return ruleId != null ? { kind: 'resolve', key: `alert-rule-${ruleId}`, severity: 'info' } : null;
    case 'alert.monitor_down':
      return { kind: 'trigger', key: monitorId != null ? `monitor-${monitorId}` : fallbackKey(event), severity: 'critical' };
    case 'alert.monitor_up':
      return monitorId != null ? { kind: 'resolve', key: `monitor-${monitorId}`, severity: 'info' } : null;
    case 'alert.service_down':
      return { kind: 'trigger', key: serviceId != null ? `service-down-${serviceId}` : fallbackKey(event), severity: 'critical' };
    case 'deploy.failed':
      return { kind: 'trigger', key: serviceId != null ? `deploy-${serviceId}` : fallbackKey(event), severity: 'error' };
    case 'deploy.success':
      // Closes the failed deploy of the same service, when there is one open.
      return serviceId != null ? { kind: 'resolve', key: `deploy-${serviceId}`, severity: 'info' } : null;
    case 'backup.missed':
      return { kind: 'trigger', key: fallbackKey(event), severity: 'warning' };
    case 'notification.test':
      return { kind: 'trigger', key: `test-${event.ts}`, severity: 'info' };
    default:
      return event.action.startsWith('alert.') ? { kind: 'trigger', key: fallbackKey(event), severity: 'warning' } : null;
  }
}

// ── target parsing ─────────────────────────────────────────────────────────

export interface PagerDutyTarget {
  routingKey: string;
  region: 'us' | 'eu';
}

export interface OpsgenieTarget {
  apiKey: string;
  region: 'us' | 'eu';
}

/** A bare key, or JSON `{ <keyField>, region? }` with region `us` (default) or `eu`. */
function parseKeyTarget(target: string, keyField: string, label: string): { key: string; region: 'us' | 'eu' } {
  const trimmed = target.trim();
  if (!trimmed.startsWith('{')) {
    if (!trimmed) throw new Error(`Invalid ${label} target (expected a key)`);
    return { key: trimmed, region: 'us' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Invalid ${label} target (expected a key, or JSON with ${keyField} and region)`);
  }
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const key = typeof o[keyField] === 'string' ? (o[keyField] as string).trim() : '';
  const region = o['region'] === undefined || o['region'] === 'us' ? 'us' : o['region'] === 'eu' ? 'eu' : null;
  if (!key || !region) throw new Error(`Invalid ${label} target (expected ${keyField} and a region of us or eu)`);
  return { key, region };
}

export function parsePagerDutyTarget(target: string): PagerDutyTarget {
  const { key, region } = parseKeyTarget(target, 'routingKey', 'PagerDuty');
  return { routingKey: key, region };
}

export function parseOpsgenieTarget(target: string): OpsgenieTarget {
  const { key, region } = parseKeyTarget(target, 'apiKey', 'Opsgenie');
  return { apiKey: key, region };
}

// ── senders ────────────────────────────────────────────────────────────────

const DEDUP_PREFIX = 'ninedeploy-';

/** PagerDuty Events API v2 (`trigger` / `resolve`, deduplicated by key). */
export async function sendPagerDuty(target: PagerDutyTarget, action: IncidentAction, summary: string, event: AppEvent): Promise<void> {
  const host = target.region === 'eu' ? 'https://events.eu.pagerduty.com' : 'https://events.pagerduty.com';
  const body: Record<string, unknown> = {
    routing_key: target.routingKey,
    event_action: action.kind,
    dedup_key: `${DEDUP_PREFIX}${action.key}`,
  };
  if (action.kind === 'trigger') {
    body['payload'] = {
      summary: summary.slice(0, 1024),
      source: 'NineDeploy',
      severity: action.severity,
      component: event.entity?.slice(0, 200) ?? undefined,
      group: event.action.split('.')[0],
      class: event.action,
      timestamp: event.ts,
    };
  }
  const res = await guardedFetch(`${host}/v2/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`PagerDuty ${res.status}${await errorDetail(res)}`);
}

const OPSGENIE_PRIORITY: Record<IncidentSeverity, string> = { critical: 'P1', error: 'P2', warning: 'P3', info: 'P5' };

/** Opsgenie Alert API v2: create with an alias, close by that alias. */
export async function sendOpsgenie(target: OpsgenieTarget, action: IncidentAction, summary: string, event: AppEvent): Promise<void> {
  const host = target.region === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com';
  const alias = `${DEDUP_PREFIX}${action.key}`;
  const url =
    action.kind === 'trigger' ? `${host}/v2/alerts` : `${host}/v2/alerts/${encodeURIComponent(alias)}/close?identifierType=alias`;
  const body =
    action.kind === 'trigger'
      ? {
          message: summary.slice(0, 130),
          alias,
          description: summary.slice(0, 15000),
          source: 'NineDeploy',
          priority: OPSGENIE_PRIORITY[action.severity],
          tags: ['ninedeploy', event.action],
          ...(event.entity ? { entity: event.entity.slice(0, 512) } : {}),
        }
      : { source: 'NineDeploy', note: summary.slice(0, 25000) };
  const res = await guardedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `GenieKey ${target.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Opsgenie ${res.status}${await errorDetail(res)}`);
}

/** The provider's explanation of a refusal (its body never holds the key). */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim().slice(0, 200);
    return text ? `: ${text}` : '';
  } catch {
    return '';
  }
}

/**
 * Deliver one event to an incident channel. A test opens a test incident and
 * closes it right away, so a test never leaves anyone paged.
 */
export async function dispatchIncident(type: 'pagerduty' | 'opsgenie', target: string, event: AppEvent, summary: string): Promise<void> {
  const action = incidentActionFor(event);
  if (!action) return;
  const send =
    type === 'pagerduty'
      ? (a: IncidentAction) => sendPagerDuty(parsePagerDutyTarget(target), a, summary, event)
      : (a: IncidentAction) => sendOpsgenie(parseOpsgenieTarget(target), a, summary, event);
  await send(action);
  if (event.action === 'notification.test') await send({ ...action, kind: 'resolve' });
}
