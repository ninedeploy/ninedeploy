import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  monitorKindFor,
  monitorsAdd,
  monitorsCheck,
  monitorsList,
  monitorsRemove,
  monitorsSetEnabled,
  monitorsShow,
  resolveServiceRef,
  statusPageUrl,
  statusPagesAdd,
  statusPagesList,
  statusPagesNotice,
  statusPagesRemove,
  statusPagesSetPublished,
  validationMessage,
} from '../src/commands/uptime.js';

/** 0.16.8: `monitors` and `status-pages` commands. */

const h = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('../src/prompts.js', () => ({ prompt: h.prompt }));
vi.mock('../src/config.js', () => ({ loadConfig: () => ({ baseUrl: 'https://panel.example/' }), saveConfig: vi.fn() }));

const ESC = String.fromCharCode(27);

function makeClient() {
  return {
    services: { list: vi.fn() },
    monitors: { list: vi.fn(), get: vi.fn(), checks: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), checkNow: vi.fn() },
    statusPages: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), public: vi.fn() },
  };
}
type Client = ReturnType<typeof makeClient>;
const asClient = (c: Client) => c as never;

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;
const out = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const err = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const monitor = (over: Record<string, unknown> = {}) => ({
  id: 7,
  name: `site${ESC}[2J`,
  serviceId: null,
  kind: 'http',
  target: 'https://example.com',
  method: 'GET',
  expectedStatus: '200-399',
  keyword: null,
  intervalSeconds: 60,
  timeoutSeconds: 10,
  failuresBeforeDown: 2,
  followRedirects: true,
  verifyTls: true,
  enabled: true,
  status: 'up',
  statusSince: '2026-10-19T00:00:00.000Z',
  consecutiveFailures: 0,
  lastCheckedAt: new Date().toISOString(),
  lastResponseMs: 42,
  lastStatusCode: 200,
  lastError: null,
  certExpiresAt: null,
  uptime: { h24: 99.5, d7: 100, d30: null },
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({
  id: 3,
  slug: 'acme',
  title: 'Acme',
  description: null,
  notice: null,
  published: true,
  showResponseTimes: true,
  monitorIds: [7],
  path: '/status/acme',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('resolveServiceRef', () => {
  it('takes a numeric id as is and looks a slug or name up', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]);
    await expect(resolveServiceRef(asClient(client), '12')).resolves.toBe(12);
    expect(client.services.list).not.toHaveBeenCalled();
    await expect(resolveServiceRef(asClient(client), 'web')).resolves.toBe(4);
    await expect(resolveServiceRef(asClient(client), 'Web')).resolves.toBe(4);
  });

  it('prints why an unknown slug or a zero id is refused', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([]);
    await expect(resolveServiceRef(asClient(client), 'nope')).resolves.toBeNull();
    expect(err()).toContain('No service named "nope"');
    await expect(resolveServiceRef(asClient(client), '0')).resolves.toBeNull();
    expect(err()).toContain('--service must be a positive integer');
  });
});

describe('monitorKindFor', () => {
  it('is tcp for --tcp or a scheme-less host:port, http otherwise', () => {
    expect(monitorKindFor('https://example.com')).toBe('http');
    expect(monitorKindFor('db.internal:5432')).toBe('tcp');
    expect(monitorKindFor('[::1]:6379')).toBe('tcp');
    expect(monitorKindFor('example.com')).toBe('http');
    expect(monitorKindFor('http://host:80')).toBe('http');
    expect(monitorKindFor('anything', true)).toBe('tcp');
  });
});

