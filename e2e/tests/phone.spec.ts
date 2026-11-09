import { expect, test } from './fixtures';
import { assertNoHorizontalOverflow, watch } from './support';

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

test('phone: the services list opens the service the desktop journey deployed', async ({ page }) => {
  const w = watch(page);
  await page.goto('/services');
  await page.getByText('e2e-web').first().click();
  await expect(page).toHaveURL(/\/services\/\d+/);
  await assertNoHorizontalOverflow(page, 'service page');
  w.assertClean();
});
