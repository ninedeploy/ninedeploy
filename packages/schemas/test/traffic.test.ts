import { describe, expect, it } from 'vitest';
import {
  serviceTrafficSummary,
  TRAFFIC_GRANULARITIES,
  TRAFFIC_LATENCY_BUCKETS,
  TRAFFIC_LATENCY_EDGES_MS,
  TRAFFIC_RETENTION_DAYS_DEFAULT,
  TRAFFIC_RETENTION_DAYS_MAX,
  TRAFFIC_RETENTION_DAYS_MIN,
  trafficGranularity,
  trafficRange,
  trafficRangeGranularity,
  trafficSettingsUpdate,
  trafficSettingsView,
  trafficStatus,
  trafficSummary,
  trafficSummaryQuery,
} from '../src/traffic.js';

const counters = {
  requests: 20,
  status1xx: 0,
  status2xx: 18,
  status3xx: 1,
  status4xx: 1,
  status5xx: 0,
  statusOther: 0,
  bytesOut: 4096,
  durationSumMs: 200,
  durationMaxMs: 40,
};
const pct = { p50Ms: 10, p95Ms: 25, p99Ms: null };
const domain = { ...counters, ...pct, scopeKey: 'd:3', domainId: 3, serviceId: 1, host: 'app.example.com' };

describe('traffic settings (0.15)', () => {
  it('accepts a partial, strict update and bounds the retention', () => {
    expect(trafficSettingsUpdate.parse({})).toEqual({});
    expect(trafficSettingsUpdate.parse({ enabled: true })).toEqual({ enabled: true });
    expect(trafficSettingsUpdate.parse({ retentionDays: TRAFFIC_RETENTION_DAYS_MIN })).toEqual({ retentionDays: 1 });
    expect(trafficSettingsUpdate.parse({ retentionDays: TRAFFIC_RETENTION_DAYS_MAX })).toEqual({ retentionDays: 400 });
    expect(trafficSettingsUpdate.safeParse({ retentionDays: 0 }).success).toBe(false);
    expect(trafficSettingsUpdate.safeParse({ retentionDays: 401 }).success).toBe(false);
    expect(trafficSettingsUpdate.safeParse({ captureIps: true }).success).toBe(false);
    expect(TRAFFIC_RETENTION_DAYS_DEFAULT).toBe(30);
  });

  it('describes the settings view and its status values', () => {
    const view = {
      enabled: false,
      retentionDays: 30,
      status: 'off',
      lastError: null,
      lastIngestAt: null,
      logBytes: 0,
      malformedLines: 0,
      dockerLogDriver: 'json-file',
    };
    expect(trafficSettingsView.parse(view)).toEqual(view);
    expect(trafficStatus.options).toEqual(['off', 'starting', 'running', 'error']);
  });
});

describe('traffic ranges and buckets', () => {
  it('maps short ranges to minute buckets and long ones to hour buckets', () => {
    expect(trafficRange.options).toEqual(['1h', '24h', '7d', '30d']);
    expect(trafficRange.options.map(trafficRangeGranularity)).toEqual([60, 60, 3600, 3600]);
    expect(TRAFFIC_GRANULARITIES).toEqual([60, 3600]);
    expect(trafficGranularity.safeParse(60).success).toBe(true);
    expect(trafficGranularity.safeParse(300).success).toBe(false);
  });

  it('has 11 latency edges plus an overflow bucket', () => {
    expect(TRAFFIC_LATENCY_EDGES_MS).toEqual([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
    expect(TRAFFIC_LATENCY_BUCKETS).toBe(12);
  });

  it('defaults and coerces the summary query', () => {
    expect(trafficSummaryQuery.parse({})).toEqual({ range: '24h', top: 10 });
    expect(trafficSummaryQuery.parse({ range: '7d', top: '50' })).toEqual({ range: '7d', top: 50 });
    expect(trafficSummaryQuery.safeParse({ top: '51' }).success).toBe(false);
    expect(trafficSummaryQuery.safeParse({ range: '1y' }).success).toBe(false);
    expect(trafficSummaryQuery.safeParse({ path: '/' }).success).toBe(false);
  });
});

describe('traffic summaries', () => {
  it('describes the instance summary', () => {
    const summary = {
      enabled: true,
      range: '1h',
      granularity: 60,
      totals: { ...counters, ...pct },
      series: [{ ...counters, t: '2026-10-08T00:00:00.000Z' }],
      topDomains: [domain],
      panel: { ...domain, scopeKey: 'panel', domainId: null, serviceId: null, host: null },
      custom: null,
    };
    expect(trafficSummary.parse(summary)).toEqual(summary);
    expect(trafficSummary.safeParse({ ...summary, totals: { ...counters, ...pct, requests: -1 } }).success).toBe(false);
  });

  it('describes an empty per-service summary (no data is not a 404)', () => {
    const empty = {
      enabled: false,
      range: '30d',
      granularity: 3600,
      totals: { ...counters, requests: 0, ...pct, p50Ms: null, p95Ms: null },
      series: [],
      domains: [],
    };
    expect(serviceTrafficSummary.parse(empty)).toEqual(empty);
    expect(serviceTrafficSummary.parse({ ...empty, domains: [domain] }).domains).toHaveLength(1);
  });
});
