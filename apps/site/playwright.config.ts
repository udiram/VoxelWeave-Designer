import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results/playwright',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    colorScheme: 'light',
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'chromium-mobile', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } }
  ],
  webServer: {
    command: 'pnpm build && pnpm exec astro preview --host 0.0.0.0',
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: true,
    timeout: 120_000
  }
});
