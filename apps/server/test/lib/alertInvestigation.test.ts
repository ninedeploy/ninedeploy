/**
 * ROADMAP 0.16.8 item 6: an opt-in AI investigation when a service's alert
 * fires, against a real migrated SQLite with the provider's HTTP call stubbed —
 * the switch, the protected-lane skip, the hourly cap, what is sent (sanitized
 * logs with the alert as context), where the answer is kept, and the cleanup
 * of answers whose rule is gone.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertRules, createDb, environments, services, settings, users, workspaces, type DB } from '@ninedeploy/db';

const logs = vi.hoisted(() => ({ readRuntimeLogs: vi.fn(async (..._a: unknown[]) => '') }));
vi.mock('../../src/lib/runtimeLogs.js', () => logs);
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('../../src/lib/audit.js', () => auditMock);

const I = await import('../../src/lib/alertInvestigation.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { getSettingJson, setSettingJson, setSettingString } = await import('../../src/lib/settings.js');

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));
const NOW = Date.parse('2026-10-29T12:00:00Z');

let db: DB;
let close: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

const rule = (over: Partial<{ id: number; serviceId: number | null; name: string }> = {}) => ({
  id: 1,
  serviceId: 5,
  name: 'api errors',
  metric: 'error_rate',
  operator: '>',
  threshold: 5,
  ...over,
});

beforeEach(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-alert-inv-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values({ id: 1, email: 'op@x.test', passwordHash: 'h', isInstanceOperator: true });
  await db.insert(workspaces).values({ id: 1, name: 'Team', slug: 'team', ownerId: 1 });
  await db.insert(environments).values([
    { id: 1, workspaceId: 1, name: 'staging', slug: 'staging' },
    { id: 2, workspaceId: 1, name: 'production', slug: 'production', protected: true },
  ]);
  await db.insert(services).values([
    { id: 5, name: 'api', slug: 'api', type: 'docker', ownerUserId: 1, runtimeId: 'api-1', environmentId: 1 },
    { id: 6, name: 'idle', slug: 'idle', type: 'docker', ownerUserId: 1 },
    { id: 7, name: 'prod', slug: 'prod', type: 'docker', ownerUserId: 1, runtimeId: 'prod-1', environmentId: 2 },
  ] as never);
  await db.insert(alertRules).values([
    { id: 1, serviceId: 5, name: 'api errors', metric: 'cpu', threshold: 5 },
    { id: 2, serviceId: 7, name: 'prod errors', metric: 'cpu', threshold: 5 },
  ] as never);
  await setSettingJson(db, 'ai_diagnosis_config', { provider: 'anthropic', model: 'claude-sonnet-5-5', alertInvestigation: true });
  await setSettingString(db, 'ai_diagnosis_key_encrypted', encrypt(['sk', 'ant', 'test', 'key'].join('-')));
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Health: failing. The database refuses connections.' }] }) });
  vi.stubGlobal('fetch', fetchMock);
  logs.readRuntimeLogs.mockReset();
  logs.readRuntimeLogs.mockResolvedValue('GET /health 200\nError: ECONNREFUSED db:5432\nDB_PASSWORD=hunter2\n');
  auditMock.audit.mockClear();
  I.resetAlertInvestigationCap();
});
afterEach(() => {
  vi.unstubAllGlobals();
  close();
});

describe('investigateFiredAlert', () => {
  it('sends the sanitized log tail with the alert as context, and keeps the answer next to the rule', async () => {
    expect(await I.investigateFiredAlert(db, rule(), 12, '6 of 50 requests answered 5xx', NOW)).toBe('done');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { system: string; messages: Array<{ content: string }> };
    const sent = body.messages.map((m) => m.content).join('\n');
    expect(sent).toContain('The alert "api errors" just fired: error_rate = 12 (threshold > 5), 6 of 50 requests answered 5xx.');
    expect(sent).toContain('ECONNREFUSED db:5432');
    expect(sent).not.toContain('hunter2');
    expect(logs.readRuntimeLogs).toHaveBeenCalledWith(db, expect.objectContaining({ id: 5 }), I.ALERT_INVESTIGATION_TAIL);

    expect(await getSettingJson(db, 'alert_investigation:1', null)).toEqual({
      at: '2026-10-29T12:00:00.000Z',
      model: 'claude-sonnet-5-5',
      value: 12,
      analysis: 'Health: failing. The database refuses connections.',
    });
    expect([...(await I.loadAlertInvestigations(db)).keys()]).toEqual([1]);
    // Audited without any of the answer: notifications never carry log lines.
    expect(auditMock.audit).toHaveBeenCalledWith(db, null, 'ai.alert_investigation', 'api errors (service=api)', { ruleId: 1, serviceId: 5 });
  });

  it('does nothing while switched off or unconfigured, for a host-wide or vanished target, a protected lane, or a stopped service', async () => {
    expect(await I.investigateFiredAlert(db, rule({ serviceId: null }), 1, undefined, NOW)).toBe('gone');
    expect(await I.investigateFiredAlert(db, rule({ serviceId: 99 }), 1, undefined, NOW)).toBe('gone');
    expect(await I.investigateFiredAlert(db, rule({ id: 2, serviceId: 7 }), 1, undefined, NOW)).toBe('protected');
    expect(await I.investigateFiredAlert(db, rule({ serviceId: 6 }), 1, undefined, NOW)).toBe('not_running');
    logs.readRuntimeLogs.mockResolvedValueOnce('  \n');
    expect(await I.investigateFiredAlert(db, rule(), 1, undefined, NOW)).toBe('no_logs');
    logs.readRuntimeLogs.mockRejectedValueOnce(new Error('docker down'));
    expect(await I.investigateFiredAlert(db, rule(), 1, undefined, NOW)).toBe('no_logs');

    await db.delete(settings).where(eq(settings.key, 'ai_diagnosis_key_encrypted'));
    expect(await I.investigateFiredAlert(db, rule(), 1, undefined, NOW)).toBe('unconfigured');
    await setSettingJson(db, 'ai_diagnosis_config', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(await I.investigateFiredAlert(db, rule(), 1, undefined, NOW)).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps investigations per hour across the instance', async () => {
    for (let i = 0; i < I.ALERT_INVESTIGATIONS_PER_HOUR; i++) {
      expect(await I.investigateFiredAlert(db, rule(), i, undefined, NOW + i * 1000)).toBe('done');
    }
    expect(await I.investigateFiredAlert(db, rule(), 99, undefined, NOW + 60_000)).toBe('capped');
    // An hour after the first one, a slot is free again.
    expect(await I.investigateFiredAlert(db, rule(), 100, undefined, NOW + 60 * 60 * 1000)).toBe('done');
  });

  it('drops answers whose rule is gone, and ignores unreadable rows', async () => {
    await setSettingJson(db, 'alert_investigation:42', { at: 'x', model: 'm', value: 1, analysis: 'old' });
    await db.insert(settings).values({ key: 'alert_investigation:43', value: 'not json' as never });
    await db.insert(settings).values({ key: 'alert_investigation:44', value: '{"at":"y","model":"m","value":2,"analysis":"a"}' as never });
    expect([...(await I.loadAlertInvestigations(db)).keys()].sort()).toEqual([42, 44]);
    await I.pruneAlertInvestigations(db);
    expect([...(await I.loadAlertInvestigations(db)).keys()]).toEqual([]);
  });
});
