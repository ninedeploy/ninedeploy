import { describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';
import { evaluateAlerts, ensureAlertState, resetAlertState, type MetricSnapshot } from '../src/lib/alerting.js';

interface Rule {
  id: number;
  serviceId: number | null;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  durationWindows: number;
  enabled: number | boolean;
}

interface State {
  ruleId: number;
  status: string;
  breachSince: Date | null;
  firedAt: Date | null;
  lastNotifiedAt: Date | null;
  lastValue: number | null;
}

/**
 * Minimal stateful fake DB: rules/states live in arrays, alert-state UPDATEs
 * are applied to the first state row (each test drives a single rule), and
 * audit-log inserts are captured so alert notifications can be asserted.
 */
function makeDb(rules: Rule[], states: State[]) {
  const auditInserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const name = String((table as { [k: symbol]: unknown })[Symbol.for('drizzle:Name')] ?? '');
        const rows = name === 'alert_state' ? states : rules;
        const result: {
          then: (ok: (v: unknown) => unknown, rej?: (e: Error) => unknown) => unknown;
          where: () => Promise<typeof rows>;
        } = {
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable — the fake alert query result must be awaitable by the code under test.
          then: (ok, rej) => Promise.resolve(rows).then(ok as never, rej as never),
          where: () => Promise.resolve(rows),
        };
        return result;
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          updates.push(patch);
          const target = states[0];
          if (target) Object.assign(target, patch);
          return [];
        },
      }),
    }),
    delete: () => ({ where: async () => [] }),
    insert: () => ({
      values: async (v: unknown) => {
        auditInserts.push(v as Record<string, unknown>);
        return [];
      },
    }),
    query: { notificationChannels: { findMany: async () => [] } },
  } as unknown as DB;
  return { db, auditInserts, updates, states };
}

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 1,
  serviceId: null,
  name: 'high-cpu',
  metric: 'cpu',
  operator: '>',
  threshold: 80,
  durationWindows: 2,
  enabled: 1,
  ...over,
});

const T0 = new Date('2026-08-14T10:00:00Z');
const snap = (over: Partial<MetricSnapshot> = {}): MetricSnapshot => ({ serviceId: null, kind: 'cpu', value: 90, ...over });

