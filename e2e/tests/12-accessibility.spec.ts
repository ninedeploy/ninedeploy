import { expect, test, webService } from './fixtures';
import { apiList, focusFirstControl, focused, record, serviceByName, sidebar, tabStrip, tabTimes, tabTo, unnamedControls, watch, type Control } from './support';

/** Every stop on the way must tell a screen-reader user what it is. */
const named = (stops: Control[], where: string) => expect(stops.filter((stop) => !stop.name), `${where}: Tab stops without a name`).toEqual([]);

test('N10 keyboard: the rail, a group\'s links and the service tabs work from the keyboard, and Enter selects', async ({ page, layout }, testInfo) => {
  test.setTimeout(300_000);
  const w = watch(page);
  // One page load; the rest is the panel's own navigation.
  await page.goto('/');
  const nav = sidebar(page);
  await nav.settled();
  const service = await serviceByName(page, webService(layout));
  const facts: Record<string, unknown> = { layout };

  // The activity rail: Tab reaches each group icon, and every stop on the way has a name.
  const rail = [await focusFirstControl(page), ...(await tabTo(page, (stop) => stop.tag === 'button' && stop.name === 'Data'))];
  named(rail, 'the activity rail');
  facts.tabStopsToRailData = rail.length;
  facts.stopsToRailData = rail.map((stop) => stop.name);
  await page.keyboard.press('Enter');
  // The group's panel opens, and Tab carries on into its links.
  const links = await tabTo(page, (stop) => stop.tag === 'a' && stop.name === 'Databases');
  named(links, 'from the Data icon to its links');
  facts.tabStopsFromRailIconToItsLinks = links.length;
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/databases$/);

  // The service page's tabs: one Tab stop each, up to the last one this layout shows up front.
  await nav.open('Deploy', 'Services');
  await page.locator(`main a[href="/services/${service.id}"]`).first().click();
  const upTo = async (last: string) => {
    // From the top of the page, as after a page load: the first control, then Tab.
    await expect(tabStrip(page).getByRole('tab').first()).toBeVisible();
    const start = await focusFirstControl(page);
    const stops = [start, ...(await tabTo(page, (stop) => stop.role === 'tab' && stop.name === last, 150))];
    named(stops, `the service page up to the ${last} tab`);
    return stops;
  };
  const across = await upTo(layout === 'compact' ? 'Settings' : 'Danger Zone');
  facts.tabStopsAcrossServiceTabs = across.filter((stop) => stop.role === 'tab').length;
  facts.tabStopsBeforeServiceTabs = across.findIndex((stop) => stop.role === 'tab');

  await upTo('Environment');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/tab=environment/);
  await expect(page.getByPlaceholder('KEY', { exact: true })).toBeVisible();
  // Selecting a tab changes the page's content, not where the focus is.
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText('Environment');
  await expect.poll(() => focused(page)).toMatchObject({ role: 'tab', name: 'Environment' });

  if (layout === 'compact') {
    // More opens from the keyboard, and Tab carries on into the tabs it was hiding.
    await upTo('Settings');
    await page.keyboard.press('Tab');
    await expect.poll(() => focused(page)).toMatchObject({ tag: 'button', name: 'More' });
    await page.keyboard.press('Enter');
    const hidden = await tabTo(page, (stop) => stop.role === 'tab' && stop.name === 'Volumes & Storage');
    named(hidden, 'inside More');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/tab=volumes/);
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText('Volumes & Storage');
    await expect.poll(() => focused(page)).toMatchObject({ role: 'tab', name: 'Volumes & Storage' });
  }

  await record(testInfo, `n10-keyboard-${layout}`, { ...facts, requests: w.requests });
  w.assertClean();
});

type DialogCheck = { dialog: string; focusWentIn: boolean; focusStayedIn: boolean; stopsNamed: boolean; focusCameBack: boolean };

