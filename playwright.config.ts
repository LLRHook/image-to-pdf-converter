import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 5179);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  // Reuse a running `npx vite --port 5179` (several test runs share it); start one otherwise.
  webServer: { command: `npx vite --port ${PORT} --strictPort`, port: PORT, reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
