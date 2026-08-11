import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    // The SW's cache-first shell and PWA behaviors are covered manually
    // (see SPRINT.md Phase 0); blocking it keeps tests deterministic and
    // lets page.route() see every request.
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'node tests/serve.mjs',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
