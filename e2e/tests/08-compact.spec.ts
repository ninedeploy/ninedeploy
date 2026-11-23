import { expect, operatorSessionWithoutLayout, test, webService } from './fixtures';
import { apiList, record, serviceByName, tabStrip, watch } from './support';

/**
 * A3: what only the compact layout has, on a real panel. Runs in the
 * desktop-compact project, after that project's own first deploy, so the
 * compact run's service is deployed and running. The classic project ignores
 * this file.
 */
test('compact layout: six service tabs with More, runtime logs on the Logs tab, folded settings and the shorter sidebar', async ({ page, layout }) => {
  expect(layout, 'this journey belongs to the desktop-compact project').toBe('compact');
  const w = watch(page);
  await page.goto('/');
  const id = (await apiList<{ id: number; name: string }>(page, '/v1/services')).find((s) => s.name === webService(layout))!.id;

  // Six tabs up front; the rest under More.
  await page.goto(`/services/${id}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('tab')).toHaveText(['Overview', 'Deploys', 'Environment', 'Domains', 'Logs', 'Settings']);
  const more = main.getByRole('button', { name: 'More' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  // Logs: the running container's output, with the activity log under it.
  await main.getByRole('tab', { name: 'Logs' }).click();
  await expect(page).toHaveURL(/tab=activity/);
  await expect(page.locator('#service-tab-panel').getByText('Runtime logs', { exact: true })).toBeVisible();

  // A deep link to a More tab opens the group with that tab selected.
  await page.goto(`/services/${id}?tab=terminal`);
  await expect(main.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
  await expect(main.getByRole('tab', { name: 'Terminal & Exec' })).toHaveAttribute('aria-selected', 'true');

  // Settings: the deploy hook stays out; the rest opens from More settings.
  await page.goto(`/services/${id}?tab=settings`);
  await expect(main.getByRole('switch', { name: 'Deploy hook' })).toBeVisible();
  const fold = main.getByRole('button', { name: /More settings/ });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');

  // Sidebar: Hub is reached through New, which stays lit on the Hub.
  await page.goto('/hub');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Hub', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'New', exact: true })).toHaveAttribute('href', '/new');
  await expect(nav.getByRole('link', { name: 'Queue', exact: true })).toBeVisible();
  w.assertClean();
});

/**
 * N10: the comparison of the two layouts is done, and compact is the layout a
 * browser gets until it chooses one (apps/web/src/lib/layout.ts). Someone who
 * picks Classic keeps it. These browser contexts store no layout, as a first
 * visit would not.
 */
test('N10 default layout: a browser that never chose opens in compact, and choosing Classic is kept', async ({ browser }, testInfo) => {
  const ctx = await operatorSessionWithoutLayout(browser, testInfo.project.use);
  const page = await ctx.newPage();
  const w = watch(page);
  const stored = () => page.evaluate(() => localStorage.getItem('ninedeploy_layout'));

  // Nothing stored: compact, and the page says so in Appearance.
  await page.goto('/');
  const base = `/services/${(await serviceByName(page, webService('compact'))).id}`;
  await page.goto(base);
  await expect(tabStrip(page).getByRole('tab')).toHaveCount(6);
  await expect(tabStrip(page).getByRole('button', { name: 'More', exact: true })).toBeVisible();
  expect(await stored(), 'a browser that never chose stores nothing').toBeNull();
  await page.goto('/settings?section=appearance');
  await expect(page.getByRole('button', { name: 'Compact', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Choosing Classic is kept: stored, and still Classic after a reload.
  await page.getByRole('button', { name: 'Classic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Classic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await stored()).toBe('classic');
  await page.goto(base);
  await expect(tabStrip(page).getByRole('tab')).toHaveCount(14);
  await expect(tabStrip(page).getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(tabStrip(page).getByRole('tab')).toHaveCount(14);

  // Another browser that never chose gets compact again.
  const fresh = await operatorSessionWithoutLayout(browser, testInfo.project.use);
  const second = await fresh.newPage();
  const fw = watch(second);
  await second.goto(base);
  await expect(tabStrip(second).getByRole('tab')).toHaveCount(6);

  await record(testInfo, 'n10-default-compact', { default: 'compact', storedAfterChoosingClassic: 'classic', requests: w.requests });
  w.assertClean();
  fw.assertClean();
  await ctx.close();
  await fresh.close();
});
