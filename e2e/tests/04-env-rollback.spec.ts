import type { Page } from '@playwright/test';
import { expect, test, webService } from './fixtures';
import { apiGet, deploysOf, serviceByName, watch, type Deploy } from './support';

type EnvVar = { key: string; value?: string };

/** Waits until the newest deploy is past `after` and finished; returns it. */
async function nextFinishedDeploy(page: Page, id: number, after: number): Promise<Deploy> {
  let newest: Deploy | undefined;
  await expect
    .poll(async () => {
      newest = (await deploysOf(page, id))[0];
      return newest && newest.id > after && /^(running|failed|cancelled)$/.test(newest.status);
    }, { timeout: 300_000, intervals: [2_000, 5_000] })
    .toBe(true);
  return newest!;
}

test('environment and rollback: a variable added in the panel, a redeploy, then a rollback to the first release', async ({ page, layout }) => {
  test.setTimeout(600_000);
  const w = watch(page);
  await page.goto('/');
  // N10: each layout works on the service its own first-deploy journey deployed.
  const id = (await serviceByName(page, webService(layout))).id;
  // The release running now: the first one this layout deployed.
  const first = (await deploysOf(page, id)).find((d) => d.status === 'running')!;
  expect(first, 'a running release to roll back to').toBeTruthy();

  // Environment tab: add GREETING=hello-e2e.
  await page.goto(`/services/${id}?tab=environment`);
  await page.getByPlaceholder('KEY', { exact: true }).fill('GREETING');
  await page.getByPlaceholder('value', { exact: true }).fill('hello-e2e');
  await page.getByPlaceholder('KEY', { exact: true }).press('Enter');
  await expect(page.getByText('GREETING', { exact: true })).toBeVisible();
  const env = await apiGet<EnvVar[]>(page, `/v1/services/${id}/env`);
  expect(env.find((v) => v.key === 'GREETING')?.value).toBe('hello-e2e');

  // Redeploy from the service header; the new release comes up running.
  const before = (await deploysOf(page, id))[0]!.id;
  // Scoped to <main>: the navigation rail has a "Deploy" group button too.
  await page.getByRole('main').getByRole('button', { name: /^Deploy$/ }).click();
  // A running service asks first: the new release builds while the old one serves.
  await page.getByRole('button', { name: 'Redeploy', exact: true }).click();
  const second = await nextFinishedDeploy(page, id, before);
  expect(second.status, `deploy #${second.id}`).toBe('running');

  // Deploys tab: roll back to the first release, through the confirmation.
  await page.goto(`/services/${id}?tab=deploys`);
  await page.getByRole('button', { name: `Rollback to deployment #${first.id}` }).click();
  await page.getByRole('button', { name: 'Rollback', exact: true }).click();
  const rolledBack = await nextFinishedDeploy(page, id, second.id);
  expect(rolledBack.status, `rollback deploy #${rolledBack.id}`).toBe('running');
  w.assertClean();
});