test('N10 focus return: a dialog opened from the keyboard takes focus, keeps it, and hands it back when closed', async ({ page, layout }, testInfo) => {
  test.setTimeout(300_000);
  const w = watch(page);
  // One page load; the rest is the panel's own navigation.
  await page.goto('/');
  const nav = sidebar(page);
  await nav.settled();
  const service = await serviceByName(page, webService(layout));
  const checks: DialogCheck[] = [];

  /** The dialog just opened from `opener`: where the focus is, where Tab goes, and where Escape leaves it. */
  const openedFrom = async (dialog: string, opener: Control): Promise<void> => {
    await expect(page.getByRole('dialog')).toBeVisible();
    // The dialog's own effects place the focus; give them a moment.
    await page.waitForTimeout(400);
    const focusWentIn = (await focused(page)).inDialog;
    const stops = await tabTimes(page, 12);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const after = await focused(page);
    checks.push({
      dialog,
      focusWentIn,
      focusStayedIn: stops.every((stop) => stop.inDialog),
      stopsNamed: stops.every((stop) => !!stop.name),
      focusCameBack: after.tag === opener.tag && after.name === opener.name,
    });
  };
  /** Tabs from the top of the page to `target` and returns it. */
  const reach = async (target: (stop: Control) => boolean) => {
    await focusFirstControl(page);
    return (await tabTo(page, target, 150)).at(-1)!;
  };

  // New deployment: the top bar's New, then the picker's Docker image.
  await page.locator('header').first().getByRole('button', { name: 'New resource' }).click();
  const image = await reach((stop) => stop.tag === 'button' && stop.name === 'Docker image');
  await page.keyboard.press('Enter');
  await openedFrom('deploy wizard', image);

  // A database: Data → Databases → New database.
  await nav.open('Data', 'Databases');
  const newDatabase = await reach((stop) => stop.tag === 'button' && stop.name === 'New database');
  await page.keyboard.press('Enter');
  await openedFrom('new database wizard', newDatabase);

  // Rollback: a release's rollback button (Escape cancels; nothing is rolled back).
  await nav.open('Deploy', 'Services');
  await page.locator(`main a[href="/services/${service.id}"]`).first().click();
  await tabStrip(page).getByRole('tab', { name: 'Deploys', exact: true }).click();
  const rollback = await reach((stop) => stop.tag === 'button' && /^Rollback to deployment #\d+$/.test(stop.name));
  await page.keyboard.press('Enter');
  await openedFrom('rollback confirmation', rollback);

  // Restore: a snapshot's Restore control (Escape cancels; nothing is restored).
  await nav.open('Data', 'Backups');
  const restore = await reach((stop) => stop.tag === 'button' && stop.name === 'Restore');
  await page.keyboard.press('Enter');
  await openedFrom('restore confirmation', restore);

  // Team access: Organize → Workspaces → Invite Member.
  await nav.open('Organize', 'Workspaces');
  const invite = await reach((stop) => stop.tag === 'button' && stop.name === 'Invite Member');
  await page.keyboard.press('Enter');
  await openedFrom('invite member', invite);

  await record(testInfo, `n10-focus-${layout}`, { layout, dialogs: checks, requests: w.requests });
  const failed = (check: DialogCheck) => !(check.focusWentIn && check.focusStayedIn && check.stopsNamed && check.focusCameBack);
  expect(checks.filter(failed), 'dialogs that do not take, keep and return the focus').toEqual([]);
  w.assertClean();
});

test('N10 accessible names: every control on the task pages and in their dialogs has a name', async ({ page, layout }, testInfo) => {
  test.setTimeout(300_000);
  const w = watch(page);
  // One page load; the rest is the panel's own navigation, in the order of a
  // walk through the tasks' pages.
  await page.goto('/');
  const nav = sidebar(page);
  await nav.settled();
  const service = await serviceByName(page, webService(layout));
  const database = (await apiList<{ id: number; name: string }>(page, '/v1/databases'))[0]!;
  const tabs = tabStrip(page).getByRole('tab');
  type Unnamed = Array<{ tag: string; role: string; place: string; inDialog: boolean; hint: string }>;
  const report: Array<{ where: string; unnamed: Unnamed }> = [];

  /** The page has settled (its first requests are answered) before its controls are read. */
  const look = async (where: string) => {
    await expect(page.locator('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    report.push({ where, unnamed: (await unnamedControls(page)) as Unnamed });
  };
  /** Opens a dialog, reads it, and closes it without doing what it asks. */
  const lookInside = async (dialog: string, open: () => Promise<void>) => {
    await open();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(300);
    report.push({ where: `dialog: ${dialog}`, unnamed: (await unnamedControls(page)) as Unnamed });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };

  await look('/');
  await nav.open('Deploy', 'Services');
  await look('/services');
  await page.locator(`main a[href="/services/${service.id}"]`).first().click();
  await expect(tabs.first()).toBeVisible();
  await look('service: overview');
  await tabStrip(page).getByRole('tab', { name: 'Deploys', exact: true }).click();
  await look('service: deploys');
  await lookInside('rollback confirmation', () => page.getByRole('button', { name: /^Rollback to deployment #\d+$/ }).first().click());
  for (const [tab, where] of [['Environment', 'environment'], ['Settings', 'settings']] as const) {
    await tabStrip(page).getByRole('tab', { name: tab, exact: true }).click();
    await look(`service: ${where}`);
  }

  await nav.open('Data', 'Databases');
  await look('/databases');
  await lookInside('new database wizard', () => page.getByRole('button', { name: 'New database', exact: true }).click());
  await page.locator(`main a[href="/databases/${database.id}"]`).first().click();
  await look('/databases/:id');

  await nav.open('Data', 'Backups');
  await look('/backups');
  await lookInside('restore confirmation', () => page.getByTitle('Restore', { exact: true }).first().click());

  await nav.open('System', 'Users');
  await look('/users');

  await nav.open('Organize', 'Workspaces');
  await look('/workspaces');
  await lookInside('invite member', () => page.getByRole('button', { name: 'Invite Member', exact: true }).click());

  await page.locator('header').first().getByRole('button', { name: 'New resource' }).click();
  await look('/new');
  await lookInside('deploy wizard', () => page.getByRole('region', { name: 'Applications' }).getByRole('button', { name: 'Docker image' }).click());

  await record(testInfo, `n10-names-${layout}`, { layout, pages: report, requests: w.requests });
  expect(report.filter((entry) => entry.unnamed.length > 0), 'pages or dialogs with a control a screen reader cannot name').toEqual([]);
  w.assertClean();
});

test('N10 Turkish: the tabs, More and the sidebar read in Turkish, with the compact names too', async ({ page, layout }, testInfo) => {
  const w = watch(page);
  await page.goto('/settings?section=appearance');
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'Türkçe' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  const service = await serviceByName(page, webService(layout));
  await page.goto(`/services/${service.id}`);
  const main = page.getByRole('main');
  const tabs = main.getByRole('tab');
  if (layout === 'compact') {
    await expect(tabs).toHaveText(['Genel bakış', 'Dağıtımlar', 'Ortam', 'Alan adları', 'Loglar', 'Ayarlar']);
    const more = main.getByRole('button', { name: 'Diğer', exact: true });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(tabs).toHaveText(['Genel bakış', 'Dağıtımlar', 'Ortam', 'Alan adları', 'Loglar', 'Ayarlar', 'Birimler ve depolama', 'Terminal ve Exec', 'Dosya tarayıcı', 'Manifest ve Traefik', 'CI', 'Framework', 'Mimari', 'Tehlikeli bölge']);
    await page.goto(`/services/${service.id}?tab=settings`);
    await expect(main.getByRole('button', { name: /Diğer ayarlar/ })).toHaveAttribute('aria-expanded', 'false');
  } else {
    await expect(tabs).toHaveText(['Genel bakış', 'Terminal ve Exec', 'Mimari', 'Manifest ve Traefik', 'Dağıtımlar', 'CI', 'Ortam', 'Ağ ve alan adları', 'Birimler ve depolama', 'Dosya tarayıcı', 'Framework', 'Ayarlar', 'Etkinlik logları', 'Tehlikeli bölge']);
    await expect(main.getByRole('button', { name: 'Diğer', exact: true })).toHaveCount(0);
  }

  // The sidebar follows, and "New" is the compact name of the item that replaced Hub.
  await page.goto('/services');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Servisler', exact: true })).toBeVisible();
  if (layout === 'compact') {
    await expect(nav.getByRole('link', { name: 'Yeni', exact: true })).toHaveAttribute('href', '/new');
    await expect(nav.getByRole('link', { name: 'Hub', exact: true })).toHaveCount(0);
  } else {
    await expect(nav.getByRole('link', { name: 'Hub', exact: true })).toHaveAttribute('href', '/hub');
  }
  await record(testInfo, `n10-turkish-${layout}`, { layout, requests: w.requests });
  w.assertClean();
});
