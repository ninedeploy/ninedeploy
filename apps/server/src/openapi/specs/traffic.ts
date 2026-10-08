import {
  serviceTrafficSummary,
  trafficSettingsUpdate,
  trafficSettingsView,
  trafficSummary,
  trafficSummaryQuery,
} from '@ninedeploy/schemas';
import type { RouteSpecMap } from '../types.js';

/**
 * ROUTE_SPECS fragment for `/v1/traffic` and `GET /v1/services/:id/traffic`
 * (0.15). Owner: task T3. Every key here must name a live route (authzMatrix
 * `ROUTE_SPECS` coverage case) and its floor must equal the route's MATRIX
 * floor.
 */
export const trafficSpecs: RouteSpecMap = {
  'GET /v1/traffic/settings': {
    summary: 'Traffic analytics settings and tailer status',
    tag: 'traffic',
    description:
      'Whether analytics is on (opt-in), the hour-row retention, the access-log tailer status and the Docker log driver.',
    floor: 'operator',
    response: trafficSettingsView,
  },
  'PUT /v1/traffic/settings': {
    summary: 'Enable or disable traffic analytics, or change its retention',
    tag: 'traffic',
    description:
      'Enabling or disabling recreates the Traefik proxy once (about 1–2s of refused connections). A failed recreate keeps the previous value and answers 502.',
    floor: 'operator',
    body: trafficSettingsUpdate,
    response: trafficSettingsView,
    validation: 'zod',
  },
  'GET /v1/traffic/summary': {
    summary: 'Instance-wide request analytics',
    tag: 'traffic',
    description:
      'Totals, a per-bucket series (minute buckets for 1h/24h, hour buckets for 7d/30d), the top domains and the panel and custom buckets, with p50/p95/p99 estimated from the latency histogram.',
    floor: 'operator',
    query: trafficSummaryQuery,
    response: trafficSummary,
    validation: 'zod',
    mcp: {
      name: 'instance_traffic_summary',
      description: 'Instance-wide request counts, status classes, bytes and latency percentiles over a range (operator).',
      readOnly: true,
    },
  },
  'GET /v1/services/:id/traffic': {
    summary: "A service's request analytics",
    tag: 'traffic',
    description:
      "The summary series filtered to the service's domains, plus per-domain totals. Empty series (not 404) when there is no data or analytics is off.",
    floor: 'viewer',
    query: trafficSummaryQuery,
    response: serviceTrafficSummary,
    validation: 'zod',
    mcp: {
      name: 'traffic_summary',
      description: "A service's request counts, status classes, bytes and latency percentiles over a range.",
      readOnly: true,
    },
  },
};
