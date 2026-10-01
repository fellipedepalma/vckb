import { readFile, writeFile } from 'node:fs/promises';
import { expect, signIn, taskFile, test } from './fixtures.js';

test.describe('serving', () => {
  test('GET / returns the app shell with the CSP and security headers', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(res.headers()['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(await res.text()).toContain('<div id="root"></div>');
    // Client-side routes fall back to the shell; unknown API paths stay JSON 404s.
    expect((await request.get('/p/example')).status()).toBe(200);
    expect((await request.get('/api/nope')).status()).toBe(401);
    expect((await request.get('/assets/missing.js')).status()).toBe(404);
  });
});

test.describe('sign-in', () => {
  test.use({ expectedHttpErrors: [{ status: 401, url: /\/api\/session$/ }] });

  test('a wrong token shows a clear error; the right one opens the board', async ({ page }) => {
    await signIn(page, 'definitely-not-the-token');
    await expect(page.getByRole('alert')).toHaveText(/doesn’t match/);
    await page.getByLabel('Access token').fill(process.env.E2E_TOKEN!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: /Review/ })).toBeVisible();
    await expect(page).toHaveURL(/\/p\/example$/);
  });

  test('the token is never stored in the browser', async ({ page, context }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: /Review/ })).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(stored).not.toContain(process.env.E2E_TOKEN!);
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === 'vckb_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api' });
    expect(session!.value).not.toContain(process.env.E2E_TOKEN!);
  });
});

test.describe('board', () => {
  test('shows every column with its tasks, and the review column asks for approval', async ({ page }) => {
    await signIn(page);
    for (const [column, title] of [
      ['Backlog', 'Dark mode'],
      ['Todo', 'Sync list with API'],
      ['Doing', 'Add item form'],
      ['Review', 'Shopping list screen'],
      ['Done', 'Set up Vite + React project'],
    ]) {
      const section = page.getByRole('region', { name: 'Example' }).locator('section', { has: page.getByRole('heading', { name: new RegExp(`^${column}`) }) });
      await expect(section.getByRole('heading', { name: title })).toBeVisible();
    }
    await expect(page.getByText('needs you', { exact: true }).or(page.getByText('NEEDS YOU', { exact: true }))).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  });

  test('an agent editing a file on disk shows up without reloading (SSE)', async ({ page }) => {
    await signIn(page);
    // Board loaded and stream live before touching the file, so only SSE can explain the update.
    await expect(page.getByRole('heading', { name: 'Sync list with API', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
    const file = taskFile('example', 'T-004-sync-list-with-api.md');
    const raw = await readFile(file, 'utf8');
    await writeFile(file, raw.replace('title: Sync list with API', 'title: Sync list with API (edited by an agent)'));
    await expect(page.getByRole('heading', { name: 'Sync list with API (edited by an agent)' })).toBeVisible();
    await writeFile(file, raw);
    await expect(page.getByRole('heading', { name: 'Sync list with API', exact: true })).toBeVisible();
  });

  test('a hand-edited broken file shows the warnings banner with the doctor command', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Dark mode' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
    const file = taskFile('example', 'T-099-by-hand.md');
    await writeFile(file, '---\ntitle: Quick idea from an agent\nstatus: wip\n---\n');
    await expect(page.getByText(/This board has \d+ problems? in its files/)).toBeVisible();
    await expect(page.getByText('vckb doctor example', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'This task has problems in its file' })).toBeVisible();
    const { rm } = await import('node:fs/promises');
    await rm(file);
    await expect(page.getByText(/This board has/)).toBeHidden();
  });
});

test.describe('sign-out', () => {
  test('returns to the sign-in screen and the session is gone after a reload', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: /Review/ })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Access token')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Access token')).toBeVisible();
  });
});
