import { existsSync, readFileSync } from 'node:fs';
import { test as base, type Browser, type BrowserContext } from '@playwright/test';

/**
 * The panel keeps its session in sessionStorage (apps/web/src/lib/api.ts), on
 * purpose, and Playwright's storageState does not save sessionStorage. The
 * setup journey writes it to SESSION_FILE; this fixture puts it back before the
 * first page script runs. It only fills keys that are missing, so a token the
 * page refreshed later is never replaced by the older saved one.
 */
export const SESSION_FILE = '.auth/session.json';

/**
 * A3: the panel layout a project runs in. The projects set it the way
 * Settings → Appearance does (apps/web/src/lib/layout.ts), before the first
 * page script, so every journey sees it from its first page.
 */
export type PanelLayout = 'classic' | 'compact';

type Project = { baseURL?: string; viewport?: { width: number; height: number } | null };

/** Puts the saved operator session back in a browser context, before its first page script. */
async function restoreSession(context: BrowserContext): Promise<void> {
  if (!existsSync(SESSION_FILE)) throw new Error(`${SESSION_FILE} is missing: the setup journey must run first`);
  const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Record<string, string>;
  await context.addInitScript((entries: Record<string, string>) => {
    for (const [k, v] of Object.entries(entries)) {
      if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
    }
  }, saved);
}

/**
 * Puts a browser context in `layout` before its first page script, as
 * Settings → Appearance would have stored it. N10: compact is what a browser
 * gets until it chooses, so a classic project has to store Classic itself.
 */
export async function setContextLayout(context: BrowserContext, layout: PanelLayout): Promise<void> {
  await context.addInitScript((value) => {
    if (localStorage.getItem('ninedeploy_layout') === null) localStorage.setItem('ninedeploy_layout', value);
  }, layout);
}

export const test = base.extend<{ layout: PanelLayout }>({
  layout: ['classic', { option: true }],
  page: async ({ page, layout }, use) => {
    await restoreSession(page.context());
    await setContextLayout(page.context(), layout);
    await use(page);
  },
});

/** A name a journey creates, unique per layout so the compact run can repeat it on the same panel. */
export const perLayout = (layout: PanelLayout, name: string): string => (layout === 'classic' ? name : `${name}-${layout}`);

/** The image service 02-first-deploy deploys for the operator; the later journeys work on it. */
export const webService = (layout: PanelLayout): string => perLayout(layout, 'e2e-web');

/** The workspace member 07-member creates, one per layout. phone.spec.ts signs the same account in. */
export const MEMBER_PASSWORD = 'E2e-Member-0123!';
export const memberEmail = (layout: PanelLayout): string => `${perLayout(layout, 'member')}@e2e.example`;

/**
 * A browser context made from the raw `browser` gets none of the project's
 * options, so the viewport is applied here, and so is the project's layout: a
 * journey that forgot them would walk the classic panel inside the compact
 * project.
 */
async function newContext(browser: Browser, project: Project): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: project.baseURL,
    ...(project.viewport ? { viewport: project.viewport } : {}),
  });
  return context;
}

/**
 * N10: a browser of their own for another signed-in user (the workspace
 * member). It starts with no session: the journey signs the user in.
 */
export async function anotherSession(browser: Browser, project: Project, layout: PanelLayout): Promise<BrowserContext> {
  const context = await newContext(browser, project);
  await setContextLayout(context, layout);
  return context;
}

/**
 * N10: the operator's session in a browser that stores no layout, as a first
 * visit would not, for the journey that checks what such a browser gets.
 */
export async function operatorSessionWithoutLayout(browser: Browser, project: Project): Promise<BrowserContext> {
  const context = await newContext(browser, project);
  await restoreSession(context);
  return context;
}

export { expect } from '@playwright/test';
