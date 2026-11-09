import { defineConfig, devices } from '@playwright/test';

/**
 * S7 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): browser journeys against a
 * panel started by scripts/smoke-browser-e2e.mjs (dind + the image under test).
 *
 * The journeys share one instance, so they run in order, in one worker:
 * `setup` creates the first admin through the real form and saves the session
 * (sessionStorage, see tests/fixtures.ts); the desktop journeys reuse it; `phone` walks the same pages at phone width.
 */
const baseURL = process.env.ND_BASE_URL;
if (!baseURL) throw new Error('ND_BASE_URL is not set: run scripts/smoke-browser-e2e.mjs, which starts the panel');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /01-setup\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'desktop',
      testMatch: /0[2-9]-.*\.spec\.ts/,
      testIgnore: /phone/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } },
    },
    {
      name: 'phone',
      testMatch: /phone\.spec\.ts/,
      dependencies: ['desktop'],
      use: { ...devices['Pixel 7'] },
    },
    // A5: README screenshots, only with ND_SCREENSHOTS=<dir> and --project=screens.
    {
      name: 'screens',
      testMatch: /screens\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
    },
  ],
});
