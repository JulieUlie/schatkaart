import { defineConfig, devices } from '@playwright/test';

// Everything runs against a local copy: Playwright starts `wrangler dev` with an empty local KV,
// so the sync tests never touch the real sync storage. TCGdex (card data and prices) is faked in
// the browser tests with page.route (tests/support/tcgdex.ts).
const PORT = 8792;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'en-GB', // prices are formatted with the browser's locale: "€327.41"
    serviceWorkers: 'block', // the app's offline cache would otherwise serve stale files between tests
    reducedMotion: 'reduce', // Schatje bobs and the start screen animates forever; the app turns that off for reduced motion
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'api', testDir: './tests/api' },
    { name: 'logic', testDir: './tests/logic', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium', testDir: './tests/ui', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', testDir: './tests/ui', grep: /@mobile/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `node -e "require('fs').rmSync('.wrangler/test-state',{recursive:true,force:true})" && npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to .wrangler/test-state`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
