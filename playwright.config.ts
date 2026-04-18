import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const TEST_DB = path.resolve(__dirname, 'data/e2e-test.db');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3123',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec next dev',
    url: 'http://127.0.0.1:3123',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DASHBOARD_DB_PATH: TEST_DB,
      NODE_ENV: 'development',
      PORT: '3123',
    },
  },
  globalSetup: path.resolve(__dirname, './tests/e2e/global-setup.ts'),
});
