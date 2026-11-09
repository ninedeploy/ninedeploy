import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { SESSION_FILE } from './fixtures';
import { watch } from './support';

const token = process.env.ND_SETUP_TOKEN ?? '';
// ND_ADMIN_NAME: the README screenshots use a neutral name (it also names the workspace).
export const ADMIN = { name: process.env.ND_ADMIN_NAME ?? 'E2E Admin', email: 'admin@e2e.example', password: 'E2e-Journey-0123!' };

test('setup: the installer link pre-fills the token, and the form creates the first operator', async ({ page }) => {
  expect(token, 'ND_SETUP_TOKEN').not.toBe('');
  // Before setup the form probes the session once; that 401 is expected.
  const w = watch(page, [{ status: 401, path: /^\/v1\/auth\/(me|refresh)$/ }]);
  await page.goto(`/login#setup-token=${token}`);
  await expect(page.getByRole('heading', { name: 'Create admin account' })).toBeVisible();
  // The fragment fills the field and leaves the address bar.
  await expect(page.getByPlaceholder('Printed by the installer')).toHaveValue(token);
  expect(new URL(page.url()).hash).toBe('');

  await page.getByPlaceholder('Admin').fill(ADMIN.name);
  await page.getByPlaceholder('you@example.com').fill(ADMIN.email);
  await page.getByPlaceholder('••••••••').fill(ADMIN.password);
  // A2: never register a real Let's Encrypt account from a test run.
  const acme = page.getByRole('checkbox', { name: /Let's Encrypt/ });
  if (await acme.isVisible()) await acme.uncheck();
  await page.getByRole('button', { name: /Create account/ }).click();

  // Setup lands on the dashboard, with the first-deploy card first.
  await expect(page.getByRole('heading', { name: 'Deploy your first app' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  w.assertClean();

  // The session lives in sessionStorage; the later journeys restore it (fixtures.ts).
  const session = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  expect(Object.keys(session)).toContain('ninedeploy.token');
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(session));
});
