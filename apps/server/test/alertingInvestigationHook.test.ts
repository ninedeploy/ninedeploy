/**
 * ROADMAP item 6 wiring: a service rule that fires hands its value to the
 * investigation; a host-wide rule never does. (lib/alertInvestigation.ts has
 * its own tests; this proves the evaluator calls it.)
 */
import { expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

const inv = vi.hoisted(() => ({ investigateFiredAlert: vi.fn(async (..._a: unknown[]) => 'done') }));
vi.mock('../src/lib/alertInvestigation.js', () => inv);
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { evaluateAlerts } = await import('../src/lib/alerting.js');

function fakeDb(rules: Array<Record<string, unknown>>) {
  const state = { ruleId: 0, status: 'ok', breachSince: null, firedAt: null, lastNotifiedAt: null, lastValue: null };
  return {
    select: () => ({
      from: (table: unknown) => {
        const name = String((table as { [k: symbol]: unknown })[Symbol.for('drizzle:Name')] ?? '');
        const rows = name === 'alert_state' ? [] : rules;
        return {
          // biome-ignore lint/suspicious/noThenProperty: the fake query result must be awaitable.
          then: (ok: (v: unknown) => unknown) => Promise.resolve(rows).then(ok),
          where: () => Promise.resolve(name === 'alert_state' ? [state] : rows),
        };
      },
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as unknown as DB;
}

const base = { operator: '>', threshold: 5, durationWindows: 1, enabled: true };

it('a firing service rule is investigated; a host-wide one is not', async () => {
  const svcRule = { id: 1, serviceId: 5, name: 'api errors', metric: 'error_rate', ...base };
  await evaluateAlerts(fakeDb([svcRule]), [{ serviceId: 5, kind: 'error_rate', value: 12, detail: '6 of 50' }]);
  await vi.waitFor(() => expect(inv.investigateFiredAlert).toHaveBeenCalledTimes(1));
  expect(inv.investigateFiredAlert).toHaveBeenCalledWith(expect.anything(), svcRule, 12, '6 of 50');

  inv.investigateFiredAlert.mockClear();
  inv.investigateFiredAlert.mockRejectedValueOnce(new Error('provider down'));
  await evaluateAlerts(fakeDb([{ id: 2, serviceId: null, name: 'disk', metric: 'disk', ...base }]), [{ serviceId: null, kind: 'disk', value: 90 }]);
  await new Promise((r) => setTimeout(r, 20));
  expect(inv.investigateFiredAlert).not.toHaveBeenCalled();
});

it('a failing investigation never reaches the evaluator', async () => {
  inv.investigateFiredAlert.mockRejectedValueOnce(new Error('provider down'));
  const svcRule = { id: 3, serviceId: 5, name: 'slow', metric: 'latency_p95', ...base };
  await expect(evaluateAlerts(fakeDb([svcRule]), [{ serviceId: 5, kind: 'latency_p95', value: 2000 }])).resolves.toBeUndefined();
  await vi.waitFor(() => expect(inv.investigateFiredAlert).toHaveBeenCalled());
});
