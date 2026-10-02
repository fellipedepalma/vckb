import path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';

export { expect };

/** An HTTP error the test expects (Chromium logs every 4xx/5xx as a console error). */
export interface ExpectedHttpError {
  status: number;
  url: RegExp;
}

/**
 * Value for `test.use({ expectedHttpErrors: ... })`. Always use this: Playwright reads any array whose
 * second element is an object as a `[value, options]` tuple, so a plain list of two or more errors
 * would silently become just its first entry.
 */
export const httpErrors = (...errors: ExpectedHttpError[]): [ExpectedHttpError[], { scope: 'test' }] => [errors, { scope: 'test' }];

const RESOURCE_ERROR = /^Failed to load resource: the server responded with a status of (\d+)/;

/**
 * Every test fails if the page logs a console error or warning about CSP, throws, or triggers a
 * CSP violation. The session probe's 401 on the sign-in screen is expected by design.
 */
export const test = base.extend<{ expectedHttpErrors: ExpectedHttpError[]; guard: void }>({
  expectedHttpErrors: [[{ status: 401, url: /\/api\/session$/ }], { option: true }],
  guard: [
    async ({ page, expectedHttpErrors }, use) => {
      const problems: string[] = [];
      page.on('console', (msg) => {
        const text = msg.text();
        if (msg.type() === 'error') {
          const http = RESOURCE_ERROR.exec(text);
          const url = msg.location().url;
          if (http && expectedHttpErrors.some((e) => e.status === Number(http[1]) && e.url.test(url))) return;
          problems.push(`console.error: ${text} (${url})`);
        } else if (/content security policy|refused to/i.test(text)) {
          problems.push(`console.${msg.type()}: ${text}`);
        }
      });
      page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
      // Slow-CI simulation: VCKB_E2E_CPU_THROTTLE=4 makes the page's CPU 4x slower (Chromium CDP).
      const throttle = Number(process.env.VCKB_E2E_CPU_THROTTLE);
      if (throttle > 1) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      }
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
        });
      });
      await use();
      expect(problems, 'console errors, page errors or CSP violations').toEqual([]);
    },
    { auto: true },
  ],
});

export const TOKEN = () => process.env.E2E_TOKEN!;
export const BOARDS = () => process.env.E2E_BOARDS!;
export const taskFile = (project: string, file: string) => path.join(BOARDS(), project, 'tasks', file);

export async function signIn(page: Page, token = TOKEN()) {
  await page.goto('/');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Signs in and opens the example board. Tests must not rely on the default route: it opens the
 * first project by name, and other tests create projects that sort before "Example".
 */
export async function openExample(page: Page) {
  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.goto('/p/example');
  await expect(page.getByRole('heading', { name: 'Dark mode' })).toBeVisible();
}
