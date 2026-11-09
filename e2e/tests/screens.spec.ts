import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { sessionToken } from './support';

/**
 * A5: the README screenshots, made from this harness so they show the real
 * panel. Runs only with ND_SCREENSHOTS=<directory> (never in CI):
 *   ND_ADMIN_NAME=Acme ND_SCREENSHOTS=$PWD/docs/images
 *   node scripts/smoke-browser-e2e.mjs --image=<candidate> -- --project=screens
 * The data is deterministic and harmless: example names, no tokens, no IPs.
 */
const OUT = process.env.ND_SCREENSHOTS ?? '';

async function api(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const token = await sessionToken(page);
  const res = await page.request.fetch(path, { method, data, headers: { authorization: `Bearer ${token}` } });
  expect(res.status(), `${method} ${path}: ${(await res.text()).slice(0, 200)}`).toBeLessThan(300);
  return res.json();
}

async function deployImage(page: Page, name: string, image: string, port: number) {
  const created = (await api(page, 'POST', '/v1/services', { name, type: 'docker', image, port })) as { id?: number; service?: { id: number } };
  const id = created.id ?? created.service!.id;
  await api(page, 'POST', `/v1/services/${id}/deploys`, {});
  return id;
}

async function shot(page: Page, file: string) {
  await page.waitForLoadState('networkidle');
  // Let charts and fades settle.
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 82 });
}

test('screenshots for the README', async ({ page }) => {
  test.skip(!OUT, 'ND_SCREENSHOTS is not set');
  test.setTimeout(600_000);
  await page.goto('/');
  const api1 = await deployImage(page, 'storefront-api', 'traefik/whoami:v1.10.3', 80);
  const ids = [api1, await deployImage(page, 'admin-ui', 'nginx:1.27-alpine', 80), await deployImage(page, 'docs-site', 'nginx:1.27-alpine', 80)];
  // Wait until every new service's latest deploy is running.
  type Deploy = { status: string };
  await expect
    .poll(async () => {
      const latest = await Promise.all(ids.map(async (id) => {
        const list = (await api(page, 'GET', `/v1/services/${id}/deploys`)) as Deploy[] | { items: Deploy[] };
        return (Array.isArray(list) ? list : list.items)[0]?.status;
      }));
      return latest.every((s) => s === 'running');
    }, { timeout: 420_000, intervals: [3_000, 5_000] })
    .toBe(true);

  await page.goto('/');
  await shot(page, 'dashboard.jpg');
  await page.goto('/services');
  await shot(page, 'services.jpg');
  await page.goto(`/services/${api1}`);
  await shot(page, 'service.jpg');
  await page.goto(`/services/${api1}?tab=deploys`);
  await shot(page, 'deploys.jpg');
  await page.goto('/hub');
  await shot(page, 'hub.jpg');
  await page.goto('/settings?section=security');
  await shot(page, 'security.jpg');

  // The same dashboard on a phone.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/');
  await shot(page, 'dashboard-phone.jpg');
});
