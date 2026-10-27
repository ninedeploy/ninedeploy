/**
 * G3.7: Mattermost, Google Chat, Matrix, PagerDuty and Opsgenie channels
 * (lib/notifier.ts, lib/incidentChannels.ts). The provider endpoints are
 * faked at `fetch`; the egress guard is passed through as in notifier.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../../src/lib/crypto.js';

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);
vi.mock('../../src/lib/egressGuard.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/egressGuard.js')>('../../src/lib/egressGuard.js');
  return { ...actual, guardedFetch: (url: string, init?: RequestInit) => fetch(url, init) };
});

const { dispatchChannel, notifyEvent, parseMatrixTarget } = await import('../../src/lib/notifier.js');
const { incidentActionFor, parseOpsgenieTarget, parsePagerDutyTarget } = await import('../../src/lib/incidentChannels.js');

const ok = (status = 200) => ({ ok: true, status, text: async () => '' });
const err = (status: number, body = '') => ({ ok: false, status, text: async () => body });
const ev = (action: string, meta?: Record<string, unknown>, entity = 'web') => ({ id: 7, action, entity, ts: '2026-10-27T10:00:00.000Z', actorUserId: null, ...(meta ? { meta } : {}) });
const sent = (i = 0) => ({ url: String(fetchMock.mock.calls[i]![0]), init: fetchMock.mock.calls[i]![1] as RequestInit & { headers: Record<string, string> } });
const body = (i = 0) => JSON.parse(String(sent(i).init.body)) as Record<string, unknown>;

beforeEach(() => {
  vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'b'.repeat(64));
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok());
});
afterEach(() => vi.unstubAllEnvs());

describe('Mattermost and Google Chat', () => {
  it('posts a Slack-style text payload to a Mattermost webhook', async () => {
    await dispatchChannel('mattermost', 'https://mm.example.com/hooks/abc', ev('deploy.failed'), 'boom');
    expect(sent().url).toBe('https://mm.example.com/hooks/abc');
    expect(body()).toEqual({ text: 'boom', username: 'NineDeploy' });
    fetchMock.mockResolvedValueOnce(err(403));
    await expect(dispatchChannel('mattermost', 'https://mm.example.com/hooks/abc', ev('x.y'), 'm')).rejects.toThrow('Mattermost 403');
  });

  it('posts to a Google Chat space webhook and refuses any other host', async () => {
    const url = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t';
    await dispatchChannel('googlechat', url, ev('deploy.failed'), 'boom');
    expect(sent().url).toBe(url);
    expect(body()).toEqual({ text: 'boom' });
    for (const bad of ['not a url', 'http://chat.googleapis.com/v1/x', 'https://evil.example.com/v1/spaces/AAA/messages']) {
      await expect(dispatchChannel('googlechat', bad, ev('x.y'), 'm')).rejects.toThrow(/Invalid Google Chat target/);
    }
    fetchMock.mockResolvedValueOnce(err(400));
    await expect(dispatchChannel('googlechat', url, ev('x.y'), 'm')).rejects.toThrow('Google Chat 400');
  });
});

describe('Matrix', () => {
  const target = JSON.stringify({ homeserver: 'https://matrix.example.org/', roomId: '!room:example.org', accessToken: 'syt_secret' });

  it('PUTs an m.text message with a transaction id derived from the event', async () => {
    await dispatchChannel('matrix', target, ev('deploy.failed'), 'boom');
    await dispatchChannel('matrix', target, ev('deploy.failed'), 'boom');
    const { url, init } = sent();
    expect(init.method).toBe('PUT');
    expect(url).toMatch(/^https:\/\/matrix\.example\.org\/_matrix\/client\/v3\/rooms\/!room%3Aexample\.org\/send\/m\.room\.message\/nd[0-9a-f]{32}$/);
    expect(init.headers['Authorization']).toBe('Bearer syt_secret');
    expect(body()).toEqual({ msgtype: 'm.text', body: 'boom' });
    // A retried send of the same event reuses its transaction id (no duplicate message).
    expect(sent(1).url).toBe(url);
    fetchMock.mockResolvedValueOnce(err(403));
    await expect(dispatchChannel('matrix', target, ev('x.y'), 'm')).rejects.toThrow('Matrix 403');
  });

  it('validates the target', () => {
    expect(parseMatrixTarget(target)).toEqual({ homeserver: 'https://matrix.example.org', roomId: '!room:example.org', accessToken: 'syt_secret' });
    expect(() => parseMatrixTarget('nope')).toThrow(/expected JSON/);
    expect(() => parseMatrixTarget('{}')).toThrow(/expected JSON/);
    expect(() => parseMatrixTarget('null')).toThrow(/expected JSON/);
    expect(() => parseMatrixTarget(JSON.stringify({ homeserver: 'http://m.org', roomId: '!r:m.org', accessToken: 't' }))).toThrow(/https URL/);
    expect(() => parseMatrixTarget(JSON.stringify({ homeserver: 'https://m.org', roomId: 'room', accessToken: 't' }))).toThrow(/roomId must look like/);
  });
});

describe('incident classification', () => {
  it('opens on problems and closes on their fix with the same key', () => {
    expect(incidentActionFor(ev('alert.fired', { ruleId: 4 }))).toEqual({ kind: 'trigger', key: 'alert-rule-4', severity: 'error' });
    expect(incidentActionFor(ev('alert.recovered', { ruleId: 4 }))).toEqual({ kind: 'resolve', key: 'alert-rule-4', severity: 'info' });
    expect(incidentActionFor(ev('alert.monitor_down', { monitorId: 9 }))).toEqual({ kind: 'trigger', key: 'monitor-9', severity: 'critical' });
    expect(incidentActionFor(ev('alert.monitor_up', { monitorId: 9 }))).toEqual({ kind: 'resolve', key: 'monitor-9', severity: 'info' });
    expect(incidentActionFor(ev('alert.service_down', { serviceId: 2 }))).toMatchObject({ kind: 'trigger', key: 'service-down-2' });
    expect(incidentActionFor(ev('deploy.failed', { serviceId: 2 }))).toEqual({ kind: 'trigger', key: 'deploy-2', severity: 'error' });
    expect(incidentActionFor(ev('deploy.success', { serviceId: 2 }))).toEqual({ kind: 'resolve', key: 'deploy-2', severity: 'info' });
    expect(incidentActionFor(ev('backup.missed'))).toMatchObject({ kind: 'trigger', severity: 'warning' });
    expect(incidentActionFor(ev('alert.service_recovery_held'))).toMatchObject({ kind: 'trigger', severity: 'warning' });
  });

  it('falls back to a hash of the entity, and ignores fixes it cannot match and everything else', () => {
    const a = incidentActionFor(ev('alert.fired', undefined, 'cpu > 90'))!;
    expect(a.key).toMatch(/^alert\.fired-[0-9a-f]{16}$/);
    expect(incidentActionFor(ev('alert.fired', undefined, 'cpu > 90'))!.key).toBe(a.key);
    expect(incidentActionFor(ev('alert.monitor_down'))!.key).toMatch(/^alert\.monitor_down-/);
    expect(incidentActionFor(ev('alert.service_down'))!.key).toMatch(/^alert\.service_down-/);
    expect(incidentActionFor(ev('deploy.failed'))!.key).toMatch(/^deploy\.failed-/);
    expect(incidentActionFor({ ...ev('alert.fired'), entity: null })!.key).toMatch(/^alert\.fired-/);
    for (const action of ['alert.recovered', 'alert.monitor_up', 'deploy.success', 'deploy.trigger', 'service.create', 'user.login']) {
      expect(incidentActionFor(ev(action))).toBeNull();
    }
  });

  it('parses a bare key or JSON with a region', () => {
    expect(parsePagerDutyTarget(' R0UTING ')).toEqual({ routingKey: 'R0UTING', region: 'us' });
    expect(parsePagerDutyTarget('{"routingKey":"k","region":"eu"}')).toEqual({ routingKey: 'k', region: 'eu' });
    expect(parseOpsgenieTarget('{"apiKey":"g","region":"us"}')).toEqual({ apiKey: 'g', region: 'us' });
    expect(parseOpsgenieTarget('{"apiKey":"g"}')).toEqual({ apiKey: 'g', region: 'us' });
    expect(() => parsePagerDutyTarget('  ')).toThrow(/expected a key/);
    expect(() => parsePagerDutyTarget('{bad')).toThrow(/or JSON with routingKey/);
    expect(() => parseOpsgenieTarget('{"apiKey":"g","region":"ap"}')).toThrow(/region of us or eu/);
    expect(() => parseOpsgenieTarget('{"region":"eu"}')).toThrow(/expected apiKey/);
    expect(() => parseOpsgenieTarget('{"apiKey":5}')).toThrow(/expected apiKey/);
  });
});

describe('PagerDuty', () => {
  it('triggers with a dedup key and resolves with the same key', async () => {
    await dispatchChannel('pagerduty', 'RK', ev('alert.monitor_down', { monitorId: 9 }, 'api #9: timeout'), '🔔 monitor down');
    expect(sent().url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(body()).toEqual({
      routing_key: 'RK',
      event_action: 'trigger',
      dedup_key: 'ninedeploy-monitor-9',
      payload: {
        summary: '🔔 monitor down',
        source: 'NineDeploy',
        severity: 'critical',
        component: 'api #9: timeout',
        group: 'alert',
        class: 'alert.monitor_down',
        timestamp: '2026-10-27T10:00:00.000Z',
      },
    });
    await dispatchChannel('pagerduty', '{"routingKey":"RK","region":"eu"}', ev('alert.monitor_up', { monitorId: 9 }), 'up');
    expect(sent(1).url).toBe('https://events.eu.pagerduty.com/v2/enqueue');
    expect(body(1)).toEqual({ routing_key: 'RK', event_action: 'resolve', dedup_key: 'ninedeploy-monitor-9' });
  });

  it('sends nothing for an event that is no problem, and reports a refusal', async () => {
    await dispatchChannel('pagerduty', 'RK', ev('deploy.trigger'), 'x');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(err(400, '{"message":"Invalid routing key"}'));
    await expect(dispatchChannel('pagerduty', 'RK', ev('deploy.failed', { serviceId: 1 }), 'x')).rejects.toThrow('PagerDuty 400: {"message":"Invalid routing key"}');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => { throw new Error('reset'); } });
    await expect(dispatchChannel('pagerduty', 'RK', ev('deploy.failed', { serviceId: 1 }), 'x')).rejects.toThrow(/^PagerDuty 503$/);
  });

  it('opens and closes a test incident', async () => {
    await dispatchChannel('pagerduty', 'RK', ev('notification.test'), 'test');
    expect(body(0)).toMatchObject({ event_action: 'trigger', dedup_key: 'ninedeploy-test-2026-10-27T10:00:00.000Z' });
    expect(body(1)).toEqual({ routing_key: 'RK', event_action: 'resolve', dedup_key: 'ninedeploy-test-2026-10-27T10:00:00.000Z' });
  });
});

describe('Opsgenie', () => {
  it('creates an alert with an alias and closes it by that alias', async () => {
    await dispatchChannel('opsgenie', 'GK', ev('deploy.failed', { serviceId: 3 }, 'web'), '🚀 deploy failed: web');
    expect(sent().url).toBe('https://api.opsgenie.com/v2/alerts');
    expect(sent().init.headers['Authorization']).toBe('GenieKey GK');
    expect(body()).toEqual({
      message: '🚀 deploy failed: web',
      alias: 'ninedeploy-deploy-3',
      description: '🚀 deploy failed: web',
      source: 'NineDeploy',
      priority: 'P2',
      tags: ['ninedeploy', 'deploy.failed'],
      entity: 'web',
    });
    await dispatchChannel('opsgenie', '{"apiKey":"GK","region":"eu"}', ev('deploy.success', { serviceId: 3 }), 'fixed');
    expect(sent(1).url).toBe('https://api.eu.opsgenie.com/v2/alerts/ninedeploy-deploy-3/close?identifierType=alias');
    expect(body(1)).toEqual({ source: 'NineDeploy', note: 'fixed' });
    fetchMock.mockResolvedValueOnce(err(422, '{"message":"Request body is not processable"}'));
    await expect(dispatchChannel('opsgenie', 'GK', { ...ev('backup.missed'), entity: null }, 'x')).rejects.toThrow('Opsgenie 422');
  });
});

describe('notifyEvent with an incident channel', () => {
  function makeDb(channels: unknown[]) {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const db = {
      query: { notificationChannels: { findMany: async () => channels }, services: { findFirst: async () => null } },
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert,
    };
    return { db: db as never, values };
  }

  it('skips events that neither report nor fix a problem, without a log row', async () => {
    const channel = { id: 1, name: 'pd', type: 'pagerduty', targetEncrypted: encrypt('RK'), eventFilter: '', active: true, configJson: null };
    const { db, values } = makeDb([channel]);
    await notifyEvent(db, ev('deploy.trigger', { serviceId: 2 }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
    await notifyEvent(db, ev('deploy.failed', { serviceId: 2 }));
    expect(body()).toMatchObject({ event_action: 'trigger', dedup_key: 'ninedeploy-deploy-2' });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ channelId: 1, event: 'deploy.failed', status: 'sent' }));
  });
});
