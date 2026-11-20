import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries, in CI or anywhere. A test that fails and then passes on a
  // retry is reported as `flaky` and leaves the check green, which throws away
  // the one observation the test exists to make (`docs/testing.md` §9). In the
  // three CI runs that #54 turned red, its hover scenario passed only on a
  // retry and was reported as flaky instead of failed.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:4173',
    // With no retries there is no first retry to trace, so the trace of the
    // failing run itself is kept and travels in the uploaded report.
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
});
