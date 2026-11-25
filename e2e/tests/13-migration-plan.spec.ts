import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { expect, perLayout, test } from './fixtures';
import { apiGet, apiList, deploysOf, serviceByName, sessionToken, watch } from './support';

const plan = {
  planVersion: 1,
  source: { kind: 'coolify', url: 'https://user:private-preview-value@source.example?token=hidden-query', version: '4.7.0', scope: 'Production workspace' },
  generatedAt: '2026-11-23T11:00:00.000Z',
  services: [{
    ref: 'app', name: 'Storefront', kind: 'image', create: { name: 'Storefront', type: 'docker', image: 'nginx:1.27', port: 80 },
    domains: [{ host: 'store.example', https: true }, { host: 'generated.example', https: false, sourceDefault: true }],
    env: [{ key: 'API_TOKEN', value: 'plan-value-must-stay-hidden' }],
    volumes: [{ mountPath: '/data', source: 'volume', name: 'store-files' }],
    issues: [{ level: 'manual', option: 'volume', detail: 'Copy the second volume separately.' }],
  }],
  databases: [{ ref: 'db', name: 'Store database', engine: 'postgres', image: 'postgres:16', issues: [] }],
  notes: ['The source inventory was read without changing it.'],
};

test('migration plan review reads the file in the browser and never sends it', async ({ page }) => {
  const w = watch(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/v1/') && !['GET', 'HEAD'].includes(request.method())) writes.push(url.pathname);
  });
  await page.goto('/new');
  const open = page.getByRole('button', { name: 'Review migration plan' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Review migration plan' });
  const input = dialog.getByLabel('Migration plan JSON');
  await expect(input).toBeFocused();
  const file = (value: unknown) => ({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });

  await input.setInputFiles(file({ planVersion: 2 }));
  await expect(dialog.getByRole('alert')).toHaveText('Choose a version 1 migration plan.');
  await input.setInputFiles(file(plan));
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByText('source.example', { exact: true })).toBeVisible();
  await dialog.getByText('Storefront', { exact: true }).click();
  await expect(dialog.getByText('API_TOKEN', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Stays on the source', { exact: false })).toBeVisible();
  await expect(dialog.getByText('Copy the second volume separately.')).toBeVisible();
  await dialog.getByText('Store database', { exact: true }).click();
  await expect(dialog.getByText('postgres:16', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText(/private-preview-value|hidden-query|plan-value-must-stay-hidden/);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  expect(writes).toEqual([]);
  w.assertClean();
});

test('migration target checks the live inventory before an import', async ({ page, layout }) => {
  await page.goto('/new');
  const name = perLayout(layout, 'migration-target-check');
  const created = await page.request.post('/v1/services', {
    headers: { authorization: `Bearer ${await sessionToken(page)}` },
    data: { name, type: 'docker', image: 'nginx:1.27' },
  });
  expect(created.ok()).toBe(true);

  const w = watch(page);
  await page.getByRole('button', { name: 'Review migration plan' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review migration plan' });
  const entry = plan.services[0]!;
  const file = { ...plan, services: [{ ...entry, create: { ...entry.create, name: name.toUpperCase() } }] };
  await dialog.getByLabel('Migration plan JSON').setInputFiles({
    name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)),
  });

  const requests: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
  });
  const target = dialog.getByRole('region', { name: 'Target checks' });
  await target.getByRole('button', { name: 'Check target' }).click();
  await expect(target.getByText('Target name already in use.')).toBeVisible();
  await expect(target.locator('code')).toHaveText(name);
  expect(requests).toEqual(expect.arrayContaining(['GET /v1/services', 'GET /v1/databases']));
  expect(requests.filter((request) => !request.startsWith('GET '))).toEqual([]);
  w.assertClean();
});

test('migration prepares resources once and restores a verified dump into the planned database', async ({ page, layout }) => {
  test.setTimeout(240_000);
  const app = perLayout(layout, 'migration-prepare-app');
  const db = perLayout(layout, 'migration-prepare-db');
  const occupied = perLayout(layout, 'migration-prepare-occupied');
  await page.goto('/new');
  const headers = { authorization: `Bearer ${await sessionToken(page)}` };
  const seeded = await page.request.post('/v1/services', { headers, data: { name: occupied, type: 'docker', image: 'nginx:1.26' } });
  expect(seeded.ok()).toBe(true);
  const daemon = process.env.ND_E2E_DIND;
  if (!daemon || !/^nd-e2e-dind-[a-f0-9]{8}$/.test(daemon)) throw new Error('Migration preparation needs the disposable browser smoke daemon');
  const docker = (...args: string[]) => execFileSync('docker', ['exec', daemon, 'docker', '-H', 'tcp://127.0.0.1:2375', ...args],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const retained = perLayout(layout, 'migration-prepare-retained');
  const volume = `nd-db-${retained}-data`;
  docker('volume', 'create', '--label', 'fixture=retained', volume);
  const conflict = await page.request.post('/v1/databases/empty', { headers, data: { name: retained, engine: 'postgres' } });
  expect(conflict.status()).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: 'fresh_volume_required' } });
  expect(docker('volume', 'inspect', '--format', '{{.Labels.fixture}}', volume)).toBe('retained');
  const requestWrites: string[] = [];
  const w = watch(page);
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/v1/') && !['GET', 'HEAD'].includes(request.method())) requestWrites.push(`${request.method()} ${path}`);
  });
  const source = plan.services[0]!;
  const file = { ...plan,
    services: [
      { ...source, ref: 'occupied', name: occupied, create: { ...source.create, name: occupied } },
      { ...source, name: app, create: { ...source.create, name: app }, settings: { healthCheck: 'running' },
        env: ['API_TOKEN', 'KEEP_VALUE', 'DATABASE_URL', 'LEGACY_URL', 'MISSING'].map((key) => ({ key })),
        attachments: [{ database: plan.databases[0]!.ref, envAlias: 'DATABASE_URL' }] },
    ],
    databases: [{ ...plan.databases[0]!, name: db, runtime: { kind: 'container', name: 'migration-old-db' } }],
  };
  const openPlan = async () => {
    await page.getByRole('button', { name: 'Review migration plan' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review migration plan' });
    await dialog.getByLabel('Migration plan JSON').setInputFiles({
      name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)),
    });
    return dialog;
  };
  const dialog = await openPlan();
  await dialog.getByRole('button', { name: 'Prepare resources' }).click();
  const baselineWrites = requestWrites.length;
  const confirm = dialog.getByRole('button', { name: 'Create resources' });
  await expect(confirm).toBeVisible();
  expect(requestWrites).toHaveLength(baselineWrites);
  await confirm.click();
  await expect(dialog.getByText('Prepared 2 resources')).toBeVisible({ timeout: 120_000 });
  await expect(dialog.getByText('Name in use. Review the existing resource.', { exact: false })).toBeVisible();

  const services = await apiList<{ id: number; name: string; status: string; image: string; healthCheck: string }>(page, '/v1/services');
  const service = services.find(({ name }) => name === app)!;
  expect(service).toMatchObject({ status: 'idle', image: 'nginx:1.27', healthCheck: 'running' });
  expect(services.find(({ name }) => name === occupied)).toMatchObject({ status: 'idle', image: 'nginx:1.26' });
  expect(await deploysOf(page, service.id)).toEqual([]);
  expect(await apiList(page, `/v1/services/${service.id}/domains`)).toEqual([]);
  const databases = await apiList<{ id: number; name: string; status: string; version: string; containerName: string }>(page, '/v1/databases');
  const database = databases.find(({ name }) => name === db);
  expect(databases.some(({ name }) => name === retained)).toBe(false);
  expect(database).toMatchObject({ status: 'running', version: '16' });
  const sql = `SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'`;
  await expect.poll(() => {
    try { return docker('exec', database!.containerName, 'psql', '-XAtq', '-U', 'nine', '-d', 'app', '-c', sql); }
    catch { return null; }
  }, { timeout: 60_000 }).toBe('0');
  expect(requestWrites).toEqual(['POST /v1/services', `PATCH /v1/services/${service.id}`, 'POST /v1/databases/empty']);

  await page.reload();
  const retry = await openPlan();
  await expect(retry.getByRole('heading', { name: 'Verified preparation (2)' })).toBeVisible();
  await expect(retry.getByText('Resources without a preparation record (1)')).toBeVisible();
  const importLink = retry.getByRole('link', { name: `Import a dump into ${db}` });
  await expect(importLink).toHaveAttribute('href', `/databases/${database!.id}?tab=backups#import-dump`);
  await retry.getByRole('button', { name: 'Check import status' }).click();
  await expect(retry.getByText('No data import recorded.')).toBeVisible();
  const targetCheck = retry.getByRole('region', { name: 'Target checks' });
  await targetCheck.getByRole('button', { name: 'Check target' }).click();
  await expect(targetCheck.getByText('Target name already in use.')).toHaveCount(1);
  await expect(targetCheck.locator('code')).toHaveText(occupied);
  expect(requestWrites).toHaveLength(3);
  await retry.getByRole('button', { name: 'Prepare resources' }).click();
  await retry.getByRole('button', { name: 'Create resources' }).click();
  await expect(retry.getByText('Prepared 2 resources')).toBeVisible();
  expect(requestWrites).toHaveLength(3);
  const readiness = retry.getByRole('region', { name: `Deployment readiness for ${app}` });
  const checkReadiness = readiness.getByRole('button', { name: 'Check deployment readiness' });
  await checkReadiness.click();
  await expect(readiness.getByText('Planned environment keys missing on the target')).toBeVisible();
  await expect(readiness.getByText('Planned database connections to review')).toBeVisible();
  await expect(readiness.getByRole('link', { name: 'Open deployments' })).toHaveCount(0);
  expect(requestWrites).toHaveLength(3);

  const envPath = `/v1/services/${service.id}/env`;
  expect((await page.request.post(envPath, { headers, data: { key: 'KEEP_VALUE', value: 'existing-fixture' } })).ok()).toBe(true);
  const environment = retry.getByRole('region', { name: `Environment for ${app}` });
  const dotenv = Buffer.from([
    'API_TOKEN=secret-migration-fixture', 'KEEP_VALUE=overwrite-fixture',
    'DATABASE_URL=postgres://old:source-fixture@migration-old-db:5432/app',
    'LEGACY_URL=postgres://old:source-fixture@migration-old-db:5432/app?sslmode=require', 'EXTRA=unplanned-fixture',
  ].join('\n'));
  await environment.getByLabel('Environment file').setInputFiles({ name: 'migration.env', mimeType: 'text/plain', buffer: dotenv });
  await expect(environment.getByText('Source connection keys to review')).toBeVisible();
  await expect(environment.getByText('MISSING', { exact: true })).toBeVisible();
  await expect(environment).not.toContainText(/secret-migration-fixture|source-fixture|unplanned-fixture/);
  await environment.getByRole('button', { name: 'Apply migration settings' }).click();
  expect(requestWrites).toHaveLength(3);
  await environment.getByRole('button', { name: 'Confirm environment migration' }).click();
  await expect(environment.getByText('1 secret values saved, 1 existing keys kept, 0 refused.')).toBeVisible();
  const env = await apiList<{ key: string; isSecret: boolean; value: string }>(page, envPath);
  expect(env.map(({ key }) => key)).toEqual(['API_TOKEN', 'KEEP_VALUE']);
  expect(env).toEqual([expect.objectContaining({ key: 'API_TOKEN', isSecret: true, value: '' }), expect.objectContaining({ key: 'KEEP_VALUE', value: 'existing-fixture' })]);
  expect(await apiList(page, `/v1/services/${service.id}/attachments`)).toEqual([expect.objectContaining({ envAlias: 'DATABASE_URL', databaseId: database!.id })]);
  expect(requestWrites).toHaveLength(5);
  await checkReadiness.click();
  await expect(readiness.getByText('LEGACY_URL, MISSING')).toBeVisible();
  await expect(readiness.getByText('Planned database connections to review')).toHaveCount(0);
  const pendingTransfer = readiness.getByRole('region', { name: 'Data transfer on the target' });
  await expect(pendingTransfer.getByText('DATABASE_URL')).toBeVisible();
  await expect(pendingTransfer.getByText('No data import recorded.')).toBeVisible();
  expect(requestWrites).toHaveLength(5);

  const container = database!.containerName;
  docker('exec', container, 'createdb', '-U', 'nine', 'migration_source');
  docker('exec', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'nine', '-d', 'migration_source', '-c',
    'CREATE TABLE orders (id integer PRIMARY KEY, amount integer); INSERT INTO orders VALUES (1, 7), (2, 11), (3, 13)');
  const dump = Buffer.from(`${docker('exec', container, 'pg_dump', '-U', 'nine', '--no-owner', '--no-privileges', 'migration_source')}\n`);
  const sha256 = createHash('sha256').update(dump).digest('hex');
  await importLink.click();
  const importer = page.getByRole('region', { name: 'Import a dump' });
  await expect(importer).toBeFocused();
  await expect(importer.getByRole('button', { name: 'Upload and import' })).toBeDisabled();
  expect(requestWrites).toHaveLength(5);
  await importer.getByLabel('Dump file').setInputFiles({ name: 'migration.sql', mimeType: 'application/sql', buffer: dump });
  await importer.getByRole('button', { name: 'Upload and import' }).click();
  const listImports = () => apiList<{ id: number; status: string; sha256: string; safetyBackupId: number | null }>(page, `/v1/databases/${database!.id}/imports`);
  await expect.poll(async () => (await listImports())[0]?.status, { timeout: 90_000 }).toBe('completed');
  const imports = await listImports();
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({ sha256, safetyBackupId: expect.any(Number) });
  await expect(importer.getByTestId(`import-${imports[0]!.id}`).getByText('completed', { exact: true })).toBeVisible();
  expect(docker('exec', container, 'psql', '-XAtq', '-U', 'nine', '-d', 'app', '-c', 'SELECT count(*), sum(amount) FROM orders')).toBe('3|31');
  const writesAfterImport = requestWrites.length;
  await page.goto('/new');
  const restored = await openPlan();
  await restored.getByRole('button', { name: 'Check import status' }).click();
  await expect(restored.getByText('Latest data import: Completed', { exact: true })).toBeVisible();
  const afterReadiness = restored.getByRole('region', { name: `Deployment readiness for ${app}` });
  await afterReadiness.getByRole('button', { name: 'Check deployment readiness' }).click();
  const dbTransfer = afterReadiness.getByRole('region', { name: 'Data transfer on the target' });
  await expect(dbTransfer.getByText('DATABASE_URL')).toBeVisible();
  await expect(dbTransfer.getByText('Completed', { exact: true })).toBeVisible();
  await expect(dbTransfer.getByText('Review the transfer results before deploying.')).toHaveCount(0);
  expect(requestWrites).toHaveLength(writesAfterImport);
  expect(await deploysOf(page, service.id)).toEqual([]);
  expect((await page.request.post(`/v1/services/${service.id}/deploys`, { headers, data: {} })).ok()).toBe(true);
  await expect.poll(async () => (await deploysOf(page, service.id))[0]?.status, { timeout: 150_000 }).toBe('running');
  const deployed = await apiGet<{ runtimeId: string }>(page, `/v1/services/${service.id}`);
  expect(docker('exec', deployed.runtimeId, 'sh', '-ec',
    'test "$API_TOKEN" = secret-migration-fixture; test "$KEEP_VALUE" = existing-fixture; test -z "$LEGACY_URL$EXTRA"; case "$DATABASE_URL" in *@"$1":5432/app) echo ok;; *) exit 1;; esac', 'env-check', container)).toBe('ok');
  w.assertClean();
});