describe('evaluateAlerts', () => {
  it('does nothing when there are no rules', async () => {
    const { db, updates } = makeDb([], []);
    await evaluateAlerts(db, [snap()]);
    expect(updates).toHaveLength(0);
  });

  it('returns silently when the rules table is missing', async () => {
    const db = {
      select: () => ({ from: async () => { throw new Error('no such table'); } }),
    } as unknown as DB;
    await expect(evaluateAlerts(db, [snap()])).resolves.toBeUndefined();
  });

  it('skips disabled rules and rules without a matching snapshot', async () => {
    const { db, updates } = makeDb([rule({ enabled: 0 }), rule({ id: 2, metric: 'memory' })], []);
    await evaluateAlerts(db, [snap()]);
    expect(updates).toHaveLength(0);
  });

  it('moves ok → breaching on the first breach without notifying', async () => {
    const { db, updates, auditInserts } = makeDb([rule()], []);
    await evaluateAlerts(db, [snap()], T0);
    expect(updates[0]).toMatchObject({ status: 'breaching', lastValue: 90 });
    expect(auditInserts).toHaveLength(0);
  });

  it('fires once the breach is sustained past the duration window', async () => {
    const { db, auditInserts, states } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'breaching', breachSince: new Date(T0.getTime() - 90_000), firedAt: null, lastNotifiedAt: null, lastValue: 85 }],
    );
    await evaluateAlerts(db, [snap()], T0);
    await new Promise((r) => setImmediate(r));
    expect(auditInserts[0]).toMatchObject({ action: 'alert.fired', userId: null });
    // The state row itself was updated with the firing transition.
    expect(states[0]).toMatchObject({ status: 'firing', lastNotifiedAt: T0, lastValue: 90 });
  });

  it('does not re-notify while the cooldown is active', async () => {
    const { db, auditInserts } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'firing', breachSince: new Date(T0.getTime() - 90_000), firedAt: T0, lastNotifiedAt: new Date(T0.getTime() - 60_000), lastValue: 85 }],
    );
    await evaluateAlerts(db, [snap()], T0);
    expect(auditInserts).toHaveLength(0);
  });

  it('re-notifies after the cooldown elapses', async () => {
    const { db, auditInserts } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'firing', breachSince: new Date(T0.getTime() - 3 * 3600_000), firedAt: new Date(T0.getTime() - 3 * 3600_000), lastNotifiedAt: new Date(T0.getTime() - 3 * 3600_000), lastValue: 85 }],
    );
    await evaluateAlerts(db, [snap()], T0);
    await new Promise((r) => setImmediate(r));
    expect(auditInserts[0]).toMatchObject({ action: 'alert.fired' });
  });

  it('keeps updating lastValue while breaching but under the duration window', async () => {
    const { db, updates, auditInserts } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'breaching', breachSince: new Date(T0.getTime() - 10_000), firedAt: null, lastNotifiedAt: null, lastValue: 85 }],
    );
    await evaluateAlerts(db, [snap()], T0);
    // r405: the breach-window write is idempotent — status and breachSince
    // are re-asserted with the values the row already holds.
    expect(updates).toEqual([{ status: 'breaching', breachSince: new Date(T0.getTime() - 10_000), lastValue: 90 }]);
    expect(auditInserts).toHaveLength(0);
  });

  it('r405: durationWindows=1 fires on the FIRST consecutive breaching sample', async () => {
    // The schema comment promises "number of consecutive 30s samples that
    // must breach before firing" — one sample means the first breach fires,
    // not the second (the old off-by-one waited 60 s).
    const { db, auditInserts } = makeDb(
      [rule({ durationWindows: 1 })],
      [{ ruleId: 1, status: 'ok', breachSince: null, firedAt: null, lastNotifiedAt: null, lastValue: 40 }],
    );
    await evaluateAlerts(db, [snap()], T0);
    await new Promise((r) => setImmediate(r));
    expect(auditInserts[0]).toMatchObject({ action: 'alert.fired' });
  });

  it('notifies recovery when a firing alert clears', async () => {
    const { db, auditInserts } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'firing', breachSince: new Date(T0.getTime() - 90_000), firedAt: T0, lastNotifiedAt: T0, lastValue: 90 }],
    );
    await evaluateAlerts(db, [snap({ value: 40 })], T0);
    await new Promise((r) => setImmediate(r));
    expect(auditInserts[0]).toMatchObject({ action: 'alert.recovered' });
  });

  it('clears a breaching (not yet fired) alert without a recovery notification', async () => {
    const { db, auditInserts, updates } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'breaching', breachSince: T0, firedAt: null, lastNotifiedAt: null, lastValue: 85 }],
    );
    await evaluateAlerts(db, [snap({ value: 40 })], T0);
    expect(auditInserts).toHaveLength(0);
    expect(updates[0]).toMatchObject({ status: 'ok', breachSince: null, lastValue: 40 });
  });

  it('only refreshes lastValue when staying ok', async () => {
    const { db, updates } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'ok', breachSince: null, firedAt: null, lastNotifiedAt: null, lastValue: 10 }],
    );
    await evaluateAlerts(db, [snap({ value: 42 })], T0);
    expect(updates).toEqual([{ lastValue: 42 }]);
  });

  it('treats a missing breachSince as starting now', async () => {
    const { db, updates } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'breaching', breachSince: null, firedAt: null, lastNotifiedAt: null, lastValue: 85 }],
    );
    await evaluateAlerts(db, [snap()], T0);
    // elapsed = 0 < required 30s (2 windows) → the breach window is stamped
    // from now (r405 idempotent re-assert).
    expect(updates).toEqual([{ status: 'breaching', breachSince: T0, lastValue: 90 }]);
  });

  it('treats numeric timestamps as epoch milliseconds', async () => {
    const t0ms = T0.getTime();
    const { db, states } = makeDb(
      [rule()],
      [{ ruleId: 1, status: 'breaching', breachSince: t0ms - 90_000, firedAt: t0ms, lastNotifiedAt: t0ms, lastValue: 85 } as unknown as State],
    );
    await evaluateAlerts(db, [snap()], T0);
    // elapsed >= duration; the fresh lastNotified (cooldown) suppresses re-notify.
    expect(states[0]).toMatchObject({ status: 'firing', lastValue: 90 });
  });

  it('honors the < operator and per-service matching', async () => {
    const { db, updates } = makeDb([rule({ serviceId: 7, metric: 'memory', operator: '<', threshold: 100 })], []);
    await evaluateAlerts(db, [snap({ serviceId: 7, kind: 'memory', value: 50 }), snap()], T0);
    expect(updates[0]).toMatchObject({ status: 'breaching', lastValue: 50 });
  });
});

describe('alert state helpers', () => {
  it('ensureAlertState inserts only when absent', async () => {
    let inserted = 0;
    let states: State[] = [{ ruleId: 1, status: 'ok', breachSince: null, firedAt: null, lastNotifiedAt: null, lastValue: null }];
    const db = {
      select: () => ({
        from: () => ({
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable — the fake alert query result must be awaitable by the code under test.
          then: (ok: (v: unknown) => unknown) => Promise.resolve(states).then(ok as never),
          where: () => Promise.resolve(states),
        }),
      }),
      insert: () => ({ values: async () => { inserted++; return []; } }),
    } as unknown as DB;
    await ensureAlertState(db, 1); // state exists → no insert
    expect(inserted).toBe(0);
    states = [];
    await ensureAlertState(db, 2); // no state → insert
    expect(inserted).toBe(1);
  });

  it('resetAlertState deletes by rule', async () => {
    const where = vi.fn(async () => undefined);
    const db = { delete: () => ({ where }) } as unknown as DB;
    await resetAlertState(db, 5);
    expect(where).toHaveBeenCalledOnce();
  });
});
