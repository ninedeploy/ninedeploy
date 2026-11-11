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

/**
 * A3: the panel layout a project runs in. The compact projects set it the way
 * Settings → Appearance does (apps/web/src/lib/layout.ts), before the first
 * page script, so every journey sees it from its first page.
 */
export type PanelLayout = 'classic' | 'compact';

export const test = base.extend<{ layout: PanelLayout }>({
  layout: ['classic', { option: true }],
  page: async ({ page, layout }, use) => {
    if (!existsSync(SESSION_FILE)) throw new Error(`${SESSION_FILE} is missing: the setup journey must run first`);
    const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Record<string, string>;
    await page.addInitScript((entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) {
        if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
      }
    }, saved);
    if (layout === 'compact') await page.addInitScript(() => localStorage.setItem('ninedeploy_layout', 'compact'));
    await use(page);
  },
});

/** A name a journey creates, unique per layout so the compact run can repeat it on the same panel. */
export const perLayout = (layout: PanelLayout, name: string): string => (layout === 'classic' ? name : `${name}-${layout}`);

export { expect } from '@playwright/test';
