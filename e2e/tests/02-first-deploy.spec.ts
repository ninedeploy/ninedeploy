import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, perLayout, test, webService } from './fixtures';
import { deploysOf, watch, type Deploy } from './support';

// N10: the compact project repeats these journeys on the same panel, so
// everything they create is named per layout.
test('first deploy: an image through the deploy wizard comes up running', async ({ page, layout }) => {
  test.setTimeout(420_000);
  const w = watch(page);
  // The dashboard's "Start deploy" opens the same wizard; ?deploy=image picks the image source.
  await page.goto('/?deploy=image');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder('my-app').fill(webService(layout));
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
  await expect(page.getByText(webService(layout), { exact: true }).first()).toBeVisible();

  // The image is pulled inside dind on a cold runner: allow a few minutes.
  let last: Deploy | undefined;
  await expect
    .poll(
      async () => {
        last = (await deploysOf(page, id))[0];
        return last?.status;
      },
      { timeout: 360_000, intervals: [2_000, 5_000] },
    )
    .toMatch(/^(running|failed|cancelled)$/);
  expect(last?.status, `deploy #${last?.id}`).toBe('running');
  w.assertClean();
});

test('first source deploy: a build failure shows its cause and a corrected upload goes live', async ({ page, layout }, testInfo) => {
  test.setTimeout(420_000);
  const w = watch(page);
  const source = testInfo.outputPath('source');
  mkdirSync(source, { recursive: true });
  const archive = (instruction: string, name: string) => {
    writeFileSync(join(source, 'Dockerfile'), `FROM nginx:1.27-alpine\nRUN ${instruction}\n`);
    return {
      name,
      mimeType: 'application/gzip',
      buffer: execFileSync('tar', ['-czf', '-', '-C', source, '.'], { timeout: 10_000, windowsHide: true }),
    };
  };

  await page.goto('/new');
  await page.getByRole('button', { name: 'Upload source', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload source' });
  await dialog.getByPlaceholder('my-app').fill(perLayout(layout, 'e2e-first-upload'));
  await dialog.getByPlaceholder('3000').fill('80');
  await dialog.getByLabel('Archive').setInputFiles(archive('echo N09_EXPECTED_BUILD_FAILURE && exit 37', 'broken.tar.gz'));
  await dialog.getByRole('button', { name: 'Create and deploy' }).click();
  await page.waitForURL(url => /^\/services\/\d+$/.test(url.pathname), { timeout: 60_000 });
  const url = new URL(page.url());
  expect(url.searchParams.get('tab')).toBe('deploys');
  const id = Number(url.pathname.split('/').at(-1));
  const deployments = () => deploysOf(page, id);
  const poll = { timeout: 150_000, intervals: [1_000, 2_000, 5_000] };
  await expect.poll(async () => (await deployments())[0]?.status, poll).toBe('failed');
  const failedId = (await deployments())[0]!.id;
  const failure = page.getByRole('status').filter({ hasText: 'Build failed' });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText(/exited with code|exit code/);
  await failure.getByRole('button', { name: 'Jump to failed step' }).click();
  await expect(page.locator('pre').filter({ hasText: 'N09_EXPECTED_BUILD_FAILURE' })).toBeInViewport();

  await page.getByLabel('Upload new version').setInputFiles(archive('printf n09-recovered > /usr/share/nginx/html/index.html', 'fixed.tar.gz'));
  await expect.poll(async () => {
    const latest = (await deployments())[0];
    return latest?.id !== failedId && latest?.status;
  }, poll).toBe('running');
  await expect(page.getByText('All traffic is now served by the new release.')).toBeVisible();
  await expect(failure).toHaveCount(0);
  expect(await deployments()).toContainEqual(expect.objectContaining({ id: failedId, status: 'failed' }));
  w.assertClean();
});
