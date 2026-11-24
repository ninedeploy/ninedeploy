import { anotherSession, expect, MEMBER_PASSWORD, memberEmail, test, webService } from './fixtures';
import { assertNoHorizontalOverflow, record, serviceByName, sidebar, tabStrip, watch } from './support';

/**
 * Phone width: every page the desktop journeys visit, plus the main lists,
 * must fit the screen and load without errors.
 */
const ROUTES = ['/', '/services', '/deploys', '/databases', '/domains', '/backups', '/hub', '/settings?section=appearance', '/settings?section=security', '/about'];

for (const route of ROUTES) {
  test(`phone: ${route} fits the screen and loads cleanly`, async ({ page }) => {
    const w = watch(page);
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await assertNoHorizontalOverflow(page, route);
    w.assertClean();
  });
}

test('phone: the services list opens the service the desktop journey deployed', async ({ page, layout }) => {
  const w = watch(page);
  await page.goto('/services');
  await page.getByText(webService(layout), { exact: true }).first().click();
  await expect(page).toHaveURL(/\/services\/\d+/);
  await assertNoHorizontalOverflow(page, 'service page');
  w.assertClean();
});

test('phone: switching layouts in Appearance survives reload', async ({ page, layout }) => {
  const w = watch(page);
  await page.goto('/settings?section=appearance');
  const classic = page.getByRole('button', { name: 'Classic', exact: true });
  const compact = page.getByRole('button', { name: 'Compact', exact: true });
  const initial = layout === 'classic' ? classic : compact;
  const other = layout === 'classic' ? compact : classic;
  await expect(initial).toHaveAttribute('aria-pressed', 'true');
  await other.click();
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await initial.click();
  await expect(initial).toHaveAttribute('aria-pressed', 'true');
  await assertNoHorizontalOverflow(page, 'Appearance after switching layouts');
  w.assertClean();
});

/**
 * N10: the phone navigation itself. On a phone the sidebar panel is a drawer
 * that starts closed on every page; a group icon on the activity rail opens
 * it. These journeys walk the operator tasks' pages the way a person does on
 * a phone, in whichever layout this project runs.
 */
test('phone: a group icon opens the drawer, which reaches the pages the operator tasks start from and closes behind', async ({ page, layout }, testInfo) => {
  test.setTimeout(300_000);
  const w = watch(page);
  const nav = sidebar(page);
  // One page load; each link then moves the panel inside the page.
  await page.goto('/');
  const walked: string[] = [];
  for (const [group, item, route] of [
    ['Deploy', 'Services', /\/services$/],
    ['Data', 'Databases', /\/databases$/],
    ['Data', 'Backups', /\/backups$/],
    ['System', 'Users', /\/users$/],
    ['Organize', 'Workspaces', /\/workspaces$/],
  ] as const) {
    // Closed on every page: the page has the whole width until an icon is tapped.
    await expect(nav.panel).toHaveCount(0);
    await nav.group(group).click();
    await expect(nav.item(item)).toBeVisible();
    await nav.item(item).click();
    await expect(page).toHaveURL(route);
    await expect(nav.panel).toHaveCount(0);
    await assertNoHorizontalOverflow(page, `${route} reached through the drawer`);
    walked.push(`${group} → ${item}`);
  }
  await record(testInfo, `n10-phone-drawer-${layout}`, { layout, walked, requests: w.requests });
  w.assertClean();
});

