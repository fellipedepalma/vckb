import react from '@vitejs/plugin-react';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests never read the real ~/.vckb/config.json: they look for it in a folder that does not exist.
const noConfig = { VCKB_CONFIG_DIR: path.join(os.tmpdir(), 'vckb-tests-without-config') };

export default defineConfig({
  test: {
    // In CI, failures also become GitHub annotations (readable through the public REST API, without
    // downloading logs), like the Playwright reporter in playwright.config.ts.
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    projects: [
      {
        test: {
          name: 'server',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          env: noConfig,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          env: noConfig,
        },
      },
    ],
  },
});
