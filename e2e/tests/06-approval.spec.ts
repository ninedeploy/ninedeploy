import type { Page } from '@playwright/test';
import { expect, perLayout, test } from './fixtures';
import { apiGet, watch } from './support';

type Deploy = { id: number; status: string };

async function deploys(page: Page, id: number): Promise<Deploy[]> {
  const list = await apiGet<Deploy[] | { items: Deploy[] }>(page, `/v1/services/${id}/deploys`);
  return Array.isArray(list) ? list : list.items;
}

/**
 * Protected lanes (0.16.13): a lane that requires approval holds every deploy
 * an admin did not start from the panel. A deploy hook always waits, since
 * whoever holds the URL is not necessarily an admin.
 */
test('approval: a deploy-hook deploy into a lane that requires approval waits, and the admin approves it', async ({ page, layout }) => {
  test.setTimeout(600_000);
  // The compact run repeats this journey on the same panel under its own names.
  const lane = perLayout(layout, 'production');
  const serviceName = perLayout(layout, 'e2e-gated');
  const w = watch(page);

  // Services → Lanes: a "production" lane that requires approval.
  await page.goto('/services');
  await page.getByRole('button', { name: 'Manage deployment lanes' }).click();
  await page.getByPlaceholder('New lane name (e.g. staging)').fill(lane);
  await page.getByRole('button', { name: /Create lane/ }).click();
  const approval = page.getByRole('switch', { name: `Require approval for ${lane}` });
  await approval.click();
  await expect(approval).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // A service deployed into that lane by the admin, from the wizard, runs at once.
  await page.goto('/services?deploy=image');
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('my-app').fill(serviceName);
  await dialog.getByPlaceholder('n8nio/n8n').fill('nginx:1.27-alpine');
  await dialog.getByRole('button', { name: /Continue/ }).click();
  await dialog.getByPlaceholder('3000', { exact: true }).fill('80');
  await dialog.getByRole('combobox', { name: 'Environment' }).selectOption({ label: lane });
  const deployButton = dialog.getByRole('button', { name: /^Deploy$/ });
  for (let i = 0; i < 5 && !(await deployButton.isVisible()); i++) await dialog.getByRole('button', { name: /Continue/ }).click();
  await deployButton.click();
  await page.waitForURL(/\/services\/\d+/, { timeout: 60_000 });
  const id = Number(/\/services\/(\d+)/.exec(page.url())![1]);
  await expect.poll(async () => (await deploys(page, id))[0]?.status, { timeout: 300_000, intervals: [2_000, 5_000] }).toBe('running');
  const firstId = (await deploys(page, id))[0]!.id;

  // Settings → Deploy hook on; calling the URL queues a deploy that waits.
  await page.goto(`/services/${id}?tab=settings`);
  await page.getByRole('switch', { name: 'Deploy hook' }).click();
  await expect(page.getByRole('button', { name: 'Copy curl command' })).toBeVisible();
  const hook = await apiGet<{ enabled: boolean; url: string | null }>(page, `/v1/services/${id}/deploy-hook`);
  expect(hook.url).toBeTruthy();
  const called = await page.request.post(hook.url!);
  expect(called.status(), await called.text()).toBeLessThan(300);
  await expect.poll(async () => (await deploys(page, id))[0], { timeout: 30_000 }).toMatchObject({ status: 'awaiting_approval' });
  const waiting = (await deploys(page, id))[0]!;
  expect(waiting.id).toBeGreaterThan(firstId);

  // Deploys tab: the approval card; approving builds it as usual.
  await page.goto(`/services/${id}?tab=deploys`);
  await page.getByRole('button', { name: /Approve/ }).click();
  await expect
    .poll(async () => (await deploys(page, id)).find((d) => d.id === waiting.id)?.status, { timeout: 300_000, intervals: [2_000, 5_000] })
    .toBe('running');
  w.assertClean();
});
