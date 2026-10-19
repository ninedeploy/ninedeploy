import { describe, expect, it } from 'vitest';
import type { MonitorView, StatusPageView } from '@ninedeploy/schemas';
import {
  certExpiry,
  daysUntil,
  emptyMonitorForm,
  emptyStatusPageForm,
  formatInterval,
  formatResponseMs,
  formatUptime,
  formToMonitorInput,
  formToStatusPageInput,
  monitorStatusUi,
  monitorToForm,
  moveItem,
  serviceMonitorTarget,
  slugify,
  sparklinePoints,
  statusPageToForm,
  targetPlaceholder,
  uptimeTone,
  validateMonitorForm,
  validateStatusPageForm,
} from '../src/lib/uptime.js';

/** 0.16.8 uptime helpers: formatting, colours and form ↔ API conversion. */

const MONITOR: MonitorView = {
  id: 7,
  name: 'API',
  serviceId: 3,
  kind: 'http',
  target: 'https://api.example.com/health',
  method: 'GET',
  expectedStatus: '200-299',
  keyword: 'ok',
  intervalSeconds: 120,
  timeoutSeconds: 5,
  failuresBeforeDown: 3,
  followRedirects: false,
  verifyTls: false,
  enabled: true,
  status: 'up',
  statusSince: null,
  consecutiveFailures: 0,
  lastCheckedAt: null,
  lastResponseMs: 12,
  lastStatusCode: 200,
  lastError: null,
  certExpiresAt: null,
  uptime: { h24: 100, d7: 99.5, d30: null },
  createdAt: '2026-10-01T00:00:00Z',
};

describe('uptime formatting', () => {
  it('formats uptime percentages', () => {
    expect(formatUptime(100)).toBe('100%');
    expect(formatUptime(99.954)).toBe('99.95%');
    expect(formatUptime(99.5)).toBe('99.5%');
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(undefined)).toBe('—');
    expect(formatUptime(Number.NaN)).toBe('—');
  });

  it('colours uptime by health', () => {
    expect(uptimeTone(99.9)).toBe('emerald');
    expect(uptimeTone(97)).toBe('amber');
    expect(uptimeTone(50)).toBe('rose');
    expect(uptimeTone(null)).toBe('neutral');
  });

  it('maps a monitor state to its colours, an unknown one to pending', () => {
    expect(monitorStatusUi('up').label).toBe('UP');
    expect(monitorStatusUi('down').dot).toBe('bg-rose-500');
    expect(monitorStatusUi('paused').label).toBe('PAUSED');
    expect(monitorStatusUi('weird')).toEqual(monitorStatusUi('pending'));
  });

  it('orders response times oldest first and skips checks without one', () => {
    const checks = [
      { ts: '3', ok: true, responseMs: 30, statusCode: 200, error: null },
      { ts: '2', ok: false, responseMs: null, statusCode: null, error: 'timeout' },
      { ts: '1', ok: true, responseMs: 10, statusCode: 200, error: null },
    ];
    expect(sparklinePoints(checks)).toEqual([10, 30]);
    expect(sparklinePoints([])).toEqual([]);
  });

  it('reads certificate expiry, warning under 14 days', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    expect(daysUntil('2026-10-30T12:00:00Z', now)).toBe(10);
    expect(certExpiry('2026-10-30T12:00:00Z', now)).toEqual({ text: 'certificate expires in 10 days', tone: 'amber' });
    expect(certExpiry('2026-10-21T12:00:00Z', now)).toEqual({ text: 'certificate expires in 1 day', tone: 'amber' });
    expect(certExpiry('2026-12-30T00:00:00Z', now).tone).toBe('neutral');
    expect(certExpiry('2026-10-20T06:00:00Z', now)).toEqual({ text: 'certificate expires today', tone: 'rose' });
    expect(certExpiry('2026-10-01T00:00:00Z', now)).toEqual({ text: 'certificate expired', tone: 'rose' });
    expect(typeof certExpiry('2030-01-01T00:00:00Z').text).toBe('string');
  });

  it('formats response times and intervals', () => {
    expect(formatResponseMs(123.4)).toBe('123 ms');
    expect(formatResponseMs(1250)).toBe('1.3 s');
    expect(formatResponseMs(null)).toBe('—');
    expect(formatInterval(45)).toBe('every 45s');
    expect(formatInterval(300)).toBe('every 5m');
    expect(formatInterval(3600)).toBe('every 1h');
  });

  it('offers a target placeholder per kind', () => {
    expect(targetPlaceholder('http')).toMatch(/^https:\/\//);
    expect(targetPlaceholder('tcp')).toMatch(/:\d+$/);
  });
});

