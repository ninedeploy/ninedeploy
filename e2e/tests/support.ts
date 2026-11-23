import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * Watches a page for the failures a journey must never leave behind: console
 * errors, and 4xx/5xx answers from the panel API. Call `assertClean()` at the
 * end of a test. `allow` names API answers that a step expects (for example a
 * 401 probe before sign-in).
 *
 * `requests` counts the responses the page saw: the panel's API answers, and
 * everything else (documents, styles, scripts), including the ones the browser
 * served from its own cache. The panel admits a signed-in user 1,000 API
 * requests a minute, so a journey that loads many pages records its cost with
 * its other facts.
 */
export function watch(page: Page, allow: Array<{ status: number; path: RegExp }> = []) {
  const problems: string[] = [];
  const requests = { api: 0, other: 0 };
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text().slice(0, 300)}`);
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message.slice(0, 300)}`));
  page.on('response', (res) => {
    const url = new URL(res.url());
    const api = url.pathname.startsWith('/v1/');
    if (api) requests.api += 1;
    else requests.other += 1;
    if (!api || res.status() < 400) return;
    if (allow.some((a) => a.status === res.status && a.path.test(url.pathname))) return;
    problems.push(`api: ${res.request().method()} ${url.pathname} -> ${res.status()}`);
  });
  return {
    problems,
    requests,
    assertClean: () => expect(problems, problems.join('\n')).toEqual([]),
  };
}

/** The session token the panel keeps in sessionStorage (lib/api.ts). */
export async function sessionToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => sessionStorage.getItem('ninedeploy.token'));
  expect(token, 'signed in').toBeTruthy();
  return token as string;
}

/** GET a panel API path as the signed-in user. */
export async function apiGet<T>(page: Page, path: string): Promise<T> {
  const token = await sessionToken(page);
  const res = await page.request.get(path, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status(), `GET ${path}`).toBe(200);
  return (await res.json()) as T;
}

/** A list answer: some routes answer with a bare array, others with `{ items }`. */
export type Listed<T> = T[] | { items: T[] };
export const rows = <T>(list: Listed<T>): T[] => (Array.isArray(list) ? list : list.items);

/** GET a panel API list, as an array whichever shape the route answers in. */
export async function apiList<T>(page: Page, path: string): Promise<T[]> {
  return rows(await apiGet<Listed<T>>(page, path));
}

/** The deployments of a service, newest first. A deployment that is no longer live reads `superseded`. */
export type Deploy = { id: number; status: string };
export const deploysOf = (page: Page, id: number): Promise<Deploy[]> => apiList<Deploy>(page, `/v1/services/${id}/deploys`);

export async function serviceByName(page: Page, name: string): Promise<{ id: number; name: string }> {
  const svc = (await apiList<{ id: number; name: string }>(page, '/v1/services')).find((s) => s.name === name);
  expect(svc, `service ${name}`).toBeTruthy();
  return svc!;
}

/**
 * Nothing on the page may be wider than the viewport. The app scrolls an
 * inner <main>, so both the document and <main> are measured.
 */
export async function assertNoHorizontalOverflow(page: Page, label: string) {
  const over = await page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const root = document.scrollingElement;
    if (root && root.scrollWidth > vw + 1) out.push(`document ${root.scrollWidth}px > ${vw}px`);
    const main = document.querySelector('main');
    if (main && main.scrollWidth > main.clientWidth + 1) out.push(`main ${main.scrollWidth}px > ${main.clientWidth}px`);
    return out;
  });
  expect(over, `${label}: horizontal overflow`).toEqual([]);
}

/**
 * N10: the sidebar as a person uses it, in either layout. The activity rail
 * holds one icon per group; a group's panel holds its links. On a desktop
 * width one panel is always open; on a phone the panel is a drawer that
 * starts closed on every page.
 */
export function sidebar(page: Page) {
  // The rail comes first in the document and starts with its own New button.
  const rail = page.getByRole('button', { name: 'New resource', exact: true }).first().locator('..');
  const panel = page.getByRole('button', { name: 'Collapse', exact: true }).locator('..');
  const group = (label: string) => rail.getByRole('button', { name: label, exact: true });
  const item = (label: string) => panel.getByRole('link', { name: label, exact: true });
  // The panel's header names the group it shows.
  const header = (label: string) => panel.getByText(label, { exact: true });

  /**
   * Opens the group's panel. A group icon toggles, so the icon of the group
   * that is already open must not be clicked; and one that is still opening
   * (the page has just changed) would be closed by the click, so that is undone.
   */
  const openGroup = async (label: string): Promise<void> => {
    if (await header(label).isVisible()) return;
    await group(label).click();
    if (await header(label).waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)) return;
    await group(label).click();
    await expect(header(label)).toBeVisible();
  };

  return {
    rail,
    panel,
    group,
    item,
    /** After a page load on a desktop width: the shell is up and a panel is showing. */
    settled: () => expect(panel).toBeVisible(),
    /** The links `groupLabel`'s panel offers, opening the group without leaving the page. */
    async links(groupLabel: string): Promise<string[]> {
      await openGroup(groupLabel);
      return (await panel.getByRole('link').allTextContents()).map((text) => text.trim());
    },
    /**
     * Opens `itemLabel` in `groupLabel` and returns how many clicks it took:
     * one when that group is already showing, two otherwise.
     */
    async open(groupLabel: string, itemLabel: string): Promise<number> {
      const wasShowing = await header(groupLabel).isVisible();
      await openGroup(groupLabel);
      await item(itemLabel).click();
      return wasShowing ? 1 : 2;
    },
  };
}

