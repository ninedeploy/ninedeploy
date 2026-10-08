import type { FastifyPluginAsync } from 'fastify';
import {
  trafficSettingsUpdate,
  trafficSummaryQuery,
  type ServiceTrafficSummary,
  type TrafficSettingsView,
  type TrafficSummary,
} from '@ninedeploy/schemas';
import type { DB } from '@ninedeploy/db';
import { dockerLoggingDriver, ensureNetwork, ensureTraefik, traefikInputs } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { HttpError, parseId } from '../lib/errors.js';
import { loadServiceForUser } from '../lib/resourceAccess.js';
import {
  getTrafficRetentionDays,
  setTrafficAnalyticsEnabled,
  setTrafficRetentionDays,
  startTrafficTailer,
  stopTrafficTailer,
  trafficAnalyticsEnabled,
  trafficReport,
  trafficTailerState,
} from '../lib/trafficAnalytics.js';

/**
 * Traffic analytics (0.15, opt-in everywhere — owner decision O3).
 *
 * Design: .temp_files/run_0.15/DESIGN.md §2.4. Owner: task T3. Contract:
 * `@ninedeploy/schemas` traffic.ts. Each route has its authzMatrix entry
 * (block `0.15 T3 traffic`) and its ROUTE_SPECS entry
 * (`src/openapi/specs/traffic.ts`).
 */

/** `GET /v1/traffic/settings`: the switch, the retention and the tailer's state. */
export async function trafficSettingsView(db: DB): Promise<TrafficSettingsView> {
  const state = trafficTailerState();
  return {
    enabled: await trafficAnalyticsEnabled(db),
    retentionDays: await getTrafficRetentionDays(db),
    status: state.status,
    lastError: state.lastError,
    lastIngestAt: state.lastIngestAt,
    logBytes: state.logBytes,
    malformedLines: state.malformedLines,
    dockerLogDriver: await dockerLoggingDriver(),
  };
}

/** Settings writes are serialized: two toggles must never recreate Traefik concurrently. */
let settingsTail: Promise<unknown> = Promise.resolve();

/**
 * Instance-wide routes under `/v1/traffic` (operator only, no PREFIX_SCOPES
 * entry, so fine-grained API tokens are refused): `GET/PUT /settings` and
 * `GET /summary`.
 */
export const trafficRoutes: FastifyPluginAsync = async (app) => {
  const guard = { onRequest: [app.authenticate], preHandler: [app.requireOperator] };

  app.get('/settings', guard, async () => trafficSettingsView(app.db));

  /**
   * Enabling or disabling re-renders Traefik's static config and recreates
   * the proxy synchronously (about 1–2s of refused connections), then starts
   * or stops the tailer. A failed recreate puts the switch back, re-applies
   * the previous config and answers 502: the setting never claims a state
   * the proxy is not in. A browser reaching the panel THROUGH Traefik may
   * lose this response to the recreate itself; it re-reads GET /settings.
   */
  app.put('/settings', guard, async (req) => {
    const body = trafficSettingsUpdate.parse(req.body ?? {});
    const userId = req.user!.id;
    const db = app.db;
    const runUpdate = async (): Promise<TrafficSettingsView> => {
      const previous = { enabled: await trafficAnalyticsEnabled(db), retentionDays: await getTrafficRetentionDays(db) };
      if (body.retentionDays !== undefined && body.retentionDays !== previous.retentionDays) {
        await setTrafficRetentionDays(db, body.retentionDays);
      }
      const log = (line: string) => app.log.info({ component: 'traffic-analytics' }, line);
      const tailerLog = (msg: string, err?: unknown) => app.log.warn({ err, component: 'traffic-analytics' }, msg);
      if (body.enabled !== undefined && body.enabled !== previous.enabled) {
        await setTrafficAnalyticsEnabled(db, body.enabled);
        try {
          await ensureNetwork(log);
          const t = await traefikInputs(db);
          await ensureTraefik(log, t.acmeEmail, t.dns, t);
        } catch (err) {
          await setTrafficAnalyticsEnabled(db, previous.enabled);
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
          // Put the proxy back on the previous static config; the watchdog
          // retries if this fails too.
          try {
            const t = await traefikInputs(db);
            await ensureTraefik(log, t.acmeEmail, t.dns, t);
          } catch (restoreErr) {
            app.log.error({ err: restoreErr, component: 'traffic-analytics' }, 'restoring the previous Traefik config failed');
          }
          void audit(db, userId, 'traffic.settings.update', 'traffic', {
            previous,
            requested: body,
            outcome: 'recreate_failed',
            error: message,
          });
          throw new HttpError(502, 'traefik_recreate_failed', `Traefik could not be recreated; analytics stays ${previous.enabled ? 'on' : 'off'}: ${message}`);
        }
        if (body.enabled) {
          startTrafficTailer({ db, log: tailerLog });
        } else {
          await stopTrafficTailer({ purge: { db, log: tailerLog } }).catch((err) =>
            app.log.warn({ err, component: 'traffic-analytics' }, 'draining the traffic log after disable failed'),
          );
        }
        void audit(db, userId, body.enabled ? 'traffic.enable' : 'traffic.disable', 'traffic', { previous });
      } else if (body.enabled === true) {
        // Already on: make sure the tailer runs (idempotent).
        startTrafficTailer({ db, log: tailerLog });
      }
      void audit(db, userId, 'traffic.settings.update', 'traffic', {
        previous,
        next: {
          enabled: body.enabled ?? previous.enabled,
          retentionDays: body.retentionDays ?? previous.retentionDays,
        },
      });
      return trafficSettingsView(db);
    };
    const pending = settingsTail.then(runUpdate, runUpdate);
    settingsTail = pending.catch(() => undefined);
    return pending;
  });

  app.get('/summary', guard, async (req): Promise<TrafficSummary> => {
    const q = trafficSummaryQuery.parse(req.query ?? {});
    const report = await trafficReport(app.db, { range: q.range });
    return {
      enabled: await trafficAnalyticsEnabled(app.db),
      range: q.range,
      granularity: report.granularity,
      totals: report.totals,
      series: report.series,
      topDomains: report.scopes.filter((s) => s.scopeKey.startsWith('d:')).slice(0, q.top),
      panel: report.scopes.find((s) => s.scopeKey === 'panel') ?? null,
      custom: report.scopes.find((s) => s.scopeKey === 'custom') ?? null,
    };
  });
};

/**
 * Per-service route `GET /v1/services/:id/traffic` (any seat on the service),
 * registered under `/services` so it inherits the `services` read scope.
 * A service without data gets empty series, never a 404.
 */
export const serviceTrafficRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/traffic', { onRequest: [app.authenticate] }, async (req): Promise<ServiceTrafficSummary> => {
    const id = parseId((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const q = trafficSummaryQuery.parse(req.query ?? {});
    const report = await trafficReport(app.db, { range: q.range, serviceId: id });
    return {
      enabled: await trafficAnalyticsEnabled(app.db),
      range: q.range,
      granularity: report.granularity,
      totals: report.totals,
      series: report.series,
      domains: report.scopes.slice(0, q.top),
    };
  });
};
