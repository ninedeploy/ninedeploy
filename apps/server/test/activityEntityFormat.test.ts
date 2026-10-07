/**
 * D3 / F836 + F837 — the audit-entity cross-surface contract.
 *
 * One string, three consumers:
 *   • kernel/auditBridge decodes `<free-form name> #<id>` (LAST `#<n>`) into
 *     serviceId (service.stop/start/restart) or deploymentId (deploy.*) for
 *     plugins and the webhook-out receiver;
 *   • modules/activity.ts filters the trail — the web per-service Activity tab
 *     by `?entity=<name>&serviceId=<id>`, the global page / MCP by `?entity=`;
 *   • lib/notifier routes per-service rules on `meta.serviceId`.
 *
 * Before D3 the lifecycle routes and the manual-deploy route audited the BARE
 * name: plugins got no id, and a service named "api #4" handed them id 4.
 * Fixing the producers alone would have hidden those rows from the Activity
 * tab (exact `entity = name` match) with every test still green — so the
 * producer side, the bridge, the activity filter (legacy AND new rows, on a
 * real migrated SQLite) and the notifier scope are pinned together here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditLog, createDb, type DB } from '@ninedeploy/db';
import { eventBus, type AppEvent } from '../src/lib/events.js';
import { mapAuditToDomainEvent } from '../src/kernel/auditBridge.js';
import { scopeMatchesAction } from '../src/lib/notifier.js';
import { activityRoutes } from '../src/modules/activity.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import { servicesRoutes } from '../src/modules/services.js';
import { asUser, buildTestApp, createFakeDb, depRow, svcRow } from './helpers.js';

vi.mock('../src/lib/exec.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async () => ''),
  run: vi.fn(async () => {
    throw new Error('exec.run must not be reached');
  }),
}));
vi.mock('pm2', () => ({
  default: new Proxy(
    {},
    {
      get: (_t, p) => {
        if (typeof p === 'symbol' || p === 'then') return undefined;
        throw new Error(`pm2.${String(p)} must not be reached`);
      },
    },
  ),
}));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: () => {
    throw new Error('spawn must not be reached');
  },
}));

type AuditRow = { action: string; entity?: string | null; meta?: Record<string, unknown> | null };

/** Resolves once the real lib/events bus carries `action` — audit() publishes after its insert. */
function nextAudit(action: string): Promise<AppEvent> {
  return new Promise((resolve) => {
    const off = eventBus.subscribe((e) => {
      if (e.action === action) {
        off();
        resolve(e);
      }
    });
  });
}

const auditInsert = (rows: AuditRow[]) => (v: unknown) => {
  rows.push(v as AuditRow);
  return [v as AuditRow];
};

async function lifecycleRow(id: number, name: string, verb: 'stop' | 'start' | 'restart'): Promise<AuditRow> {
  const rows: AuditRow[] = [];
  const app = await buildTestApp({
    db: createFakeDb({
      findFirst: { services: svcRow({ id, name, runtimeId: `c${id}`, type: 'docker', serverId: null }) },
      insert: { audit_log: auditInsert(rows) },
    }),
  });
  await app.register(servicesRoutes);
  const audited = nextAudit(`service.${verb}`);
  const res = await app.inject({ method: 'POST', url: `/${id}/${verb}`, headers: asUser() });
  expect(res.statusCode).toBe(200);
  await audited;
  return rows.find((r) => r.action === `service.${verb}`)!;
}

async function triggerRow(serviceId: number, name: string, deploymentId: number): Promise<AuditRow> {
  const rows: AuditRow[] = [];
  const app = await buildTestApp({
    db: createFakeDb({
      findFirst: { services: svcRow({ id: serviceId, name }), deployments: undefined },
      findMany: { deployments: [] },
      insert: { deployments: [depRow({ id: deploymentId, serviceId, status: 'queued' })], audit_log: auditInsert(rows) },
    }),
  });
  await app.register(deploysRoutes, { prefix: '/services' });
  const audited = nextAudit('deploy.trigger');
  const res = await app.inject({ method: 'POST', url: `/services/${serviceId}/deploys`, headers: asUser() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ deploymentId });
  await audited;
  return rows.find((r) => r.action === 'deploy.trigger')!;
}

const bridged = (r: AuditRow) =>
  mapAuditToDomainEvent({ id: 0, action: r.action, entity: r.entity ?? null, ts: '2026-01-01T00:00:00.000Z', actorUserId: 1 })?.payload;

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
let cleanup: () => void = () => undefined;
afterEach(() => cleanup());

