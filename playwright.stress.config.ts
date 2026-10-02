import base from './playwright.config.js';

/**
 * Stress tests (`npm run test:e2e:stress`): long loops kept out of the normal suite. Same server,
 * boards copy and token as the e2e config; only the test location and timeouts change.
 */
export default {
  ...base,
  testDir: 'e2e/stress',
  testMatch: '**/*.stress.ts',
  timeout: 15 * 60_000,
};
