import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPECTED_STATUS,
  monitorCreate,
  monitorPatch,
  monitorTargetProblem,
  overallStatus,
  parseExpectedStatus,
  parseTcpTarget,
  statusMatches,
  statusPageCreate,
  statusPagePatch,
  statusPageSlug,
} from '../src/index.js';

describe('0.16.8 uptime monitors', () => {
  it('parses expected status codes and ranges', () => {
    expect(parseExpectedStatus('200-399')).toEqual([[200, 399]]);
    expect(parseExpectedStatus('200, 204,301-302')).toEqual([
      [200, 200],
      [204, 204],
      [301, 302],
    ]);
    for (const bad of ['', '2xx', '99', '600', '300-200', '200-', 'abc', Array(21).fill('200').join(',')]) {
      expect(parseExpectedStatus(bad), bad).toBeNull();
    }
    expect(statusMatches(204, '200,204')).toBe(true);
    expect(statusMatches(500, DEFAULT_EXPECTED_STATUS)).toBe(false);
    expect(statusMatches(200, 'nope')).toBe(false);
  });

  it('parses TCP targets', () => {
    expect(parseTcpTarget('db.internal:5432')).toEqual({ host: 'db.internal', port: 5432 });
    expect(parseTcpTarget('10.0.0.5:22')).toEqual({ host: '10.0.0.5', port: 22 });
    expect(parseTcpTarget('[::1]:6379')).toEqual({ host: '::1', port: 6379 });
    for (const bad of ['db.internal', 'db:0', 'db:65536', ':80', 'a b:80', '-x:80']) expect(parseTcpTarget(bad), bad).toBeNull();
  });

  it('checks a target against its kind', () => {
    expect(monitorTargetProblem('http', 'https://example.com/health')).toBeNull();
    expect(monitorTargetProblem('http', 'http://[::1]:3000/')).toBeNull();
    expect(monitorTargetProblem('http', 'ftp://example.com')).toMatch(/http:\/\/ or https:\/\//);
    expect(monitorTargetProblem('http', 'https://user:pw@example.com/')).toMatch(/credentials/);
    expect(monitorTargetProblem('http', 'https://example.com/a@b')).toBeNull();
    expect(monitorTargetProblem('tcp', 'db:5432')).toBeNull();
    expect(monitorTargetProblem('tcp', 'https://example.com')).toMatch(/host:port/);
  });

  it('fills the defaults on create and refuses mismatched fields', () => {
    expect(monitorCreate.parse({ name: 'API', kind: 'http', target: 'https://api.example.com/health' })).toEqual({
      name: 'API',
      serviceId: null,
      kind: 'http',
      target: 'https://api.example.com/health',
      method: 'GET',
      expectedStatus: '200-399',
      keyword: null,
      intervalSeconds: 60,
      timeoutSeconds: 10,
      failuresBeforeDown: 2,
      followRedirects: true,
      verifyTls: true,
      enabled: true,
    });
    const issues = (body: Record<string, unknown>) => monitorCreate.safeParse(body).error?.issues.map((i) => i.message) ?? [];
    expect(issues({ name: 'x', kind: 'tcp', target: 'db:5432', keyword: 'ok' })).toEqual(['a keyword applies to HTTP checks']);
    expect(issues({ name: 'x', kind: 'http', target: 'https://a.example', method: 'HEAD', keyword: 'ok' })).toEqual(['a HEAD request has no body to search; use GET']);
    expect(issues({ name: 'x', kind: 'http', target: 'db:5432' })).toEqual(['an HTTP target is an http:// or https:// URL']);
    expect(issues({ name: 'x', kind: 'http', target: 'https://a.example', expectedStatus: '2xx' })).toHaveLength(1);
    expect(issues({ name: 'x', kind: 'http', target: 'https://a.example', intervalSeconds: 10 })).toHaveLength(1);
    expect(issues({ name: 'x', kind: 'http', target: 'https://a.example', extra: 1 })).toHaveLength(1);
  });

  it('a patch is partial; a target is checked only with its kind', () => {
    expect(monitorPatch.parse({ enabled: false })).toEqual({ enabled: false });
    expect(monitorPatch.parse({ target: 'db:5432' })).toEqual({ target: 'db:5432' });
    expect(monitorPatch.safeParse({ kind: 'tcp', target: 'https://a.example' }).success).toBe(false);
  });
});

describe('0.16.8 status pages', () => {
  it('validates slugs', () => {
    for (const ok of ['status', 'acme-prod', 'a', 'v2']) expect(statusPageSlug.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '-a', 'a-', 'A', 'a_b', 'a/b', 'x'.repeat(65)]) expect(statusPageSlug.safeParse(bad).success, bad).toBe(false);
  });

  it('fills defaults, refuses a monitor listed twice', () => {
    expect(statusPageCreate.parse({ slug: 'status', title: 'Acme status' })).toEqual({
      slug: 'status',
      title: 'Acme status',
      description: null,
      notice: null,
      published: false,
      showResponseTimes: true,
      monitorIds: [],
    });
    expect(statusPageCreate.safeParse({ slug: 'status', title: 'x', monitorIds: [1, 1] }).error?.issues[0]?.message).toBe('each monitor once');
    expect(statusPagePatch.parse({ published: true })).toEqual({ published: true });
  });

  it('derives the overall state', () => {
    expect(overallStatus([])).toBe('unknown');
    expect(overallStatus(['unknown'])).toBe('unknown');
    expect(overallStatus(['up', 'unknown'])).toBe('operational');
    expect(overallStatus(['up', 'down'])).toBe('degraded');
    expect(overallStatus(['down', 'down', 'unknown'])).toBe('down');
  });
});