async function activityStore(rows: AuditRow[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-activity-entity-'));
  const created = createDb({ url: `file:${path.join(dir, 'a.db').split(path.sep).join('/')}` });
  cleanup = () => {
    created.client?.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file lock */
    }
  };
  await migrate(created.db, { migrationsFolder: MIGRATIONS });
  const db = created.db as DB;
  for (const r of rows) await db.insert(auditLog).values({ userId: null, action: r.action, entity: r.entity ?? null, meta: r.meta ?? undefined });
  const app = await buildTestApp({ db });
  await app.register(activityRoutes);
  return async (qs: string) => {
    const res = await app.inject({ method: 'GET', url: `/?${qs}`, headers: asUser() });
    expect(res.statusCode).toBe(200);
    return (res.json().entries as Array<{ action: string; entity: string }>).map((e) => `${e.action}@${e.entity}`).sort();
  };
}

describe('audit entity format — producers + bridge (F836/F837)', () => {
  it('service lifecycle audits `<name> #<id>` + meta.serviceId; a "#<n>" in the name is not the id', async () => {
    for (const verb of ['stop', 'start', 'restart'] as const) {
      for (const name of ['api', 'api #4']) {
        const row = await lifecycleRow(7, name, verb);
        expect(row).toMatchObject({ entity: `${name} #7`, meta: { serviceId: 7 } });
        expect(bridged(row)).toEqual({ status: verb, serviceId: 7 });
      }
    }
  });

  it('deploy.trigger audits `<name> #<deploymentId>`; "api #4" no longer spoofs deployment 4', async () => {
    for (const name of ['api', 'api #4']) {
      const row = await triggerRow(7, name, 99);
      expect(row).toMatchObject({ entity: `${name} #99`, meta: { serviceId: 7, deploymentId: 99 } });
      expect(bridged(row)).toEqual({ status: 'trigger', serviceName: name, deploymentId: 99 });
    }
  });
});

describe('audit entity format — Activity filters keep legacy rows (D3)', () => {
  it('the per-service tab lists legacy bare-name rows and new id-bearing rows, never a sibling named "<name> #<id>"', async () => {
    const list = await activityStore([
      // legacy (pre-D3) rows: bare name, no meta.serviceId
      { action: 'service.stop', entity: 'api' },
      { action: 'deploy.trigger', entity: 'api', meta: { ip: '10.0.0.1' } },
      { action: 'service.update', entity: 'api' },
      { action: 'service.update', entity: 'api #7' }, // a sibling (id 9) NAMED "api #7"
      // new rows, exactly as the real routes write them
      await lifecycleRow(7, 'api', 'restart'),
      await triggerRow(7, 'api', 99),
      await lifecycleRow(9, 'api #7', 'stop'),
      // engine/pipeline.ts outcome shape
      { action: 'deploy.success', entity: 'api #99', meta: { serviceId: 7 } },
    ]);
    expect(await list('entity=api&serviceId=7')).toEqual([
      'deploy.success@api #99',
      'deploy.trigger@api',
      'deploy.trigger@api #99',
      'service.restart@api #7',
      'service.stop@api',
      'service.update@api',
    ]);
    // the sibling sees its own rows only — not service 7's "api #7" restart
    expect(await list(`entity=${encodeURIComponent('api #7')}&serviceId=9`)).toEqual(['service.stop@api #7 #9', 'service.update@api #7']);
  });

  it('a plain ?entity= matches the bare name and `<name> #<one numeric id>`, for any name characters', async () => {
    const list = await activityStore([
      { action: 'service.stop', entity: 'api' },
      { action: 'service.stop', entity: 'api #7' },
      { action: 'service.stop', entity: 'api #7 #9' },
      { action: 'service.stop', entity: 'api #x' },
      { action: 'service.stop', entity: 'api #' },
      { action: 'service.stop', entity: 'api2 #7' },
      { action: 'service.stop', entity: 'ğü😀 #3' },
      { action: 'service.stop', entity: 'a%_*[ #5' },
      { action: 'service.stop', entity: 'aXY* #5' },
    ]);
    expect(await list('entity=api')).toEqual(['service.stop@api', 'service.stop@api #7']);
    expect(await list(`entity=${encodeURIComponent('ğü😀')}`)).toEqual(['service.stop@ğü😀 #3']);
    expect(await list(`entity=${encodeURIComponent('a%_*[')}`)).toEqual(['service.stop@a%_*[ #5']);
  });
});

describe('audit entity format — notifier scope (D3)', () => {
  it('per-service `deploy` rules cover outcomes, not the trigger that now carries meta.serviceId', () => {
    expect(scopeMatchesAction('deploy', 'deploy.success')).toBe(true);
    expect(scopeMatchesAction('deploy', 'deploy.failed')).toBe(true);
    expect(scopeMatchesAction('deploy', 'deploy.trigger')).toBe(false);
    for (const verb of ['stop', 'start', 'restart']) {
      for (const scope of ['deploy', 'failure', 'alert'] as const) expect(scopeMatchesAction(scope, `service.${verb}`)).toBe(false);
    }
  });
});
