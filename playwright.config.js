import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  fullyParallel: true,
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { height: 1000, width: 1440 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  reporter: 'list',
  testDir: './tests/e2e',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm start',
    reuseExistingServer: false,
    url: 'http://127.0.0.1:4173',
  },
});
