import { expect, perLayout, test, webService } from './fixtures';
import { apiList, assetsFetchedForThisLoad, deploysOf, record, serviceByName, sidebar, sidebarInventory, tabStrip, watch } from './support';

/**
 * N10 (docs/plans/PROJECT_REVIEW_2026-11-16.md, N10): the operator tasks, each
 * reached the way a person reaches it — the sidebar, a service card, a tab —
 * in whichever layout this project runs. Both projects run this file, so both
 * layouts are measured by the same walk.
 *
 * The number counts clicks from the dashboard to the control that starts the
 * task. A layout that makes a task longer, or hides the control it starts
 * with, fails here and has to be read before it is accepted. The measured
 * facts are kept with the test (record) for the comparison in the docs.
 */
const CLICKS = {
  newDeployment: 2,
  environment: 3,
  deploymentLog: 3,
  runtimeLog: 3,
  rollback: 3,
  backup: 3,
  restore: 2,
  inviteUser: 2,
  grantSeat: 2,
};

const trim = (texts: string[]): string[] => texts.map((text) => text.trim());

test('N10 task paths: six operator tasks through the sidebar and the service tabs, and what the layout hides', async ({ page, layout }, testInfo) => {
  test.setTimeout(300_000);
  const w = watch(page);
  // One page load. The rest is the panel's own navigation, the way a person
  // moves through it — and the panel admits 1,000 requests a minute.
  await page.goto('/');
  const nav = sidebar(page);
  await nav.settled();
  const service = await serviceByName(page, webService(layout));
  const tabs = tabStrip(page).getByRole('tab');
  const clicks: Record<string, number> = {};
  const facts: Record<string, unknown> = { layout };

  // The sidebar this layout offers the operator.
  facts.sidebar = await sidebarInventory(page);

  /** Back on the dashboard through its sidebar link. Not part of a task's count. */
  const dashboard = () => nav.open('Deploy', 'Dashboard');
  /** The dashboard, the Services list, the service's card. */
  const openService = async (): Promise<number> => {
    await dashboard();
    const taken = await nav.open('Deploy', 'Services');
    // A service card links to the same page twice (the card and its name).
    await page.locator(`main a[href="/services/${service.id}"]`).first().click();
    await expect(tabs.first()).toBeVisible();
    return taken + 1;
  };

  // The service page before anyone opens anything.
  await openService();
  facts.primaryTabs = trim(await tabs.allTextContents());
  const more = tabStrip(page).getByRole('button', { name: 'More', exact: true });
  if (await more.count() === 1) {
    await more.click();
    facts.tabsUnderMore = trim(await tabs.allTextContents()).filter((label) => !(facts.primaryTabs as string[]).includes(label));
    await more.click();
  } else {
    facts.tabsUnderMore = [];
  }

  // Settings: the cards folded under "More settings" while their feature is off.
  await tabStrip(page).getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(tabStrip(page).locator('[role="tab"][aria-selected="true"]')).toHaveText('Settings');
  // The tab's content first: the deploy hook is in the open part in both layouts.
  await expect(page.getByRole('switch', { name: 'Deploy hook' })).toBeVisible();
  const fold = page.getByRole('main').getByRole('button', { name: /More settings/ });
  if (await fold.count() === 1) {
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    facts.foldedSettings = await page.locator('#service-more-settings > *').count();
  } else {
    facts.foldedSettings = 0;
  }
  // Kept now, with the walks still to come: what the layout hides is a fact
  // even when a walk below fails.
  await record(testInfo, `n10-layout-${layout}`, { ...facts });

  // 1. New deployment: the top bar's New, then the picker's Docker image.
  await dashboard();
  await page.locator('header').first().getByRole('button', { name: 'New resource' }).click();
  await page.getByRole('region', { name: 'Applications' }).getByRole('button', { name: 'Docker image' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  clicks.newDeployment = 2;

  // 2. Environment change.
  clicks.environment = await openService();
  await tabStrip(page).getByRole('tab', { name: 'Environment', exact: true }).click();
  clicks.environment += 1;
  await expect(page.getByPlaceholder('KEY', { exact: true })).toBeVisible();

  // 3a. A deployment's log.
  clicks.deploymentLog = await openService();
  await tabStrip(page).getByRole('tab', { name: 'Deploys', exact: true }).click();
  clicks.deploymentLog += 1;
  await expect(page.getByText('Deployment output', { exact: true })).toBeVisible();

  // 3b. The running container's log. Classic offers the header's Runtime
  // logs button on any tab; compact shows it on the Logs tab.
  clicks.runtimeLog = await openService();
  const toggle = page.getByRole('button', { name: /^(Runtime logs|Hide logs)$/ });
  if (layout === 'compact') {
    await tabStrip(page).getByRole('tab', { name: 'Logs', exact: true }).click();
    facts.runtimeLogControl = 'Logs tab';
    // The log is on the page, so the header button offers to hide it, and does.
    await expect(page.getByLabel('Search logs')).toBeVisible();
    await expect(toggle).toHaveText(/Hide logs/);
    await toggle.click();
    await expect(page.getByLabel('Search logs')).toHaveCount(0);
    await expect(toggle).toHaveText(/Runtime logs/);
    await toggle.click();
    await expect(page.getByLabel('Search logs')).toBeVisible();
  } else {
    facts.runtimeLogControl = 'Runtime logs button';
    await toggle.click();
  }
  clicks.runtimeLog += 1;
  await expect(page.getByLabel('Search logs')).toBeVisible();

  // 4. Rollback: the Deploys tab offers a release before the current one. A
  // deployment that is no longer live reads `superseded`.
  clicks.rollback = await openService();
  await tabStrip(page).getByRole('tab', { name: 'Deploys', exact: true }).click();
  clicks.rollback += 1;
  const superseded = (await deploysOf(page, service.id)).find((d) => d.status === 'superseded');
  expect(superseded, 'a release before the current one, left by 04').toBeTruthy();
  await expect(page.getByRole('button', { name: `Rollback to deployment #${superseded!.id}` })).toBeVisible();

  // 5. PostgreSQL backup: Data → Databases → the database 05-database-backup created.
  const database = (await apiList<{ id: number; name: string }>(page, '/v1/databases')).find((d) => d.name === perLayout(layout, 'e2e-restore'));
  expect(database, 'the database 05-database-backup created').toBeTruthy();
  await dashboard();
  clicks.backup = await nav.open('Data', 'Databases');
  // A database card links to the same page twice (its name and "Manage →").
  await page.locator(`main a[href="/databases/${database!.id}"]`).first().click();
  clicks.backup += 1;
  await expect(page.getByRole('button', { name: /Backup now/ })).toBeVisible();

  // 6. Restore: Data → Backups; the snapshot's row has the Restore control.
  await dashboard();
  clicks.restore = await nav.open('Data', 'Backups');
  await expect(page.getByRole('row').filter({ has: page.getByText(database!.name, { exact: true }) }).getByTitle('Restore', { exact: true })).toBeVisible();

  // 7. Team access: System → Users creates the account; Organize → Workspaces gives it a seat.
  await dashboard();
  clicks.inviteUser = await nav.open('System', 'Users');
  await expect(page.getByRole('button', { name: /New user/ })).toBeVisible();
  await dashboard();
  clicks.grantSeat = await nav.open('Organize', 'Workspaces');
  await expect(page.getByRole('button', { name: /Invite Member/ })).toBeVisible();

  // Instance Settings, for the follow-up that groups them by task: the same
  // page in both layouts, so the count is what that work starts from.
  await nav.open('System', 'Settings');
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(sections.getByRole('tab').first()).toBeVisible();
  facts.settingsSections = (await sections.getByRole('tab').count());
  facts.settingsSectionGroups = trim(await sections.getByRole('heading').allTextContents());

  await record(testInfo, `n10-task-paths-${layout}`, { layout, clicks, runtimeLogControl: facts.runtimeLogControl, settingsSections: facts.settingsSections, settingsSectionGroups: facts.settingsSectionGroups, requests: w.requests });
  expect(clicks, 'clicks from the dashboard to the control that starts each task').toEqual(CLICKS);

  // What each layout may hide: compact folds the rarely used tabs and the
  // settings cards whose feature is off; classic hides nothing.
  const sidebarGroups = facts.sidebar as { groups: Record<string, string[]> };
  if (layout === 'compact') {
    expect(facts.primaryTabs).toEqual(['Overview', 'Deploys', 'Environment', 'Domains', 'Logs', 'Settings']);
    expect(facts.tabsUnderMore).toEqual(['Volumes & Storage', 'Terminal & Exec', 'File Browser', 'Manifest & Traefik', 'CI', 'Framework', 'Architecture', 'Danger Zone']);
    expect(facts.foldedSettings, 'cards folded under More settings').toBeGreaterThan(0);
    expect(sidebarGroups.groups.Deploy).toContain('New');
    expect(sidebarGroups.groups.Deploy).not.toContain('Hub');
  } else {
    expect(facts.primaryTabs).toHaveLength(14);
    expect(facts.tabsUnderMore).toEqual([]);
    expect(facts.foldedSettings).toBe(0);
    expect(sidebarGroups.groups.Deploy).toContain('Hub');
  }
  w.assertClean();
});

test('N10 direct links and the layout choice: a service tab deep link lands on a selected, visible tab, and the layout survives reloads', async ({ page, layout }, testInfo) => {
  test.setTimeout(300_000);
  const w = watch(page);
  await page.goto('/');
  const service = await serviceByName(page, webService(layout));
  const base = `/services/${service.id}`;
  const tabs = tabStrip(page).getByRole('tab');

  // Which `?tab=` key each tab writes, read by using the tabs once — More's
  // too, in the layout that has it.
  const keys = new Map<string, string>();
  await page.goto(base);
  await expect(tabs.first()).toBeVisible();
  // N10: a first visit fetches the page's hashed files. Later loads in this
  // browser fetch none: the panel marks them immutable. Before that, every
  // load asked for all of them again, which the panel's request limit counts.
  const fetchedOnFirstVisit = await assetsFetchedForThisLoad(page);
  expect(fetchedOnFirstVisit, 'hashed files fetched by a first visit').toBeGreaterThan(0);
  const more = tabStrip(page).getByRole('button', { name: 'More', exact: true });
  if (await more.count() === 1) await more.click();
  for (const tab of await tabs.all()) {
    const label = (await tab.textContent())!.trim();
    await tab.click();
    keys.set(new URL(page.url()).searchParams.get('tab') ?? 'overview', label);
  }
  expect(keys.size, 'the tabs this layout has').toBe(14);

  // A deep link to a tab selects a tab a person can see: a primary one, the
  // one compact shows under More first and the one it shows last, and the
  // last of all. (One load of the service page costs the panel some thirty
  // requests, and it admits a signed-in user a thousand a minute: the full
  // sweep of all fourteen is acceptance evidence, not part of every run.)
  const some = ['overview', 'environment', 'settings', 'terminal', 'danger'];
  for (const key of some) {
    await page.goto(`${base}?tab=${key}`);
    // Scoped to the strip: a tab panel can hold tab strips of its own.
    const selected = tabStrip(page).locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toBeVisible();
    await expect(selected).toBeInViewport();
    expect(keys.get(key), `the tab ?tab=${key} selects`).toBeTruthy();
    await expect(selected).toHaveText(keys.get(key)!);
    if (layout === 'compact') {
      // More opens by itself when one of its tabs is the target, and stays shut otherwise.
      const underMore = !['overview', 'deploys', 'environment', 'network', 'activity', 'settings'].includes(key);
      await expect(tabStrip(page).getByRole('button', { name: 'More', exact: true })).toHaveAttribute('aria-expanded', String(underMore));
    }
  }
  // An unknown key is the Overview, not an empty page.
  await page.goto(`${base}?tab=no-such-tab`);
  await expect(tabStrip(page).locator('[role="tab"][aria-selected="true"]')).toHaveText(keys.get('overview')!);

  // The layout is a stored choice: switching in Appearance, it survives a
  // reload and a direct link, and switching back does too.
  const label = (which: 'classic' | 'compact') => (which === 'compact' ? 'Compact' : 'Classic');
  const other: 'classic' | 'compact' = layout === 'compact' ? 'classic' : 'compact';
  const pressed = async (which: 'classic' | 'compact') => {
    await expect(page.getByRole('button', { name: label(which), exact: true })).toHaveAttribute('aria-pressed', 'true');
  };
  await page.goto('/settings?section=appearance');
  await pressed(layout);
  await page.getByRole('button', { name: label(other), exact: true }).click();
  await pressed(other);
  await page.reload();
  await pressed(other);
  // A direct link opens the other layout's service page.
  await page.goto(base);
  await expect(tabs).toHaveCount(other === 'compact' ? 6 : 14);
  await page.goto('/settings?section=appearance');
  await page.getByRole('button', { name: label(layout), exact: true }).click();
  await pressed(layout);
  await page.reload();
  await pressed(layout);
  const fetchedOnALaterLoad = await assetsFetchedForThisLoad(page);
  expect(fetchedOnALaterLoad, 'hashed files fetched again by a later load in the same browser').toBe(0);
  await record(testInfo, `n10-direct-links-${layout}`, {
    layout,
    tabs: Object.fromEntries(keys),
    hashedFilesFetched: { firstVisit: fetchedOnFirstVisit, laterLoad: fetchedOnALaterLoad },
    responsesSeenByThePage: w.requests,
  });
  w.assertClean();
});