test('migration stages an archive, then restores the primary volume and preserves its metadata', async ({ page, layout }) => {
  test.setTimeout(240_000);
  const name = perLayout(layout, 'migration-archive');
  const target = `nd-svc-${name}-data`;
  const source = `fixture-${name}`;
  const daemon = process.env.ND_E2E_DIND;
  if (!daemon || !/^nd-e2e-dind-[a-f0-9]{8}$/.test(daemon)) throw new Error('Volume proof needs the disposable browser smoke daemon');
  const docker = (...args: string[]) => execFileSync('docker', ['exec', daemon, 'docker', '-H', 'tcp://127.0.0.1:2375', ...args],
    { timeout: 90_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const helper = (mount: string, command: string) => docker('run', '--rm', '--network', 'none', '-v', mount, 'alpine:3.21', 'sh', '-ec', command);
  const w = watch(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.includes('/volume-imports') && !['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${pathname}`);
  });

  await page.goto('/new');
  const entry = plan.services[0]!;
  const file = { ...plan, databases: [], services: [{ ...entry, name, create: { ...entry.create, name, volumeMount: '/data' } }] };
  const openPlan = async () => {
    await page.getByRole('button', { name: 'Review migration plan' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review migration plan' });
    await dialog.getByLabel('Migration plan JSON').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    return dialog;
  };
  const review = await openPlan();
  await review.getByRole('button', { name: 'Prepare resources' }).click();
  await review.getByRole('button', { name: 'Create resources' }).click();
  const link = review.getByRole('link', { name: `Import a volume archive into ${name}` });
  await expect(link).toBeVisible();
  const service = await serviceByName(page, name);

  helper(`${target}:/data`, "printf old-data > /data/before.txt");
  const archive = helper(`${source}:/data`, 'mkdir -p /data/nested; printf migrated-data > /data/nested/file.txt; chown 1234:1234 /data/nested/file.txt; chmod 640 /data/nested/file.txt; ln -s nested/file.txt /data/current; tar -czf - -C /data .');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  await expect(link).toHaveAttribute('href', `/services/${service.id}?tab=volumes#import-volume`);
  await link.click();
  const importer = page.getByRole('region', { name: 'Import a volume archive' });
  await expect(importer).toBeFocused();
  await importer.getByLabel('Volume archive').setInputFiles({ name: 'migration.tar.gz', mimeType: 'application/gzip', buffer: archive });
  await importer.getByRole('button', { name: 'Upload archive' }).click();
  await expect(importer.getByText('Ready to restore')).toBeVisible();
  expect(writes.filter((path) => path.endsWith('/start'))).toEqual([]);
  expect(helper(`${target}:/data:ro`, 'cat /data/before.txt; test ! -e /data/current').toString()).toBe('old-data');

  const writesAfterUpload = writes.length;
  await page.goto('/new');
  const staged = await openPlan();
  await staged.getByRole('button', { name: 'Check import status' }).click();
  await expect(staged.getByText('Latest data import: Ready to restore')).toBeVisible();
  const stagedReadiness = staged.getByRole('region', { name: `Deployment readiness for ${name}` });
  await stagedReadiness.getByRole('button', { name: 'Check deployment readiness' }).click();
  const stagedTransfer = stagedReadiness.getByRole('region', { name: 'Data transfer on the target' });
  await expect(stagedTransfer.getByText('/data', { exact: true })).toBeVisible();
  await expect(stagedTransfer.getByText('Ready to restore')).toBeVisible();
  await expect(stagedReadiness.getByText('Finish or cancel pending data imports before deploying.')).toBeVisible();
  expect(writes).toHaveLength(writesAfterUpload);
  await staged.getByRole('link', { name: `Import a volume archive into ${name}` }).click();
  await importer.getByRole('button', { name: 'Restore archive' }).click();
  const confirm = page.getByRole('dialog', { name: 'Restore primary volume' });
  await expect(confirm).toContainText(target);
  expect(writes.filter((path) => path.endsWith('/start'))).toEqual([]);
  await confirm.getByRole('button', { name: 'Confirm restore' }).click();
  await expect(importer.getByText('Completed', { exact: true })).toBeVisible({ timeout: 90_000 });
  const jobs = await apiList<{ id: number; status: string; sha256: string; safetyBackupId: number }>(page, `/v1/services/${service.id}/volume-imports`);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ status: 'completed', sha256, safetyBackupId: expect.any(Number) });
  const backups = await apiList<{ id: number; label: string; status: string }>(page, `/v1/volumes/${target}/backups`);
  expect(backups).toContainEqual(expect.objectContaining({ id: jobs[0]!.safetyBackupId, label: 'pre-import', status: 'completed' }));
  expect(helper(`${target}:/data:ro`, 'test ! -e /data/before.txt; readlink /data/current; cat /data/current; echo; stat -c "%u:%g:%a" /data/nested/file.txt').toString().trim())
    .toBe('nested/file.txt\nmigrated-data\n1234:1234:640');
  expect(await deploysOf(page, service.id)).toEqual([]);
  expect(writes.filter((path) => path.endsWith('/start'))).toHaveLength(1);
  const writesAfterRestore = writes.length;
  await page.goto('/new');
  const restored = await openPlan();
  await restored.getByRole('button', { name: 'Check import status' }).click();
  await expect(restored.getByText('Latest data import: Completed', { exact: true })).toBeVisible();
  const afterReadiness = restored.getByRole('region', { name: `Deployment readiness for ${name}` });
  await afterReadiness.getByRole('button', { name: 'Check deployment readiness' }).click();
  await expect(afterReadiness.getByRole('region', { name: 'Data transfer on the target' }).getByText('Completed', { exact: true })).toBeVisible();
  await expect(afterReadiness.getByText('Finish or cancel pending data imports before deploying.')).toHaveCount(0);
  expect(writes).toHaveLength(writesAfterRestore);
  w.assertClean();
});

test('migration cuts over only a deployed host whose DNS still matches at confirmation', async ({ page, layout }) => {
  test.setTimeout(300_000);
  const name = perLayout(layout, 'migration-cutover');
  const host = `${name}.e2e.test`;
  const wrong = 'migration-old.e2e.test';
  const httpOnly = `${name}-http.e2e.test`;
  const panel = process.env.ND_E2E_PANEL;
  if (!panel || !/^nd-e2e-panel-[a-f0-9]{8}$/.test(panel)) throw new Error('Cutover proof needs the disposable browser panel');
  const ipOf = (container: string) => execFileSync('docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
  const targetIp = ipOf(panel);
  const otherIp = ipOf(panel.replace('-panel-', '-git-'));
  expect(targetIp).not.toBe(otherIp);
  await page.goto('/new');
  const headers = { authorization: `Bearer ${await sessionToken(page)}` };
  const settings = '/v1/settings/dns-records';
  const previous = await apiGet<{ enabled: boolean; content: string | null }>(page, settings);
  const setDns = async (enabled: boolean, content: string | null) => {
    expect((await page.request.put(settings, { headers, data: { enabled, content: content ?? '' } })).ok()).toBe(true);
  };
  const w = watch(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/domains') && !['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${path}`);
  });

  try {
    await setDns(false, targetIp);
    const entry = plan.services[0]!;
    const file = { ...plan, databases: [], services: [{ ...entry, name, env: [], create: { ...entry.create, name },
      domains: [{ host, https: false }, { host: wrong, https: false }, { host: httpOnly, https: true },
        { host: 'original.e2e.test', https: true, sourceDefault: true }] }] };
    const open = async () => {
      await page.getByRole('button', { name: 'Review migration plan' }).click();
      const dialog = page.getByRole('dialog', { name: 'Review migration plan' });
      await dialog.getByLabel('Migration plan JSON').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
      return dialog;
    };
    const dialog = await open();
    await dialog.getByRole('button', { name: 'Prepare resources' }).click();
    await dialog.getByRole('button', { name: 'Create resources' }).click();
    const cutover = (hostname: string) => page.getByRole('region', { name: `Cutover for ${hostname}` });
    const target = cutover(host);
    const check = target.getByRole('button', { name: 'Check cutover' });
    const attach = target.getByRole('button', { name: 'Attach domain' });
    const confirm = target.getByRole('button', { name: 'Confirm domain cutover' });
    await check.click();
    await expect(target.getByText('Deploy this service successfully before cutover.')).toBeVisible();
    await expect(attach).toHaveCount(0);
    const { id } = await serviceByName(page, name);
    const domains = () => apiList<{ hostname: string; status: string; ssl: boolean }>(page, `/v1/services/${id}/domains`);
    const readiness = dialog.getByRole('region', { name: `Deployment readiness for ${name}` });
    await readiness.getByRole('button', { name: 'Check deployment readiness' }).click();
    const deployLink = readiness.getByRole('link', { name: 'Open deployments' });
    await expect(deployLink).toBeVisible();
    expect(await deploysOf(page, id)).toEqual([]);
    await deployLink.click();
    const [queued] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/v1/services/${id}/deploys`, { timeout: 15_000 }),
      page.getByRole('main').getByRole('button', { name: 'Deploy', exact: true }).click(),
    ]);
    expect(queued.ok()).toBe(true);
    await expect.poll(async () => (await deploysOf(page, id))[0]?.status, { timeout: 170_000 }).toBe('running');
    await page.goto('/new');
    await open();
    const wrongTarget = cutover(wrong);
    await wrongTarget.getByRole('button', { name: 'Check cutover' }).click();
    await expect(wrongTarget.getByText('At least one DNS address differs from the configured destination.')).toBeVisible();
    await expect(wrongTarget.getByText(otherIp, { exact: true })).toBeVisible();
    await expect(cutover('original.e2e.test')).toHaveCount(0);
    await check.click();
    await expect(target.getByText('Deployment and DNS are ready.')).toBeVisible();
    await attach.click();
    await expect(confirm).toBeVisible();
    expect(writes).toEqual([]);
    await setDns(false, otherIp);
    await confirm.click();
    await expect(target.getByText('At least one DNS address differs from the configured destination.')).toBeVisible();
    expect((await domains()).some((row) => row.hostname === host)).toBe(false);

    await setDns(false, targetIp);
    await check.click();
    await attach.click();
    await confirm.click();
    await expect(target.getByText('Domain is attached.')).toBeVisible();
    expect((await page.request.post(`/v1/services/${id}/domains`, { headers, data: { hostname: httpOnly, ssl: false } })).ok()).toBe(true);
    const protocolTarget = cutover(httpOnly);
    await protocolTarget.getByRole('button', { name: 'Check cutover' }).click();
    await expect(protocolTarget.getByText('The existing route uses HTTP. The plan requires HTTPS. Review it in Domains.')).toBeVisible();
    await expect(protocolTarget.getByRole('button', { name: 'Attach domain' })).toHaveCount(0);
    expect((await domains()).filter((row) => row.hostname === httpOnly)).toEqual([expect.objectContaining({ hostname: httpOnly, status: 'active', ssl: false })]);
    expect((await domains()).filter((row) => row.hostname === host)).toEqual([expect.objectContaining({ hostname: host, status: 'active', ssl: false })]);
    await expect.poll(async () => {
      const routes = await apiGet<{ http: Array<{ hostname: string; verdict: string }> }>(page, `/v1/services/${id}/routing`);
      return routes.http.find((route) => route.hostname === host)?.verdict;
    }, { timeout: 60_000 }).toBe('ok');
    await page.reload();
    await open();
    await check.click();
    await expect(target.getByText('Domain is attached.')).toBeVisible();
    await expect(target.getByText('DNS addresses match the configured destination.')).toBeVisible();
    await expect(target.getByText('The proxy configuration has a matching route.')).toBeVisible();
    await expect(target.getByRole('link', { name: 'Open routing details' })).toHaveAttribute('href', `/services/${id}?tab=network`);
    await setDns(false, otherIp);
    await check.click();
    await expect(target.getByText('At least one DNS address differs from the configured destination.')).toBeVisible();
    await expect(target.getByText('Domain is attached.')).toBeVisible();
    await expect(target.getByText('The proxy configuration has a matching route.')).toBeVisible();
    await expect(target.getByText(targetIp, { exact: true })).toBeVisible();
    await expect(attach).toHaveCount(0);
    expect((await domains()).filter((row) => row.hostname === host)).toEqual([expect.objectContaining({ hostname: host, status: 'active' })]);
    await setDns(false, targetIp);
    await check.click();
    await expect(target.getByText('DNS addresses match the configured destination.')).toBeVisible();
    expect(writes).toEqual([`POST /v1/services/${id}/domains/cutover`, `POST /v1/services/${id}/domains/cutover`]);
    w.assertClean();
  } finally {
    await setDns(previous.enabled, previous.content);
  }
});
