import { expect, test } from './fixtures';
import { apiGet, sessionToken, watch } from './support';

const MEMBER = { email: 'member@e2e.example', password: 'E2e-Member-0123!' };

test('a workspace member signs in and deploys an app with member permissions', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const w = watch(page);

  // Users: the owner creates the account (open registration stays off).
  await page.goto('/users');
  await page.getByRole('button', { name: /New user/ }).click();
  await page.getByLabel('New user email').fill(MEMBER.email);
  await page.getByLabel('New user password').fill(MEMBER.password);
  await page.getByRole('button', { name: /Create user/ }).click();
  await expect(page.getByText(MEMBER.email).first()).toBeVisible();

  // Workspaces: inviting an address that already has an account adds it at once.
  await page.goto('/workspaces');
  await page.getByRole('button', { name: /Invite Member/ }).click();
  const modal = page.getByRole('dialog');
  await modal.getByPlaceholder('developer@acme.com').fill(MEMBER.email);
  await modal.getByRole('combobox').selectOption('member');
  await modal.getByRole('button', { name: /Send Invite/ }).click();
  await page.keyboard.press('Escape');
  await page.goto('/workspaces');
  await expect(page.getByText(MEMBER.email).first()).toBeVisible();
  w.assertClean();

  // The member, in a browser of their own, signs in.
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const member = await ctx.newPage();
  const mw = watch(member, [{ status: 401, path: /^\/v1\/auth\/(me|refresh)$/ }, { status: 403, path: /^\/v1\/users$/ }]);
  await member.goto('/login');
  await member.getByPlaceholder('you@example.com').fill(MEMBER.email);
  await member.getByPlaceholder('••••••••').fill(MEMBER.password);
  await member.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(member).not.toHaveURL(/\/login/);
  await expect(member.getByRole('heading', { name: /All systems operational|service.*need.*attention/ })).toBeVisible();
  await expect(member.getByRole('button', { name: /Load Next.js Demo/ })).toHaveCount(0);
  await expect(member.getByText('Getting started', { exact: true })).toHaveCount(0);

  // The workspace's services are visible to the member…
  await member.goto('/services');
  await expect(member.getByText('e2e-web').first()).toBeVisible();
  // …but operator-only routes are refused for them.
  const headers = { authorization: `Bearer ${await sessionToken(member)}` };
  const users = await member.request.get('/v1/users', { headers });
  expect(users.status()).toBe(403);
  const demo = await member.request.post('/v1/demo/seed', { headers });
  expect(demo.status()).toBe(403);

  await member.goto('/new');
  const apps = member.getByRole('region', { name: 'Applications' });
  await expect(apps.getByRole('button', { name: /Docker Compose|PM2 process|GitHub App/ })).toHaveCount(0);
  await apps.getByRole('button', { name: 'Docker image' }).click();
  const wizard = member.getByRole('dialog');
  await wizard.getByPlaceholder('my-app').fill('e2e-member-web');
  await wizard.getByPlaceholder('n8nio/n8n').fill('nginx:1.27-alpine');
  await wizard.getByRole('button', { name: /^Continue$/ }).click();
  await wizard.getByPlaceholder('3000', { exact: true }).fill('80');
  const deploy = wizard.getByRole('button', { name: /^Deploy$/ });
  for (let step = 0; step < 5 && !(await deploy.isVisible()); step++) {
    await wizard.getByRole('button', { name: /^Continue$/ }).click();
  }
  await deploy.click();
  await member.waitForURL(url => /\/services\/\d+$/.test(url.pathname), { timeout: 60_000 });
  const serviceId = new URL(member.url()).pathname.split('/').at(-1);
  await expect(member.getByText('e2e-member-web', { exact: true }).first()).toBeVisible();
  await expect.poll(async () => {
    const rows = await apiGet<Array<{ status: string }>>(member, `/v1/services/${serviceId}/deploys`);
    return rows[0]?.status;
  }, { timeout: 120_000 }).toBe('running');
  mw.assertClean();
  await ctx.close();
});
