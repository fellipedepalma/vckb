import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          include: ['web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
