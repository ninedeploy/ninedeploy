import { expect, test } from './fixtures';
import { apiGet, watch } from './support';

type Db = { id: number; name: string; engine: string; status: string };
type Backup = { id: number; status: string; sizeBytes: number };

test('database and backup: a PostgreSQL from the wizard comes up, and "Backup now" stores a non-empty backup', async ({ page }) => {
  test.setTimeout(600_000);
  const w = watch(page);
  await page.goto('/databases');
  await page.getByRole('button', { name: /New database/ }).click();
  await page.getByRole('button', { name: /PostgreSQL/ }).first().click();
  await page.getByRole('button', { name: /Create Now/ }).click();

  // The managed postgres image is pulled inside dind on a cold runner.
  let db: Db | undefined;
  await expect
    .poll(async () => {
      const list = await apiGet<Db[] | { items: Db[] }>(page, '/v1/databases');
      db = (Array.isArray(list) ? list : list.items).find((d) => d.engine === 'postgres');
      return db?.status;
    }, { timeout: 360_000, intervals: [3_000, 5_000] })
    .toBe('running');

  await page.goto(`/databases/${db!.id}`);
  await page.getByRole('button', { name: /Backup now/ }).click();
  let latest: Backup | undefined;
  await expect
    .poll(async () => {
      latest = (await apiGet<Backup[]>(page, `/v1/databases/${db!.id}/backups`))[0];
      return latest?.status;
    }, { timeout: 180_000, intervals: [2_000, 5_000] })
    .toMatch(/^(completed|failed)$/);
  expect(latest!.status, `backup #${latest!.id}`).toBe('completed');
  expect(latest!.sizeBytes).toBeGreaterThan(0);
  w.assertClean();
});
