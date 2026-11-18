/** N04 UI acceptance: actual source/auth/SDK, isolated protocol fixtures; no live panel, Docker or S3.
 * Requires the workspace install and e2e/ Playwright + Chromium. See scripts/README.md. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '../e2e/node_modules/@playwright/test/index.mjs';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href);
const output = resolve(process.argv.find(a => a.startsWith('--proof='))?.slice(8) ?? '.temp_files/pitr-ui');
mkdirSync(output, { recursive: true });
const proof = mkdtempSync(join(output, 'run-'));
console.log('Browser proof:', proof);
const fixturePlugin = {
  name: 'owned-n04-fixture',
  configureServer(server) {
    server.middlewares.use('/__n04_fixture', async (_req, res) => {
      const html = await server.transformIndexHtml(
        '/__n04_fixture',
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/@fs/${resolve('scripts/lib/pitr-ui-fixture.tsx').replaceAll('\\', '/')}"></script></body></html>`,
      );
      res.setHeader('content-type', 'text/html');
      res.end(html);
    });
  },
};
const vite = await createServer({
  root: resolve('apps/web'),
  configFile: resolve('apps/web/vite.config.ts'),
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('') },
  plugins: [fixturePlugin],
  resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [resolve('.')] } },
});
let browser;
const result = { passed: false, cases: [], consoleErrors: [], pageErrors: [], unexpectedRequests: [], cleanup: false };
const passed = s => {
  result.cases.push(s);
  console.log('PASS', s);
};
const empty = {
  settings: null,
  hasPassphrase: false,
  running: false,
  state: null,
  stream: null,
  archiveLagSeconds: null,
  retention: 'Remote checkpoints are not deleted automatically.',
};
const passphrase = 'fixture-only-off-host-passphrase';
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const [width, locale] of process.argv.includes('--phone-only')
    ? [[320, 'tr']]
    : [
        [1366, 'en'],
        [390, 'en'],
        [320, 'tr'],
      ]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(
      ({ locale }) => {
        sessionStorage.setItem('ninedeploy.token', 'fixture-token');
        localStorage.setItem('ninedeploy.locale', locale);
      },
      { locale },
    );
    const page = await context.newPage();
    page.on('console', m => {
      if (m.type() === 'error') result.consoleErrors.push(m.text());
    });
    page.on('pageerror', e => result.pageErrors.push(e.message));
    let state = structuredClone(empty),
      submitted = null,
      reads = 0;
    await page.route('**/*', async route => {
      const r = route.request(),
        url = new URL(r.url()),
        path = url.pathname;
      let body;
      if (url.origin !== origin) {
        result.unexpectedRequests.push('External request blocked');
        return route.abort('blockedbyclient');
      }
      if (!path.startsWith('/v1/')) return route.continue();
      if (path === '/v1/auth/me') body = { id: 1, email: 'operator@fixture.test', isOperator: true };
      else if (path === '/v1/databases/7/pitr')
        body = { databaseId: 7, available: true, enabled: true, baseBackupRunning: false, baseBackups: [{ label: 'base' }] };
      else if (path === '/v1/backup-destinations')
        body = [{ id: 2, name: 'Off-site', endpoint: 'https://store.fixture.test', region: 'eu', bucket: 'recovery', prefix: 'proof' }];
      else if (path === '/v1/databases/7/pitr/remote' && r.method() === 'PUT') {
        submitted = r.postDataJSON();
        assert.equal(submitted.passphrase, passphrase);
        assert.equal(submitted.mode, 'continuous');
        const { passphrase: _, ...settings } = submitted;
        state = {
          ...state,
          settings: { ...settings, archiveId: 'archive-fixture' },
          hasPassphrase: true,
          retention: 'Continuous archive: 7 days, boundary base and one-hour deletion grace.',
        };
        body = state;
      } else if (path === '/v1/databases/7/pitr/remote' && r.method() === 'GET') {
        reads++;
        body = state;
      } else if (path === '/v1/databases/7/pitr/remote/checkpoint') {
        state = { ...state, running: true };
        body = { started: true };
        setTimeout(() => {
          state = {
            ...state,
            running: false,
            archiveLagSeconds: 3,
            stream: {
              archiveId: 'archive-fixture',
              status: 'completed',
              attemptedAt: '2026-11-17T09:00:00Z',
              error: null,
              missingSegment: null,
              gcPending: 2,
              protection: {
                headKey: `proof/${'a-long-archive-path/'.repeat(8)}head.ndpi`,
                verifiedAt: '2026-11-17T09:00:00Z',
                ranges: [{ from: '2026-11-17T08:00:00Z', through: '2026-11-17T09:00:00Z' }],
              },
            },
          };
        }, 700);
      } else {
        result.unexpectedRequests.push(`${r.method()} ${path}`);
        return route.fulfill({ status: 500, json: { error: { message: 'Unexpected fixture request' } } });
      }
      await route.fulfill({ status: path.endsWith('/checkpoint') ? 202 : 200, json: body });
    });
    await page.goto(`${origin}/__n04_fixture`);
    const tr = locale === 'tr';
    await page.getByLabel(tr ? 'Arşiv hedefi' : 'Archive destination').selectOption('2');
    await page.getByRole('switch', { name: tr ? 'Uzak arşivleme' : 'Remote archiving' }).click();
    await page.getByLabel(tr ? 'Kurtarma parola ifadesi' : 'Recovery passphrase', { exact: true }).fill(passphrase);
    await page.getByLabel(tr ? 'Kurtarma parolasını doğrulayın' : 'Confirm recovery passphrase', { exact: true }).fill(passphrase);
    await page.getByRole('button', { name: tr ? 'Uzak arşivi kaydet' : 'Save remote archive', exact: true }).click();
    await expect(page.getByLabel(tr ? 'Kurtarma parola ifadesi' : 'Recovery passphrase', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: tr ? 'Arşivi şimdi gönder' : 'Ship archive now', exact: true }).click();
    await expect(page.getByText(tr ? 'Gönderiliyor; henüz doğrulanmadı' : 'Shipping; not yet verified', { exact: true })).toBeVisible();
    await expect(page.locator('code')).toContainText('head.ndpi', { timeout: 10000 });
    assert.ok(reads >= 3);
    assert.ok(submitted);
    assert.equal(
      await page.evaluate(
        secret => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }).includes(secret),
        passphrase,
      ),
      false,
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${width}px`);
    await page
      .getByText(tr ? 'Gönderim başladı; doğrulama bekleniyor.' : 'Shipment started; verification is pending.', { exact: true })
      .waitFor({ state: 'hidden', timeout: 10000 });
    await page.screenshot({ path: `${proof}/remote-${width}-${locale}.png`, fullPage: true });
    await page.getByLabel(tr ? 'Arşiv modu' : 'Archive mode').selectOption('checkpoint');
    await page.getByRole('button', { name: tr ? 'Uzak arşivi kaydet' : 'Save remote archive', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const bounds = await page.getByRole('dialog').evaluate(el => {
      const box = el.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        buttons: [...el.lastElementChild.querySelectorAll('button')].map(b => {
          const r = b.getBoundingClientRect();
          return { text: b.textContent, left: r.left, right: r.right };
        }),
      };
    });
    assert.ok(
      bounds.buttons.every(b => b.left >= bounds.left && b.right <= bounds.right),
      JSON.stringify({ width, footerBounds: bounds }),
    );
    await page.screenshot({ path: `${proof}/review-${width}-${locale}.png`, fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `review dialog overflow at ${width}px`,
    );
    passed(
      `${width}px ${locale}: actual component, auth and SDK, configure → admitted shipment → polled verification; no overflow or persisted passphrase`,
    );
    await context.close();
  }
  assert.deepEqual(result.consoleErrors, []);
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.unexpectedRequests, []);
  result.passed = true;
} catch (error) {
  result.error = error.message;
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  result.cleanup = true;
  writeFileSync(`${proof}/browser-result.json`, JSON.stringify(result, null, 2));
}
