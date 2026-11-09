import { existsSync, readFileSync } from 'node:fs';
import { test as base } from '@playwright/test';

/**
 * The panel keeps its session in sessionStorage (apps/web/src/lib/api.ts), on
 * purpose, and Playwright's storageState does not save sessionStorage. The
 * setup journey writes it to SESSION_FILE; this fixture puts it back before the
 * first page script runs. It only fills keys that are missing, so a token the
 * page refreshed later is never replaced by the older saved one.
 */
export const SESSION_FILE = '.auth/session.json';

export const test = base.extend({
  page: async ({ page }, use) => {
    if (!existsSync(SESSION_FILE)) throw new Error(`${SESSION_FILE} is missing: the setup journey must run first`);
    const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Record<string, string>;
    await page.addInitScript((entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) {
        if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
      }
    }, saved);
    await use(page);
  },
});

export { expect } from '@playwright/test';
