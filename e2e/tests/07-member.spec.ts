import { expect, test } from './fixtures';
import { watch } from './support';

const MEMBER = { email: 'member@e2e.example', password: 'E2e-Member-0123!' };

test('member access: the owner creates an account and adds it to the workspace; the member signs in, sees its services, and is not an operator', async ({ page, browser }) => {
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

  // The workspace's services are visible to the member…
  await member.goto('/services');
  await expect(member.getByText('e2e-web').first()).toBeVisible();
  // …but operator-only routes are refused for them.
  const token = await member.evaluate(() => sessionStorage.getItem('ninedeploy.token'));
  const users = await member.request.get('/v1/users', { headers: { authorization: `Bearer ${token}` } });
  expect(users.status()).toBe(403);
  mw.assertClean();
  await ctx.close();
});