describe('monitor form', () => {
  it('starts with the API defaults and takes a prefill', () => {
    const f = emptyMonitorForm({ serviceId: '3', target: 'https://x.test/' });
    expect(f).toMatchObject({ kind: 'http', method: 'GET', expectedStatus: '200-399', intervalSeconds: '60', timeoutSeconds: '10', failuresBeforeDown: '2', serviceId: '3', target: 'https://x.test/' });
  });

  it('round-trips a monitor through the form', () => {
    const f = monitorToForm(MONITOR);
    expect(f).toMatchObject({ serviceId: '3', keyword: 'ok', intervalSeconds: '120', verifyTls: false });
    expect(monitorToForm({ ...MONITOR, serviceId: null, keyword: null }).serviceId).toBe('');
    expect(formToMonitorInput(f)).toEqual({
      name: 'API',
      serviceId: 3,
      kind: 'http',
      target: 'https://api.example.com/health',
      method: 'GET',
      expectedStatus: '200-299',
      keyword: 'ok',
      intervalSeconds: 120,
      timeoutSeconds: 5,
      failuresBeforeDown: 3,
      followRedirects: false,
      verifyTls: false,
      enabled: true,
    });
  });

  it('drops HTTP-only fields for a TCP check', () => {
    const body = formToMonitorInput({ ...monitorToForm(MONITOR), kind: 'tcp', method: 'HEAD', target: 'db:5432', serviceId: '' });
    expect(body).toMatchObject({ kind: 'tcp', method: 'GET', keyword: null, expectedStatus: '200-399', serviceId: null });
  });

  it('validates with the API schema', () => {
    const ok = validateMonitorForm(emptyMonitorForm({ name: 'Site', target: 'https://example.com' }), 'create');
    expect(ok.ok).toBe(true);

    const bad = validateMonitorForm(emptyMonitorForm({ name: ' ', target: 'nope', intervalSeconds: '', expectedStatus: '999' }), 'create');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(['expectedStatus', 'intervalSeconds', 'name', 'target']);
      expect(bad.errors.target).toBe('an HTTP target is an http:// or https:// URL');
    }

    const tcp = validateMonitorForm(emptyMonitorForm({ name: 'db', kind: 'tcp', target: 'db.internal' }), 'edit');
    expect(tcp.ok).toBe(false);
    if (!tcp.ok) expect(tcp.errors.target).toMatch(/host:port/);

    const head = validateMonitorForm(emptyMonitorForm({ name: 'x', target: 'https://e.com', method: 'HEAD', keyword: 'ok' }), 'edit');
    expect(head.ok).toBe(false);
    if (!head.ok) expect(head.errors.keyword).toMatch(/HEAD/);
  });

  it('builds the starting URL for a service monitor', () => {
    expect(serviceMonitorTarget([{ hostname: 'app.example.com', path: '/', ssl: true }])).toBe('https://app.example.com/');
    expect(serviceMonitorTarget([{ hostname: 'app.example.com', path: '/api', ssl: false }])).toBe('http://app.example.com/api');
    expect(serviceMonitorTarget([{ hostname: 'a.test', path: 'v1' }])).toBe('https://a.test/v1');
    expect(serviceMonitorTarget([{ hostname: 'a.test', path: null }])).toBe('https://a.test/');
    expect(serviceMonitorTarget([], 'api.nd.local')).toBe('http://api.nd.local/');
    expect(serviceMonitorTarget(undefined, null)).toBe('');
  });
});

describe('status page form', () => {
  const PAGE: StatusPageView = {
    id: 2,
    slug: 'acme',
    title: 'Acme',
    description: null,
    notice: 'Maintenance at 10:00',
    published: true,
    showResponseTimes: false,
    monitorIds: [7, 8],
    path: '/status/acme',
    createdAt: '2026-10-01T00:00:00Z',
  };

  it('round-trips a page and turns blank texts into null', () => {
    const f = statusPageToForm(PAGE);
    expect(f.description).toBe('');
    expect(formToStatusPageInput(f)).toEqual({
      slug: 'acme',
      title: 'Acme',
      description: null,
      notice: 'Maintenance at 10:00',
      published: true,
      showResponseTimes: false,
      monitorIds: [7, 8],
    });
    expect(emptyStatusPageForm()).toMatchObject({ published: false, showResponseTimes: true, monitorIds: [] });
  });

  it('validates the slug and title', () => {
    expect(validateStatusPageForm({ ...emptyStatusPageForm(), slug: 'ok-1', title: 'Ok' }, 'create').ok).toBe(true);
    const bad = validateStatusPageForm({ ...emptyStatusPageForm(), slug: '-Bad', title: '' }, 'edit');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.slug).toMatch(/lowercase/);
      expect(bad.errors.title).toBeDefined();
    }
  });

  it('suggests a slug from a title', () => {
    expect(slugify('  Acme Status!  ')).toBe('acme-status');
    expect(slugify('Ünïcode Çafé')).toBe('unicode-cafe');
    expect(slugify(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
  });

  it('moves an item up and down, leaving the edges alone', () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 5, 1)).toEqual([1, 2, 3]);
  });
});