/** The sidebar groups, by the name of the panel header. */
export const SIDEBAR_GROUPS = ['Deploy', 'Organize', 'Data', 'Network', 'System'] as const;

/** N10: the buttons the activity rail offers and the links each group's panel holds, for whoever is signed in. */
export async function sidebarInventory(page: Page): Promise<{ rail: string[]; groups: Record<string, string[]> }> {
  const nav = sidebar(page);
  const groups: Record<string, string[]> = {};
  for (const label of SIDEBAR_GROUPS) groups[label] = await nav.links(label);
  const rail = (await nav.rail.getByRole('button').allTextContents()).map((text) => text.trim());
  return { rail, groups };
}

/**
 * N10: the service page's tab strip — the <aside> that holds the Overview tab.
 * On a desktop width it is a list; on a phone one row that scrolls sideways,
 * with a second row for the tabs compact keeps under More.
 */
export const tabStrip = (page: Page) => page.locator('aside').filter({ has: page.getByRole('tab', { name: 'Overview', exact: true }) });

/** N10 evidence: one named record per journey, kept in the test's annotations and as an attachment. */
export async function record(testInfo: TestInfo, name: string, data: unknown): Promise<void> {
  const body = JSON.stringify(data, null, 2);
  testInfo.annotations.push({ type: name, description: body });
  await testInfo.attach(`${name}.json`, { body, contentType: 'application/json' });
}

export type Control = { tag: string; role: string; place: string; name: string; inDialog: boolean };

const CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="tab"], [role="link"], [role="switch"], [role="checkbox"], [role="menuitem"], input:not([type="hidden"]), select, textarea';

/**
 * How a control announces itself, evaluated inside the page by `focused()`
 * and `unnamedControls()`. The name is approximated the way a browser computes
 * it: aria-label, aria-labelledby, a <label>, the text content, the title, and
 * for fields only the placeholder. `rendered` is false for anything a person
 * cannot see (a hidden fold, the backdrop of a dialog).
 */
const DESCRIBE_CONTROL = `((el) => {
  const text = (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  if (!el) return { tag: '', role: '', place: '', name: '', rendered: false, inDialog: false };
  let name = (el.getAttribute('aria-label') ?? '').trim();
  if (!name) name = (el.getAttribute('aria-labelledby') ?? '').split(/\\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
  if (!name && el.labels) name = [...el.labels].map(text).join(' ').trim();
  if (!name) name = text(el) || (el.getAttribute('title') ?? '').trim();
  if (!name && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) name = (el.getAttribute('placeholder') ?? '').trim();
  let rendered = !el.closest('[hidden], [aria-hidden="true"]') && el.getClientRects().length > 0;
  for (let node = el; rendered && node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') rendered = false;
  }
  const inDialog = !!el.closest('[role="dialog"]');
  const owner = el.closest('[role="dialog"], nav, aside, header, main');
  const place = owner ? owner.tagName.toLowerCase() + (owner.getAttribute('aria-label') ? ':' + owner.getAttribute('aria-label') : '') : 'page';
  // Enough of the markup to tell one unnamed control from another.
  const hint = el.outerHTML.replace(/\\s+/g, ' ').slice(0, 160);
  return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') ?? '', place, name, rendered, inDialog, hint };
})`;

/** The control that has focus now. */
export function focused(page: Page): Promise<Control> {
  return page.evaluate(`${DESCRIBE_CONTROL}(document.activeElement)`) as Promise<Control>;
}

/**
 * N10: the control Tab reaches first from the top of the page, and puts the
 * focus on it. A page that was moved by clicking keeps its place in the Tab
 * order even after a blur, so Tab from there does not start at the top.
 */
export function focusFirstControl(page: Page): Promise<Control> {
  return page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(CONTROL_SELECTOR)});
    el?.focus?.();
    return ${DESCRIBE_CONTROL}(el);
  })()`) as Promise<Control>;
}

/**
 * N10: the page's own files under /assets/ that this page load fetched over
 * the network. A file whose name carries the build hash is fetched once and
 * then kept by the browser, so a later load in the same browser fetches none.
 */
export const assetsFetchedForThisLoad = (page: Page): Promise<number> => page.evaluate(
  () => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/assets/') && (entry as PerformanceResourceTiming).transferSize > 0).length,
);

/**
 * N10: Tab from wherever focus is until `target` has it. Returns every stop
 * along the way, so a journey can check that each one is named.
 */
export async function tabTo(page: Page, target: (stop: Control) => boolean, limit = 60): Promise<Control[]> {
  const stops: Control[] = [];
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const stop = await focused(page);
    stops.push(stop);
    if (target(stop)) return stops;
  }
  throw new Error(`Tab never reached the target. Stops: ${stops.map((s) => `${s.tag}[${s.role}] "${s.name}"`).join(' > ')}`);
}

/** N10: Tab `times` times and return the stops. */
export async function tabTimes(page: Page, times: number): Promise<Control[]> {
  const stops: Control[] = [];
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Tab');
    stops.push(await focused(page));
  }
  return stops;
}

/** N10: the controls on the page that a person can see but a screen reader cannot name. */
export async function unnamedControls(page: Page): Promise<Array<Omit<Control, 'name'>>> {
  return page.evaluate(`[...document.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)})]
    .map((${DESCRIBE_CONTROL}))
    .filter((control) => control.rendered && !control.name)
    .map(({ name: _name, rendered: _rendered, ...rest }) => rest)`) as Promise<Array<Omit<Control, 'name'>>>;
}
