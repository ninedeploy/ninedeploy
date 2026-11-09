import { expect, test } from './fixtures';
import { apiGet, watch } from './support';

type Deploy = { id: number; status: string };

test('first deploy: an image through the deploy wizard comes up running', async ({ page }) => {
  test.setTimeout(420_000);
  const w = watch(page);
  // The dashboard's "Start deploy" opens the same wizard; ?deploy=image picks the image source.
  await page.goto('/?deploy=image');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder('my-app').fill('e2e-web');
  await dialog.getByPlaceholder('n8nio/n8n').fill('nginx:1.27-alpine');
  await dialog.getByRole('button', { name: /Continue/ }).click();
  await dialog.getByPlaceholder('3000', { exact: true }).fill('80');
  // Environment, resources, then the review step's Deploy.
  const deploy = dialog.getByRole('button', { name: /^Deploy$/ });
  for (let i = 0; i < 5 && !(await deploy.isVisible()); i++) {
    await dialog.getByRole('button', { name: /Continue/ }).click();
  }
  await expect(dialog.getByText('nginx:1.27-alpine')).toBeVisible();
  await deploy.click();

  // The wizard hands over to the new service's page.
  await page.waitForURL(/\/services\/\d+/, { timeout: 60_000 });
  const id = Number(/\/services\/(\d+)/.exec(page.url())![1]);
  await expect(page.getByText('e2e-web').first()).toBeVisible();

  // The image is pulled inside dind on a cold runner: allow a few minutes.
  let last: Deploy | undefined;
  await expect
    .poll(
      async () => {
        const list = await apiGet<Deploy[] | { items: Deploy[] }>(page, `/v1/services/${id}/deploys`);
        last = (Array.isArray(list) ? list : list.items)[0];
        return last?.status;
      },
      { timeout: 360_000, intervals: [2_000, 5_000] },
    )
    .toMatch(/^(running|failed|cancelled)$/);
  expect(last?.status, `deploy #${last?.id}`).toBe('running');
  w.assertClean();
});
