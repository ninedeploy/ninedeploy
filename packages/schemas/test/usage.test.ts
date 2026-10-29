import { describe, expect, it } from 'vitest';
import { usageCostsInput, usageQuery } from '../src/usage.js';

describe('usage contracts (ROADMAP item 9)', () => {
  it('a window of 1 to 90 days, 30 by default, read from a query string', () => {
    expect(usageQuery.parse({})).toEqual({ days: 30 });
    expect(usageQuery.parse({ days: '7' })).toEqual({ days: 7 });
    for (const days of ['0', '91', '1.5', 'x']) expect(usageQuery.safeParse({ days }).success).toBe(false);
  });
  it('server costs: a currency code, each server once, the panel host as null', () => {
    expect(usageCostsInput.parse({})).toEqual({ currency: 'USD', servers: [] });
    const costs = { currency: 'EUR', servers: [{ serverId: null, monthlyCost: 20 }, { serverId: 3, monthlyCost: 4.5 }] };
    expect(usageCostsInput.parse(costs)).toEqual(costs);
    expect(usageCostsInput.safeParse({ currency: 'eur' }).success).toBe(false);
    expect(usageCostsInput.safeParse({ servers: [{ serverId: 3, monthlyCost: 1 }, { serverId: 3, monthlyCost: 2 }] }).success).toBe(false);
    expect(usageCostsInput.safeParse({ servers: [{ serverId: 0, monthlyCost: 1 }] }).success).toBe(false);
    expect(usageCostsInput.safeParse({ servers: [{ serverId: null, monthlyCost: -1 }] }).success).toBe(false);
  });
});
