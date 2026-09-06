import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  outputDir: 'test-results',
  use: { browserName: 'chromium', locale: 'en-GB', timezoneId: 'Europe/Stockholm', trace: 'off', video: 'off', screenshot: 'off', storageState: { cookies: [], origins: [] } },
  projects: [
    { name: 'local-desktop', grepInvert: /@aws/, use: { viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' } },
    { name: 'local-mobile', grepInvert: /@aws/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, trace: 'retain-on-failure' } },
    { name: 'aws', grep: /@aws/, testIgnore: process.env.PORTAL_E2E_AWS === '1' ? [] : ['**/*'], use: { baseURL: process.env.PORTAL_E2E_AWS_URL, viewport: { width: 1280, height: 900 }, trace: 'off', video: 'off', screenshot: 'off' } },
  ],
});
