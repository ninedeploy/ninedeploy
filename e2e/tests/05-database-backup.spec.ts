import { execFileSync } from 'node:child_process';
import { expect, perLayout, test } from './fixtures';
import { apiList, watch } from './support';

type Db = { id: number; name: string; engine: string; status: string; containerName: string };
type Backup = { id: number; status: string; sizeBytes: number };

function query(db: Db, statement: string): string {
  const daemon = process.env.ND_E2E_DIND;
  if (!daemon || !/^nd-e2e-dind-[a-f0-9]{8}$/.test(daemon) || !/^nd-db-[a-z0-9-]+$/.test(db.containerName)) {
    throw new Error('The restore proof needs the disposable database started by smoke-browser-e2e.mjs');
  }
  return execFileSync('docker', ['exec', daemon, 'docker', '-H', 'tcp://127.0.0.1:2375', 'exec',
    db.containerName, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'nine', '-d', 'app', '-c', statement],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
}

test('database backup and restore: the browser restores a protected row from a PostgreSQL snapshot', async ({ page, layout }) => {
  test.setTimeout(600_000);
  const w = watch(page);
  // N10: the compact run repeats this journey on the same panel, so the
  // database is named instead of taking the quick button's `postgres-db`.
  const name = perLayout(layout, 'e2e-restore');
  await page.goto('/databases');
  await page.getByRole('button', { name: /New database/ }).click();
  await page.getByRole('button', { name: /PostgreSQL/ }).first().click();
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByPlaceholder('my-database').fill(name);
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.getByRole('button', { name: 'Create database', exact: true }).click();

  // The managed postgres image is pulled inside dind on a cold runner.
  let db: Db | undefined;
  await expect
    .poll(async () => {
      db = (await apiList<Db>(page, '/v1/databases')).find((d) => d.name === name);
      return db?.status;
    }, { timeout: 360_000, intervals: [3_000, 5_000] })
    .toBe('running');

  const database = db!;
  // The API can mark the container running while PostgreSQL is still
  // initializing. Wait for an actual query before seeding the snapshot.
  await expect.poll(() => {
    try { return query(database, 'SELECT 1'); } catch { return null; }
  }, { timeout: 60_000 }).toBe('1');
  query(database, "CREATE TABLE browser_restore (value text NOT NULL); INSERT INTO browser_restore VALUES ('in-snapshot')");
  await page.goto(`/databases/${database.id}`);
  await page.getByRole('button', { name: /Backup now/ }).click();
  let latest: Backup | undefined;
  await expect
    .poll(async () => {
      latest = (await apiList<Backup>(page, `/v1/databases/${database.id}/backups`))[0];
      return latest?.status;
    }, { timeout: 180_000, intervals: [2_000, 5_000] })
    .toMatch(/^(completed|failed)$/);
  expect(latest!.status, `backup #${latest!.id}`).toBe('completed');
  expect(latest!.sizeBytes).toBeGreaterThan(0);

  const values = 'SELECT value FROM browser_restore ORDER BY value';
  query(database, "INSERT INTO browser_restore VALUES ('after-snapshot')");
  expect(query(database, values)).toBe('after-snapshot\nin-snapshot');
  await page.goto('/backups');
  // Exact name: the compact run's "e2e-restore-compact" also contains "e2e-restore".
  await page.getByRole('row').filter({ has: page.getByText(database.name, { exact: true }) }).getByTitle('Restore', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore backup' });
  await expect(dialog).toContainText('Current data will be overwritten.');
  const restored = page.waitForResponse(response =>
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/v1/databases/${database.id}/backups/${latest!.id}/restore`, { timeout: 180_000 });
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  expect((await restored).status()).toBe(200);
  await expect(page.getByText(/Restore started.*snapshot data/)).toBeVisible();
  expect(query(database, values)).toBe('in-snapshot');
  w.assertClean();
});
