import { describe, expect, it } from 'vitest';
import { openFirstRunWarning } from '../src/lib/openFirstRun.js';

describe('openFirstRunWarning', () => {
  it('has nothing to say about a template that is closed by default', () => {
    expect(openFirstRunWarning(undefined)).toBeNull();
    expect(openFirstRunWarning({})).toBeNull();
    expect(openFirstRunWarning({ dockerSocket: true })).toBeNull();
  });

  it('names each way an app can be open before it is set up', () => {
    expect(openFirstRunWarning({ openFirstRun: 'first-visitor-admin' })).toMatch(/becomes its administrator or runs its installer/);
    expect(openFirstRunWarning({ openFirstRun: 'default-login' })).toMatch(/publicly known login/);
    expect(openFirstRunWarning({ openFirstRun: 'open-signup' })).toMatch(/anyone create an account/);
    expect(openFirstRunWarning({ openFirstRun: 'no-auth' })).toMatch(/no login of its own: anyone/);
  });

  it('says so when the open app also reaches the host Docker', () => {
    expect(openFirstRunWarning({ openFirstRun: 'first-visitor-admin', dockerSocket: true })).toMatch(/controls Docker on this server/);
    expect(openFirstRunWarning({ openFirstRun: 'no-auth', dockerSocket: true })).toMatch(/sees every container/);
  });
});
