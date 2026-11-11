import type { Page } from '@playwright/test';
import { expect, perLayout, test } from './fixtures';
import { apiGet, watch } from './support';

type Deploy = { id: number; status: string };
type EnvVar = { key: string; value?: string };

async function serviceId(page: Page, name: string): Promise<number> {
  const list = await apiGet<Array<{ id: number; name: string }> | { items: Array<{ id: number; name: string }> }>(page, '/v1/services');
  const svc = (Array.isArray(list) ? list : list.items).find((s) => s.name === name);
  expect(svc, `service ${name}`).toBeTruthy();
  return svc!.id;
}

async function deploys(page: Page, id: number): Promise<Deploy[]> {
  const list = await apiGet<Deploy[] | { items: Deploy[] }>(page, `/v1/services/${id}/deploys`);
  return Array.isArray(list) ? list : list.items;
}

/** Waits until the newest deploy is past `after` and finished; returns it. */
async function nextFinishedDeploy(page: Page, id: number, after: number): Promise<Deploy> {
  let newest: Deploy | undefined;
  await expect
    .poll(async () => {
      newest = (await deploys(page, id))[0];
      return newest && newest.id > after && /^(running|failed|cancelled)$/.test(newest.status);
    }, { timeout: 300_000, intervals: [2_000, 5_000] })
    .toBe(true);
  return newest!;
}

test('environment and rollback: a variable added in the panel, a redeploy, then a rollback to the first release', async ({ page, layout }) => {
  test.setTimeout(600_000);
  const w = watch(page);
  await page.goto('/');
  const id = await serviceId(page, 'e2e-web');
  // The release running now: the first one in the classic run; in the compact
  // run, which repeats this journey, the classic run's rollback.
  const first = (await deploys(page, id)).find((d) => d.status === 'running')!;
  expect(first, 'a running release to roll back to').toBeTruthy();

  // Environment tab: add GREETING=hello-e2e (GREETING_COMPACT in the compact run, which repeats this on the same service).
  const key = perLayout(layout, 'GREETING').toUpperCase().replace(/-/g, '_');
  await page.goto(`/services/${id}?tab=environment`);
  await page.getByPlaceholder('KEY', { exact: true }).fill(key);
  await page.getByPlaceholder('value', { exact: true }).fill('hello-e2e');
  await page.getByPlaceholder('KEY', { exact: true }).press('Enter');
  await expect(page.getByText(key, { exact: true })).toBeVisible();
  const env = await apiGet<EnvVar[]>(page, `/v1/services/${id}/env`);
  expect(env.find((v) => v.key === key)?.value).toBe('hello-e2e');

  // Redeploy from the service header; the new release comes up running.
  const before = (await deploys(page, id))[0]!.id;
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
