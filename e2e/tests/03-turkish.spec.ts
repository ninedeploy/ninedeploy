import { expect, test } from './fixtures';
import { watch } from './support';

test('Turkish: switching the language under Settings → Appearance translates the panel', async ({ page }) => {
  const w = watch(page);
  await page.goto('/settings?section=appearance');
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'Türkçe' }).click();
  // The switch translates its own label too: "Language" becomes "Dil".
  await expect(page.getByRole('group', { name: 'Dil' }).getByRole('button', { name: 'Türkçe' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');

  // The navigation and a page heading follow, and the choice survives a reload.
  await page.goto('/services');
  await expect(page.getByRole('link', { name: 'Servisler' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Servisler' }).first()).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('Tüm sistemler çalışıyor')).toBeVisible();
  w.assertClean();
});