describe('monitors list', () => {
  it('prints a table with status, uptime and the sanitised name', async () => {
    const client = makeClient();
    client.monitors.list.mockResolvedValue([
      monitor(),
      monitor({ id: 8, kind: 'tcp', target: 'db:5432', status: 'down', lastResponseMs: null, lastCheckedAt: null }),
      monitor({ id: 9, status: 'pending' }),
      monitor({ id: 10, status: 'paused' }),
    ]);
    await monitorsList(asClient(client));
    expect(client.monitors.list).toHaveBeenCalledWith(undefined);
    const text = out();
    expect(text).toContain('99.50%');
    expect(text).toContain('tcp db:5432');
    expect(text).toContain('site');
    expect(text).not.toContain(`${ESC}[2J`);
    expect(text).toContain('never');
  });

  it('filters by a service slug and prints JSON without a spinner', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]);
    client.monitors.list.mockResolvedValue([monitor()]);
    await monitorsList(asClient(client), { service: 'web', json: true });
    expect(client.monitors.list).toHaveBeenCalledWith({ serviceId: 4 });
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toHaveLength(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('hints when there are none, and stops on an unknown service', async () => {
    const client = makeClient();
    client.monitors.list.mockResolvedValue([]);
    await monitorsList(asClient(client));
    expect(out()).toContain('No monitors yet');
    client.services.list.mockResolvedValue([]);
    await monitorsList(asClient(client), { service: 'ghost' });
    expect(client.monitors.list).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('prints a failed request', async () => {
    const client = makeClient();
    client.monitors.list.mockRejectedValue(new Error('forbidden'));
    await monitorsList(asClient(client));
    expect(err()).toContain('forbidden');
  });
});

describe('monitors add', () => {
  it('sends only what the flags set for an http monitor', async () => {
    const client = makeClient();
    client.monitors.create.mockResolvedValue(monitor());
    await monitorsAdd(asClient(client), 'site', 'https://example.com');
    expect(client.monitors.create).toHaveBeenCalledWith({ name: 'site', kind: 'http', target: 'https://example.com' });
    expect(out()).toContain('Monitor #7');
    expect(out()).toContain('monitors check 7');
  });

  it('maps every flag onto the create body', async () => {
    const client = makeClient();
    client.services.list.mockResolvedValue([{ id: 4, slug: 'web', name: 'Web' }]);
    client.monitors.create.mockResolvedValue(monitor({ enabled: false, status: 'paused' }));
    await monitorsAdd(asClient(client), 'site', 'https://example.com/health', {
      service: 'web',
      interval: '120',
      timeout: '5',
      failures: '3',
      expect: '200,204',
      followRedirects: false,
      insecure: true,
      disabled: true,
      head: true,
    });
    expect(client.monitors.create).toHaveBeenCalledWith({
      name: 'site',
      kind: 'http',
      target: 'https://example.com/health',
      serviceId: 4,
      intervalSeconds: 120,
      timeoutSeconds: 5,
      failuresBeforeDown: 3,
      expectedStatus: '200,204',
      method: 'HEAD',
      followRedirects: false,
      verifyTls: false,
      enabled: false,
    });
    expect(out()).toContain('monitors resume 7');
  });

  it('infers tcp for host:port and keeps a keyword on http', async () => {
    const client = makeClient();
    client.monitors.create.mockResolvedValue(monitor({ kind: 'tcp', target: 'db:5432' }));
    await monitorsAdd(asClient(client), 'db', 'db:5432');
    expect(client.monitors.create).toHaveBeenLastCalledWith({ name: 'db', kind: 'tcp', target: 'db:5432' });
    await monitorsAdd(asClient(client), 'site', 'https://example.com', { keyword: 'Welcome' });
    expect(client.monitors.create).toHaveBeenLastCalledWith({ name: 'site', kind: 'http', target: 'https://example.com', keyword: 'Welcome' });
    await monitorsAdd(asClient(client), 'forced', 'db:5432', { tcp: true });
    expect(client.monitors.create).toHaveBeenLastCalledWith({ name: 'forced', kind: 'tcp', target: 'db:5432' });
  });

  it('refuses invalid input before sending, naming the flag', async () => {
    const client = makeClient();
    await monitorsAdd(asClient(client), 'site', 'https://example.com', { interval: '5' });
    expect(err()).toContain('--interval');
    await monitorsAdd(asClient(client), 'site', 'ftp://example.com');
    expect(err()).toContain('<target>: an HTTP target is an http:// or https:// URL');
    await monitorsAdd(asClient(client), 'site', 'https://example.com', { expect: '99' });
    expect(err()).toContain('--expect');
    await monitorsAdd(asClient(client), 'db', 'db:5432', { keyword: 'x' });
    expect(err()).toContain('--keyword: a keyword applies to HTTP checks');
    await monitorsAdd(asClient(client), '', 'https://example.com');
    expect(err()).toContain('<name>');
    expect(client.monitors.create).not.toHaveBeenCalled();
  });

  it('labels an issue by its flag, its field or as input', async () => {
    expect(
      validationMessage({ issues: [{ path: ['intervalSeconds'], message: 'too small' }, { path: ['method'], message: 'bad' }, { path: [], message: 'unknown key' }] }),
    ).toBe('--interval: too small; method: bad; input: unknown key');
    const client = makeClient();
    await monitorsAdd(asClient(client), 'site', 'https://example.com', { head: true, keyword: 'x' });
    expect(err()).toContain('--keyword: a HEAD request has no body');
    await statusPagesAdd(asClient(client), 'acme', 'Acme', { monitor: ['7', '7'] });
    expect(err()).toContain('--monitor: each monitor once');
  });

  it('refuses a non-integer number flag and an unknown service', async () => {
    const client = makeClient();
    await monitorsAdd(asClient(client), 'site', 'https://example.com', { timeout: 'soon' });
    expect(err()).toContain('--timeout must be a whole number');
    await monitorsAdd(asClient(client), 'site', 'https://example.com', { failures: ' ' });
    expect(err()).toContain('--failures must be a whole number');
    client.services.list.mockResolvedValue([]);
    await monitorsAdd(asClient(client), 'site', 'https://example.com', { service: 'ghost' });
    expect(client.monitors.create).not.toHaveBeenCalled();
  });

  it('prints a server refusal', async () => {
    const client = makeClient();
    client.monitors.create.mockRejectedValue('service_not_found');
    await monitorsAdd(asClient(client), 'site', 'https://example.com');
    expect(err()).toContain('service_not_found');
  });
});

describe('monitors show', () => {
  it('prints http details and the last 10 checks', async () => {
    const client = makeClient();
    client.monitors.get.mockResolvedValue(monitor({ keyword: 'ok', certExpiresAt: '2027-01-01T00:00:00.000Z', verifyTls: false, followRedirects: false, serviceId: 4, lastError: `boom${ESC}]0;x` }));
    client.monitors.checks.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ ts: new Date().toISOString(), ok: i !== 1, responseMs: i === 2 ? null : 10 + i, statusCode: i === 2 ? null : 200, error: i === 1 ? 'timeout' : null })),
    );
    await monitorsShow(asClient(client), '7');
    expect(client.monitors.checks).toHaveBeenCalledWith(7, { hours: 24 });
    const text = out();
    expect(text).toContain('Monitor #7');
    expect(text).toContain('#4');
    expect(text).toContain('not verified');
    expect(text).toContain('not followed');
    expect(text).toContain('2027-01-01');
    expect(text).toContain('42 ms (HTTP 200)');
    expect(text).toContain('timeout');
    expect(text).not.toContain(ESC + ']0;');
    // 10 rows: the 11th and 12th checks are not shown
    expect(text.match(/just now/g)).toHaveLength(10);
  });

  it('prints a tcp monitor without http fields, and no checks', async () => {
    const client = makeClient();
    client.monitors.get.mockResolvedValue(
      monitor({ kind: 'tcp', target: 'db:5432', intervalSeconds: 3600, statusSince: null, lastResponseMs: null, lastStatusCode: null, lastError: 'refused' }),
    );
    client.monitors.checks.mockResolvedValue([]);
    await monitorsShow(asClient(client), '7');
    expect(client.monitors.checks).toHaveBeenCalledWith(7, { hours: 24 });
    expect(out()).not.toContain('Expect');
    expect(out()).toContain('operator only');
    expect(out()).toContain('No checks recorded yet');
  });

  it('asks for up to a week of history for a slow monitor and a response without a code', async () => {
    const client = makeClient();
    client.monitors.get.mockResolvedValue(monitor({ intervalSeconds: 3600 * 20, lastStatusCode: null }));
    client.monitors.checks.mockResolvedValue([]);
    await monitorsShow(asClient(client), '7');
    expect(client.monitors.checks).toHaveBeenCalledWith(7, { hours: 168 });
    expect(out()).toContain('42 ms');
    expect(out()).not.toContain('(HTTP');
  });

  it('prints JSON, refuses a bad id and prints a failure', async () => {
    const client = makeClient();
    client.monitors.get.mockResolvedValue(monitor());
    client.monitors.checks.mockResolvedValue([]);
    await monitorsShow(asClient(client), '7', { json: true });
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toMatchObject({ monitor: { id: 7 }, checks: [] });
    await monitorsShow(asClient(client), 'x');
    expect(err()).toContain('Monitor id must be a positive integer');
    client.monitors.get.mockRejectedValue(new Error('Monitor not found'));
    await monitorsShow(asClient(client), '9');
    expect(err()).toContain('Monitor not found');
  });
});