test('phone: a service\'s tabs switch from the strip, including one kept under More, and the page stays on the screen', async ({ page, layout }, testInfo) => {
  test.setTimeout(300_000);
  const w = watch(page);
  // On the panel before the first API read: support.ts reads the session from the page.
  await page.goto('/');
  const service = await serviceByName(page, webService(layout));
  const base = `/services/${service.id}`;
  const strip = tabStrip(page);
  const tabs = strip.getByRole('tab');
  const facts: Record<string, unknown> = { layout };

  await page.goto(base);
  await expect(tabs.first()).toBeVisible();
  await assertNoHorizontalOverflow(page, 'service page');
  facts.tabsUpFront = (await tabs.allTextContents()).map((text) => text.trim());
  const more = strip.getByRole('button', { name: 'More', exact: true });
  if (layout === 'compact') {
    // The six tabs do not fit a phone, and More is what reaches the other eight, so it sits
    // beside the scrolling tabs and is on screen before anything is scrolled.
    facts.moreOnScreenWithoutScrolling = await more.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= document.documentElement.clientWidth;
    });
    expect(facts.moreOnScreenWithoutScrolling).toBe(true);
    await expect(more).toBeInViewport();
    // The first tab is on screen beside it, and the strip still scrolls.
    await expect(tabs.first()).toBeInViewport();
    facts.stripScrolls = await tabs.first().evaluate((el) => {
      const scroller = el.parentElement!;
      return scroller.scrollWidth > scroller.clientWidth;
    });
    expect(facts.stripScrolls).toBe(true);
  }

  // Environment: one of the tabs both layouts show up front.
  await strip.getByRole('tab', { name: 'Environment', exact: true }).click();
  await expect(page).toHaveURL(/tab=environment/);
  await expect(page.getByPlaceholder('KEY', { exact: true })).toBeVisible();
  await assertNoHorizontalOverflow(page, 'Environment tab');
  // The tab selected is brought on screen by the page itself.
  await expect(strip.locator('[role="tab"][aria-selected="true"]')).toBeInViewport();

  // Volumes & Storage: under More in compact, in the strip in classic.
  if (layout === 'compact') {
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(strip.locator('#service-more-tabs')).toBeVisible();
  }
  await strip.getByRole('tab', { name: 'Volumes & Storage', exact: true }).click();
  await expect(page).toHaveURL(/tab=volumes/);
  await expect(strip.locator('[role="tab"][aria-selected="true"]')).toHaveText('Volumes & Storage');
  await assertNoHorizontalOverflow(page, 'Volumes & Storage tab');

  await record(testInfo, `n10-phone-tabs-${layout}`, facts);
  w.assertClean();
});

test('phone: a direct link to a service tab selects it and brings it on screen', async ({ page, layout }) => {
  test.setTimeout(300_000);
  const w = watch(page);
  await page.goto('/');
  const service = await serviceByName(page, webService(layout));
  for (const key of ['environment', 'settings', 'terminal', 'volumes', 'deploys']) {
    await page.goto(`/services/${service.id}?tab=${key}`);
    const selected = tabStrip(page).locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toBeInViewport();
    if (layout === 'compact') {
      const underMore = key === 'terminal' || key === 'volumes';
      await expect(tabStrip(page).getByRole('button', { name: 'More', exact: true })).toHaveAttribute('aria-expanded', String(underMore));
    }
    await assertNoHorizontalOverflow(page, `direct link ?tab=${key}`);
  }
  w.assertClean();
});

test('phone: the workspace member signs in and reaches a workspace service through the rail', async ({ page, browser, layout }) => {
  test.setTimeout(300_000);
  await page.goto('/');
  const service = await serviceByName(page, webService(layout));
  const ctx = await anotherSession(browser, { baseURL: test.info().project.use.baseURL, viewport: { width: 412, height: 915 } }, layout);
  const member = await ctx.newPage();
  const mw = watch(member, [{ status: 401, path: /^\/v1\/auth\/(me|refresh)$/ }, { status: 403, path: /^\/v1\/users$/ }]);
  await member.goto('/login');
  await member.getByPlaceholder('you@example.com').fill(memberEmail(layout));
  await member.getByPlaceholder('••••••••').fill(MEMBER_PASSWORD);
  await member.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(member).not.toHaveURL(/\/login/);
  await assertNoHorizontalOverflow(member, 'member dashboard');

  // The drawer, then the service the operator deployed for this layout.
  const nav = sidebar(member);
  await member.goto('/');
  await nav.group('Deploy').click();
  await nav.item('Services').click();
  await expect(member).toHaveURL(/\/services$/);
  await member.getByText(webService(layout), { exact: true }).first().click();
  await expect(member).toHaveURL(new RegExp(`/services/${service.id}$`));
  await assertNoHorizontalOverflow(member, 'member service page');
  await expect(tabStrip(member).getByRole('tab', { name: 'Deploys', exact: true })).toBeVisible();

  // An operator page is refused with one plain sentence, and still fits the screen.
  await member.goto('/users');
  await expect(member.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await expect(member.getByText('operators only.', { exact: false })).toBeVisible();
  await assertNoHorizontalOverflow(member, 'member on /users');
  mw.assertClean();
  await ctx.close();
});
