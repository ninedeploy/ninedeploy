import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB, runMigrations } from '@ninedeploy/db';
import { configuredPanelDomain } from '../../src/lib/panelDomain.js';
import { setSettingString } from '../../src/lib/settings.js';

/**
 * Whether a panel domain is configured, read the way the proxy reads it: the value under
 * Settings → Security first, then NINEDEPLOY_DOMAIN. A blank value is none.
 */
let db: DB;

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url)));
});
afterEach(() => {
  delete process.env['NINEDEPLOY_DOMAIN'];
});

describe('configuredPanelDomain', () => {
  it('is null when nothing is set, and the environment value when only that is', async () => {
    expect(await configuredPanelDomain(db)).toBeNull();
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    expect(await configuredPanelDomain(db)).toBe('panel.example.com');
  });

  it('prefers the value saved under Settings, and treats a blank value as none', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'from-install.example.com';
    await setSettingString(db, 'panel_domain', 'panel.example.com');
    expect(await configuredPanelDomain(db)).toBe('panel.example.com');
    // Clearing the domain under Settings also clears the one the installer wrote: the proxy
    // reads the saved value first and renders no router for it.
    await setSettingString(db, 'panel_domain', '  ');
    expect(await configuredPanelDomain(db)).toBeNull();
    await setSettingString(db, 'panel_domain', 'panel.example.com');
    expect(await configuredPanelDomain(db)).toBe('panel.example.com');
  });

  it('falls back to the environment when the setting cannot be read', async () => {
    process.env['NINEDEPLOY_DOMAIN'] = 'panel.example.com';
    expect(await configuredPanelDomain({} as never)).toBe('panel.example.com');
    delete process.env['NINEDEPLOY_DOMAIN'];
    expect(await configuredPanelDomain({} as never)).toBeNull();
  });
});