describe('monitors check / pause / resume / rm', () => {
  it('reports a passing and a failing check', async () => {
    const client = makeClient();
    client.monitors.checkNow.mockResolvedValueOnce({ check: { ts: '', ok: true, responseMs: 12, statusCode: 200, error: null }, monitor: monitor() });
    await monitorsCheck(asClient(client), '7');
    expect(out()).toContain('Check passed (12 ms, HTTP 200)');
    expect(out()).toContain('Monitor #7 is up');
    client.monitors.checkNow.mockResolvedValueOnce({ check: { ts: '', ok: false, responseMs: null, statusCode: null, error: 'ECONNREFUSED' }, monitor: monitor({ status: 'down' }) });
    await monitorsCheck(asClient(client), '7');
    expect(err()).toContain('Check failed: ECONNREFUSED');
    client.monitors.checkNow.mockResolvedValueOnce({ check: { ts: '', ok: false, responseMs: 5, statusCode: 500, error: null }, monitor: monitor({ status: 'down' }) });
    await monitorsCheck(asClient(client), '7');
    expect(err()).toContain('Check failed (5 ms, HTTP 500): no detail');
    client.monitors.checkNow.mockResolvedValueOnce({ check: { ts: '', ok: true, responseMs: null, statusCode: null, error: null }, monitor: monitor() });
    await monitorsCheck(asClient(client), '7');
    expect(out()).toContain('Check passed.');
  });

  it('refuses a bad id and prints a failure for check', async () => {
    const client = makeClient();
    await monitorsCheck(asClient(client), '-1');
    expect(client.monitors.checkNow).not.toHaveBeenCalled();
    client.monitors.checkNow.mockRejectedValue(new Error('nope'));
    await monitorsCheck(asClient(client), '7');
    expect(err()).toContain('nope');
  });

  it('pauses and resumes through enabled', async () => {
    const client = makeClient();
    client.monitors.update.mockResolvedValueOnce(monitor({ status: 'paused', enabled: false }));
    await monitorsSetEnabled(asClient(client), '7', false);
    expect(client.monitors.update).toHaveBeenLastCalledWith(7, { enabled: false });
    expect(out()).toContain('Monitor #7 paused (paused)');
    client.monitors.update.mockResolvedValueOnce(monitor({ status: 'pending' }));
    await monitorsSetEnabled(asClient(client), '7', true);
    expect(client.monitors.update).toHaveBeenLastCalledWith(7, { enabled: true });
    expect(out()).toContain('Monitor #7 resumed (pending)');
    await monitorsSetEnabled(asClient(client), 'x', true);
    expect(client.monitors.update).toHaveBeenCalledTimes(2);
    client.monitors.update.mockRejectedValue(new Error('denied'));
    await monitorsSetEnabled(asClient(client), '7', true);
    expect(err()).toContain('denied');
  });

  it('deletes after confirmation or --yes, and cancels otherwise', async () => {
    const client = makeClient();
    client.monitors.delete.mockResolvedValue({ ok: true });
    h.prompt.mockResolvedValueOnce('no');
    await monitorsRemove(asClient(client), '7');
    expect(client.monitors.delete).not.toHaveBeenCalled();
    expect(out()).toContain('Cancelled');
    h.prompt.mockResolvedValueOnce(' YES ');
    await monitorsRemove(asClient(client), '7');
    expect(client.monitors.delete).toHaveBeenCalledWith(7);
    await monitorsRemove(asClient(client), '7', { yes: true });
    expect(client.monitors.delete).toHaveBeenCalledTimes(2);
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(out()).toContain('Monitor #7 deleted');
    await monitorsRemove(asClient(client), '0');
    expect(client.monitors.delete).toHaveBeenCalledTimes(2);
    client.monitors.delete.mockRejectedValue(new Error('gone'));
    await monitorsRemove(asClient(client), '7', { yes: true });
    expect(err()).toContain('gone');
  });
});

