import { anotherSession, expect, MEMBER_PASSWORD, memberEmail, perLayout, test, webService } from './fixtures';
import { apiGet, apiList, record, sessionToken, sidebarInventory, watch } from './support';

type Workspace = { id: number; name: string; myRole: string; members?: Array<{ email: string; role: string }> };
type MemberView = { rail: string[]; groups: Record<string, string[]> };

// N10: these pages are operator-only server-side; a member's sidebar must never offer them.
const OPERATOR_ONLY = ['Users', 'Volumes', 'Activity', 'Doctor', 'Sources', 'Terminals', 'Servers', 'Docker'];

test('a workspace member signs in and deploys an app with member permissions', async ({ page, browser, layout }, testInfo) => {
  test.setTimeout(300_000);
  const email = memberEmail(layout);
  const w = watch(page);

  // Users: the owner creates the account (open registration stays off).
  await page.goto('/users');
  await page.getByRole('button', { name: /New user/ }).click();
  await page.getByLabel('New user email').fill(email);
  await page.getByLabel('New user password').fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: /Create user/ }).click();
  await expect(page.getByText(email).first()).toBeVisible();

  // Workspaces: inviting an address that already has an account adds it at once.
  await page.goto('/workspaces');
  await page.getByRole('button', { name: /Invite Member/ }).click();
  const modal = page.getByRole('dialog');
  await modal.getByPlaceholder('developer@acme.com').fill(email);
  await modal.getByRole('combobox').selectOption('member');
  await modal.getByRole('button', { name: /Send Invite/ }).click();
  await page.keyboard.press('Escape');
  await page.goto('/workspaces');
  await expect(page.getByText(email).first()).toBeVisible();
  w.assertClean();

  // The member, in a browser of their own at this project's width and in its layout, signs in.
  const ctx = await anotherSession(browser, testInfo.project.use, layout);
  const member = await ctx.newPage();
  const mw = watch(member, [{ status: 401, path: /^\/v1\/auth\/(me|refresh)$/ }, { status: 403, path: /^\/v1\/users$/ }]);
  await member.goto('/login');
  await member.getByPlaceholder('you@example.com').fill(email);
  await member.getByPlaceholder('••••••••').fill(MEMBER_PASSWORD);
  await member.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(member).not.toHaveURL(/\/login/);
  await expect(member.getByRole('heading', { name: /All systems operational|service.*need.*attention/ })).toBeVisible();
  await expect(member.getByRole('button', { name: /Load Next.js Demo/ })).toHaveCount(0);
  await expect(member.getByText('Getting started', { exact: true })).toHaveCount(0);

  // N10: the seat is real, and the member can see the team they joined. In the
  // member's own session the workspace names them a member and lists their
  // account with that role.
  await member.goto('/workspaces');
  await expect(member.getByRole('heading', { name: 'Team Members' })).toBeVisible();
  // The row shows the address twice: as the account's name and as its address.
  await expect(member.getByText(email, { exact: true }).first()).toBeVisible();
  await member.waitForLoadState('networkidle');
  const seat = (await apiList<Workspace>(member, '/v1/workspaces')).find((ws) => ws.myRole === 'member');
  expect(seat, 'the workspace the invitation seated them in').toBeTruthy();
  const workspace = await apiGet<Workspace>(member, `/v1/workspaces/${seat!.id}`);
  expect(workspace.members?.find((m) => m.email === email)?.role).toBe('member');

  // The workspace's services are visible to the member…
  await member.goto('/services');
  await expect(member.getByText(webService(layout), { exact: true }).first()).toBeVisible();

  // …but operator-only routes are refused for them.
  const headers = { authorization: `Bearer ${await sessionToken(member)}` };
  const users = await member.request.get('/v1/users', { headers });
  expect(users.status()).toBe(403);
  const demo = await member.request.post('/v1/demo/seed', { headers });
  expect(demo.status()).toBe(403);

  // N10: in the page that refusal is one plain sentence — no request that can
  // only be refused, no error card — and the sidebar never offers an operator
  // page for them to click into one.
  for (const [route, page] of [['/users', 'People'], ['/volumes', 'Volumes & Storage'], ['/activity', 'Activity']] as const) {
    await member.goto(route);
    await expect(member.getByRole('heading', { name: page, exact: true })).toBeVisible();
    await expect(member.getByText('operators only.', { exact: false })).toBeVisible();
    await member.waitForLoadState('networkidle');
  }
  const view: MemberView = await sidebarInventory(member);
  const offered = Object.values(view.groups).flat();
  expect(offered.filter((item) => OPERATOR_ONLY.includes(item)), 'operator pages offered to a member').toEqual([]);
  await record(testInfo, `n10-member-${layout}`, { layout, workspace: workspace.name, myRole: workspace.myRole, seat: workspace.members?.find((m) => m.email === email), ...view, requests: mw.requests });

  await member.goto('/new');
  const apps = member.getByRole('region', { name: 'Applications' });
  await expect(apps.getByRole('button', { name: /Docker Compose|PM2 process|GitHub App/ })).toHaveCount(0);
  await apps.getByRole('button', { name: 'Docker image' }).click();
  const wizard = member.getByRole('dialog');
  await wizard.getByPlaceholder('my-app').fill(perLayout(layout, 'e2e-member-web'));
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
  await expect(member.getByText(perLayout(layout, 'e2e-member-web'), { exact: true }).first()).toBeVisible();
  await expect.poll(async () => {
    const rows = await apiList<{ status: string }>(member, `/v1/services/${serviceId}/deploys`);
    return rows[0]?.status;
  }, { timeout: 120_000 }).toBe('running');
  mw.assertClean();
  await ctx.close();
});
