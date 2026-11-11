import { expect, test } from './fixtures';
import { apiGet, watch } from './support';

/**
 * A3: what only the compact layout has, on a real panel. Runs in the
 * desktop-compact project, after 04 and 06 ran there, so e2e-web is deployed
 * and running. The classic project ignores this file.
 */
test('compact layout: six service tabs with More, runtime logs on the Logs tab, folded settings and the shorter sidebar', async ({ page, layout }) => {
  expect(layout, 'this journey belongs to the desktop-compact project').toBe('compact');
  const w = watch(page);
  await page.goto('/');
  const list = await apiGet<Array<{ id: number; name: string }> | { items: Array<{ id: number; name: string }> }>(page, '/v1/services');
  const id = (Array.isArray(list) ? list : list.items).find((s) => s.name === 'e2e-web')!.id;

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