describe('status pages', () => {
  it('builds the public URL from the panel URL and the path', () => {
    expect(statusPageUrl({ path: '/status/acme' })).toBe('https://panel.example/status/acme');
  });

  it('lists pages with their URL, as JSON, empty, and on failure', async () => {
    const client = makeClient();
    client.statusPages.list.mockResolvedValue([page(), page({ id: 4, slug: 'b', published: false, notice: 'Maintenance', monitorIds: [] })]);
    await statusPagesList(asClient(client));
    expect(out()).toContain('https://panel.example/status/acme');
    expect(out()).toContain('yes');
    logSpy.mockClear();
    await statusPagesList(asClient(client), { json: true });
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toHaveLength(2);
    client.statusPages.list.mockResolvedValue([]);
    await statusPagesList(asClient(client));
    expect(out()).toContain('No status pages yet');
    client.statusPages.list.mockRejectedValue(new Error('operator only'));
    await statusPagesList(asClient(client));
    expect(err()).toContain('operator only');
  });

  it('adds a page with monitors and prints its URL when published', async () => {
    const client = makeClient();
    client.statusPages.create.mockResolvedValueOnce(page());
    await statusPagesAdd(asClient(client), 'acme', 'Acme', { monitor: ['7', '8'], publish: true });
    expect(client.statusPages.create).toHaveBeenCalledWith({ slug: 'acme', title: 'Acme', monitorIds: [7, 8], published: true });
    expect(out()).toContain('Public URL: https://panel.example/status/acme');
    client.statusPages.create.mockResolvedValueOnce(page({ published: false, monitorIds: [] }));
    await statusPagesAdd(asClient(client), 'acme', 'Acme');
    expect(client.statusPages.create).toHaveBeenLastCalledWith({ slug: 'acme', title: 'Acme', monitorIds: [], published: false });
    expect(out()).toContain('status-pages publish 3');
  });

  it('refuses a bad slug or monitor id before sending, and prints a conflict', async () => {
    const client = makeClient();
    await statusPagesAdd(asClient(client), 'Bad Slug', 'Acme');
    expect(err()).toContain('<slug>');
    await statusPagesAdd(asClient(client), 'acme', 'Acme', { monitor: ['x'] });
    expect(err()).toContain('--monitor must be a positive integer');
    expect(client.statusPages.create).not.toHaveBeenCalled();
    client.statusPages.create.mockRejectedValue(new Error('The slug "acme" is taken'));
    await statusPagesAdd(asClient(client), 'acme', 'Acme');
    expect(err()).toContain('is taken');
  });

  it('publishes and unpublishes', async () => {
    const client = makeClient();
    client.statusPages.update.mockResolvedValueOnce(page());
    await statusPagesSetPublished(asClient(client), '3', true);
    expect(client.statusPages.update).toHaveBeenLastCalledWith(3, { published: true });
    expect(out()).toContain('published');
    client.statusPages.update.mockResolvedValueOnce(page({ published: false }));
    await statusPagesSetPublished(asClient(client), '3', false);
    expect(client.statusPages.update).toHaveBeenLastCalledWith(3, { published: false });
    expect(out()).toContain('unpublished');
    await statusPagesSetPublished(asClient(client), 'x', true);
    expect(client.statusPages.update).toHaveBeenCalledTimes(2);
    client.statusPages.update.mockRejectedValue(new Error('Status page not found'));
    await statusPagesSetPublished(asClient(client), '3', true);
    expect(err()).toContain('Status page not found');
  });

  it('sets and clears the notice, refusing ambiguous or empty input', async () => {
    const client = makeClient();
    client.statusPages.update.mockResolvedValue(page());
    await statusPagesNotice(asClient(client), '3', 'Maintenance at 22:00');
    expect(client.statusPages.update).toHaveBeenLastCalledWith(3, { notice: 'Maintenance at 22:00' });
    expect(out()).toContain('Notice set');
    await statusPagesNotice(asClient(client), '3', undefined, { clear: true });
    expect(client.statusPages.update).toHaveBeenLastCalledWith(3, { notice: null });
    expect(out()).toContain('Notice cleared');
    await statusPagesNotice(asClient(client), '3', 'x', { clear: true });
    expect(err()).toContain('not both');
    await statusPagesNotice(asClient(client), '3', '  ');
    expect(err()).toContain('Usage');
    await statusPagesNotice(asClient(client), '3', undefined);
    await statusPagesNotice(asClient(client), '3', 'x'.repeat(1001));
    expect(err()).toContain('<text>');
    await statusPagesNotice(asClient(client), 'x', 'hi');
    expect(client.statusPages.update).toHaveBeenCalledTimes(2);
    client.statusPages.update.mockRejectedValue(new Error('denied'));
    await statusPagesNotice(asClient(client), '3', 'hi');
    expect(err()).toContain('denied');
  });

  it('deletes after confirmation or --yes', async () => {
    const client = makeClient();
    client.statusPages.delete.mockResolvedValue({ ok: true });
    h.prompt.mockResolvedValueOnce('');
    await statusPagesRemove(asClient(client), '3');
    expect(client.statusPages.delete).not.toHaveBeenCalled();
    h.prompt.mockResolvedValueOnce('yes');
    await statusPagesRemove(asClient(client), '3');
    await statusPagesRemove(asClient(client), '3', { yes: true });
    expect(client.statusPages.delete).toHaveBeenCalledTimes(2);
    expect(out()).toContain('Status page #3 deleted');
    await statusPagesRemove(asClient(client), 'x');
    client.statusPages.delete.mockRejectedValue(new Error('gone'));
    await statusPagesRemove(asClient(client), '3', { yes: true });
    expect(err()).toContain('gone');
  });
});
