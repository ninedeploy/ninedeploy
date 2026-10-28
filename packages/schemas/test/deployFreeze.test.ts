import { describe, expect, it } from 'vitest';
import { deployFreeze, deployFreezeCreate } from '../src/deployFreeze.js';

describe('deploy freeze contracts', () => {
  it('defaults an instance freeze to no target or expiry and trims the reason', () => {
    expect(deployFreezeCreate.parse({ scope: 'instance', reason: ' maintenance ' })).toEqual({ scope: 'instance', targetId: null, reason: 'maintenance', until: null });
  });
  it('requires a target for a narrower scope and refuses one for the instance', () => {
    for (const scope of ['workspace', 'project', 'environment']) {
      expect(deployFreezeCreate.parse({ scope, targetId: 4, reason: 'hold', until: '2026-10-28T12:00:00+03:00' }).targetId).toBe(4);
      expect(deployFreezeCreate.safeParse({ scope, reason: 'hold' }).success).toBe(false);
    }
    expect(deployFreezeCreate.safeParse({ scope: 'instance', targetId: 4, reason: 'hold' }).success).toBe(false);
    expect(deployFreezeCreate.safeParse({ scope: 'project', targetId: 0, reason: 'hold' }).success).toBe(false);
    expect(deployFreezeCreate.safeParse({ scope: 'instance', reason: '  ' }).success).toBe(false);
    expect(deployFreezeCreate.safeParse({ scope: 'instance', reason: 'hold', until: 'tomorrow' }).success).toBe(false);
  });
  it('allows an existing freeze to have a deleted target or no creator', () => {
    const row = { id: 'id', scope: 'project', targetId: 4, targetName: null, reason: 'hold', until: null, createdAt: 'now', createdBy: null };
    expect(deployFreeze.parse(row)).toEqual(row);
  });
});
