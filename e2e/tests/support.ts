import { expect, type Page } from '@playwright/test';

/**
 * Watches a page for the failures a journey must never leave behind: console
 * errors, and 4xx/5xx answers from the panel API. Call `assertClean()` at the
 * end of a test. `allow` names API answers that a step expects (for example a
 * 401 probe before sign-in).
 */
export function watch(page: Page, allow: Array<{ status: number; path: RegExp }> = []) {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text().slice(0, 300)}`);
  });
  page.on('pageerror', (err) => problems.push(`page error: ${err.message.slice(0, 300)}`));
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (!url.pathname.startsWith('/v1/') || res.status() < 400) return;
    if (allow.some((a) => a.status === res.status() && a.path.test(url.pathname))) return;
    problems.push(`api: ${res.request().method()} ${url.pathname} -> ${res.status()}`);
  });
  return {
    problems,
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
