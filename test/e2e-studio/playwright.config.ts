import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  reportSlowTests: {
    max: 1,
    threshold: 60_000,
  },
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL ?? 'http://localhost:3004',
    // Capture screenshot on failure for CI debugging
    screenshot: 'only-on-failure',
    // Trace on first retry to diagnose flakes
    trace: 'on-first-retry',
  },
  // When PLAYWRIGHT_TEST_BASE_URL is not set, spin up the Vite dev server.
  // Set reuseExistingServer so a running `pnpm dev` in another terminal is reused.
  ...(process.env.PLAYWRIGHT_TEST_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter x-studio-example dev',
          url: 'http://localhost:3004',
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
