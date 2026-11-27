import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { deploysOf, rows, sessionToken, tabStrip } from './support';

/**
 * A5: the README's short recording of a deployment, made from this harness like the
 * screenshots (screens.spec.ts), so it shows the real panel. It runs only with
 * ND_HERO_VIDEO=<directory> (never in CI), with --project=hero:
 *   ND_HERO_VIDEO=$PWD/.temp_files/hero node scripts/smoke-browser-e2e.mjs --image=<candidate> -- --project=hero
 * It writes hero.webm and hero.json (when each step happened, in seconds of the recording);
 * scripts/readme-hero.mjs cuts and converts them to the GIF. The data is deterministic and
 * harmless: example names, no tokens, no addresses.
 */
const OUT = process.env.ND_HERO_VIDEO ?? '';
if (OUT) mkdirSync(OUT, { recursive: true });

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

/** Long enough for a person to see each step; the GIF is cut from this. */
const beat = (page: Page, ms: number) => page.waitForTimeout(ms);

// In a 16:9 frame. Playwright takes the video option at the top level of a file only, so the
// seed is recorded too and that recording is left behind.
test.use({ video: { mode: 'on', size: { width: 1440, height: 810 } } });

const RECORDING = 'a service deployed from the dashboard to running';

// The seed: three services running, as in the screenshots, and the image the recording deploys
// already in the daemon, so that deployment is short.
test('hero: seed', async ({ page }) => {
  test.skip(!OUT, 'ND_HERO_VIDEO is not set');
  test.setTimeout(600_000);
  await page.goto('/');
  const ids = [
    await deployImage(page, 'storefront-api', 'traefik/whoami:v1.10.3', 80),
    await deployImage(page, 'admin-ui', 'nginx:1.27-alpine', 80),
    await deployImage(page, 'docs-site', 'nginx:1.27-alpine', 80),
  ];
  type Deploy = { status: string };
  await expect
    .poll(
      async () => {
        const latest = await Promise.all(ids.map(async (id) => rows<Deploy>(await api(page, 'GET', `/v1/services/${id}/deploys`))[0]));
        return latest.every((deploy) => deploy.status === 'running');
      },
      { timeout: 420_000, intervals: [3_000, 5_000] },
    )
    .toBe(true);
});

test(RECORDING, async ({ page }) => {
  test.skip(!OUT, 'ND_HERO_VIDEO is not set');
  test.setTimeout(300_000);
  const marks: Record<string, number> = {};
  const began = Date.now();
  const mark = (name: string) => {
    marks[name] = Math.round((Date.now() - began) / 100) / 10;
  };

  await page.goto('/');
  await expect(page.getByText('storefront-api').first()).toBeVisible();
  mark('dashboard');
  await beat(page, 1500);

  // The path a person takes: the top bar's New resource, then the picker's Docker image.
  await page.locator('header').first().getByRole('button', { name: 'New resource' }).click();
  await beat(page, 900);
  await page.getByRole('region', { name: 'Applications' }).getByRole('button', { name: 'Docker image' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  mark('wizard');
  await beat(page, 900);

  await dialog.getByPlaceholder('my-app').pressSequentially('blog', { delay: 90 });
  await beat(page, 400);
  await dialog.getByPlaceholder('n8nio/n8n').pressSequentially('nginx:1.27-alpine', { delay: 45 });
  await beat(page, 900);
  await dialog.getByRole('button', { name: /Continue/ }).click();
  await beat(page, 700);
  // The port comes with a default (3000): replace it, then type as a person would.
  const port = dialog.getByPlaceholder('3000', { exact: true });
  await port.fill('');
  await port.pressSequentially('80', { delay: 120 });
  await beat(page, 900);
  // Environment, resources, then the review step's Deploy.
  const deploy = dialog.getByRole('button', { name: /^Deploy$/ });
  for (let i = 0; i < 5 && !(await deploy.isVisible()); i++) {
    await dialog.getByRole('button', { name: /Continue/ }).click();
    await beat(page, 700);
  }
  await beat(page, 900);
  await deploy.click();
  mark('deploy');

  // The wizard hands over to the new service; its deployment's log streams on the Deploys tab.
  await page.waitForURL(/\/services\/\d+/, { timeout: 60_000 });
  const id = Number(/\/services\/(\d+)/.exec(page.url())![1]);
  await tabStrip(page).getByRole('tab', { name: 'Deploys', exact: true }).click();
  await expect(page.getByText('Deployment output', { exact: true })).toBeVisible();
  mark('log');
  let last: { id: number; status: string } | undefined;
  await expect
    .poll(async () => {
      last = (await deploysOf(page, id))[0];
      return last?.status;
    }, { timeout: 240_000, intervals: [1_000] })
    .toMatch(/^(running|failed|cancelled)$/);
  expect(last?.status, `deploy #${last?.id}`).toBe('running');
  mark('running');
  await beat(page, 1500);

  // The service, running.
  await tabStrip(page).getByRole('tab', { name: 'Overview', exact: true }).click();
  await beat(page, 3500);
  mark('end');

  // The recording is a file once its browser context is closed.
  const video = page.video();
  await page.context().close();
  if (OUT && video) {
    copyFileSync(await video.path(), join(OUT, 'hero.webm'));
    writeFileSync(join(OUT, 'hero.json'), `${JSON.stringify(marks, null, 1)}\n`);
  }
});
