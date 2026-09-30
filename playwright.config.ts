import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the production build (`npm run build` first) with a throwaway copy of
 * boards/example and a random token. The config runs once in the runner and again in each worker;
 * the ??= keeps the same boards dir and token for all of them (workers inherit the env).
 */
const PORT = Number(process.env.E2E_PORT ?? 18_900);
process.env.E2E_BOARDS ??= (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vckb-e2e-'));
  cpSync(path.resolve('boards/example'), path.join(dir, 'example'), { recursive: true });
  return dir;
})();
process.env.E2E_TOKEN ??= randomBytes(24).toString('hex');

export default defineConfig({
  testDir: 'e2e',
  // One server, one boards dir: tests run in order and must not step on each other.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalTeardown: './e2e/teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node dist/server/index.js',
    url: `http://127.0.0.1:${PORT}/api/session`,
    reuseExistingServer: false,
    stdout: 'pipe',
    env: {
      VCKB_TOKEN: process.env.E2E_TOKEN,
      VCKB_HOST: '127.0.0.1',
      VCKB_PORT: String(PORT),
      VCKB_BOARDS_DIR: process.env.E2E_BOARDS,
    },
  },
});
