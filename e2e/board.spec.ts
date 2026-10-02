import { readFile, rm, writeFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { expect, httpErrors, openExample, signIn, taskFile, test, TOKEN } from './fixtures.js';

/**
 * The accent color as the browser computes it, derived from the --color-accent token (never
 * hard-coded): a throwaway element created and removed inside the same evaluate resolves it to rgb().
 */
async function accentColor(page: Page): Promise<string> {
  const rgb = await page.evaluate(() => {
    const token = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
    const probe = document.createElement('span');
    probe.style.color = token;
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return token ? computed : '';
  });
  expect(rgb, '--color-accent must be defined on :root').toMatch(/^rgb/);
  return rgb;
}

/** Moves focus with Tab (keyboard modality, so :focus-visible applies) until `target` has it. */
async function tabTo(page: Page, target: Locator, key: 'Tab' | 'Shift+Tab' = 'Tab', max = 300) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    if (await target.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(target).toBeFocused();
}

/** Focused: solid 2px ring in the accent color. Blurred: no visible ring. Web-first assertions retry. */
async function expectFocusRing(target: Locator, accent: string) {
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS('outline-style', 'solid');
  await expect(target).toHaveCSS('outline-width', '2px');
  await expect(target).toHaveCSS('outline-color', accent);
  await target.blur();
  await expect(target).not.toBeFocused();
  await expect(target).toHaveCSS('outline-style', 'none');
}

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
  test.use({ expectedHttpErrors: httpErrors({ status: 401, url: /\/api\/session$/ }) });

  test('a wrong token shows a clear error; the right one opens the board', async ({ page, request }) => {
    await expect(page.getByRole('alert')).toHaveCount(0);
    await signIn(page, 'definitely-not-the-token');
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveText(/doesn’t match/);
    await page.getByLabel('Access token').fill(process.env.E2E_TOKEN!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: /Review/ })).toBeVisible();
    // The default route opens the first project by name (other tests may have created some).
    const projects = (await (await request.get('/api/projects', { headers: { Authorization: `Bearer ${TOKEN()}` } })).json()) as { slug: string }[];
    await expect(page).toHaveURL(new RegExp(`/p/${projects[0].slug}$`));
  });

  test('the token is never stored in the browser', async ({ page, context }) => {
    await openExample(page);
    await expect(page.getByRole('heading', { name: /Review/ })).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(stored).not.toContain(process.env.E2E_TOKEN!);
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === 'vckb_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api' });
    expect(session!.value).not.toContain(process.env.E2E_TOKEN!);
  });

  test('sign-in layout does not jump when error appears', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', { name: 'Sign in' });
    await expect(heading).toBeVisible();
    
    const boxBefore = await heading.boundingBox();
    expect(boxBefore).not.toBeNull();
    
    await page.fill('input[name="token"]', 'wrong-token');
    await page.click('button[type="submit"]');
    
    await expect(page.getByRole('alert')).toBeVisible();
    
    const boxAfter = await heading.boundingBox();
    expect(boxAfter).not.toBeNull();
    
    expect(Math.abs(boxAfter!.y - boxBefore!.y)).toBeLessThanOrEqual(1);
  });
});

test.describe('board', () => {
  test('shows every column with its tasks, and the review column asks for approval', async ({ page }) => {
    await openExample(page);
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
    const reviewSection = page.getByRole('region', { name: 'Example' }).locator('section', { has: page.getByRole('heading', { name: /^Review/ }) });
    await expect(reviewSection.getByText('needs you', { exact: true }).or(reviewSection.getByText('NEEDS YOU', { exact: true }))).toBeVisible();
    
    const otherSections = page.getByRole('region', { name: 'Example' }).locator('section', { hasNot: page.getByRole('heading', { name: /^Review/ }) });
    await expect(otherSections.getByText('needs you', { exact: true }).or(otherSections.getByText('NEEDS YOU', { exact: true }))).toHaveCount(0);
    
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  });

  test('an agent editing a file on disk shows up without reloading (SSE)', async ({ page }) => {
    await openExample(page);
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
    await openExample(page);
    await expect(page.getByRole('heading', { name: 'Dark mode' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
    const file = taskFile('example', 'T-099-by-hand.md');
    await writeFile(file, '---\ntitle: Quick idea from an agent\nstatus: wip\n---\n');
    await expect(page.getByText(/This board has \d+ problems? in its files/)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByText('vckb doctor example', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'This task has problems in its file' })).toBeVisible();
    await rm(file);
    await expect(page.getByText(/This board has/)).toBeHidden();
  });
  test('columns divide the available width and fill the container on wide screens', async ({ page }) => {
    await openExample(page);
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole('heading', { name: 'Dark mode' })).toBeVisible();
      
      const container = page.getByRole('region', { name: 'Example' });
      const columns = container.locator('section');
      await expect(columns).toHaveCount(5);
      
      const contentWidth = await container.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      
      let sum = 0;
      for (let i = 0; i < 5; i++) {
        const box = await columns.nth(i).boundingBox();
        expect(box).not.toBeNull();
        sum += box!.width;
      }
      
      const totalWidth = sum + (4 * 16);
      console.log(`[Viewport ${width}] Content: ${contentWidth}px, Columns + Gaps: ${totalWidth}px`);
      expect(Math.abs(totalWidth - contentWidth)).toBeLessThanOrEqual(2);
      
      const isOverflowing = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(isOverflowing).toBe(false);
    }
  });

  test('card receives visible focus ring when navigating with Tab', async ({ page }) => {
    await openExample(page);
    await expect(page.getByRole('heading', { name: 'Dark mode' })).toBeVisible();
    const accent = await accentColor(page);
    const card = page.getByRole('article', { name: 'Dark mode' });
    await tabTo(page, card);
    await expectFocusRing(card, accent);
  });

  test('controls receive strict focus ring', async ({ page }) => {
    // Sign-in screen: the token field has focus on load; Tab reaches the button, Shift+Tab goes back.
    await page.goto('/');
    const token = page.getByLabel('Access token');
    const signInButton = page.getByRole('button', { name: 'Sign in' });
    await expect(token).toBeVisible();
    const accent = await accentColor(page);
    await tabTo(page, signInButton);
    await expectFocusRing(signInButton, accent);
    await tabTo(page, token, 'Shift+Tab');
    await expectFocusRing(token, accent);

    await token.fill(process.env.E2E_TOKEN!);
    await signInButton.click();
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
    await page.goto('/p/example');
    await expect(page.getByRole('heading', { name: 'Dark mode' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();

    const projectTab = page.getByRole('link', { name: 'Example', exact: true });
    await tabTo(page, projectTab);
    await expectFocusRing(projectTab, accent);

    const signOut = page.getByRole('button', { name: 'Sign out' });
    await tabTo(page, signOut);
    await expectFocusRing(signOut, accent);

    // "Show problems" only exists while the board has warnings: create a hand-made broken file.
    const file = taskFile('example', 'T-098-focus-check.md');
    await writeFile(file, '---\ntitle: Focus check\nstatus: wip\n---\n');
    try {
      const showProblems = page.getByRole('button', { name: 'Show problems' });
      await expect(showProblems).toBeVisible();
      await tabTo(page, showProblems);
      await expectFocusRing(showProblems, accent);
    } finally {
      await rm(file);
    }
    await expect(page.getByText(/This board has/)).toBeHidden();
  });
});

test.describe('sign-out', () => {
  test('returns to the sign-in screen and the session is gone after a reload', async ({ page }) => {
    await openExample(page);
    await expect(page.getByRole('heading', { name: /Review/ })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Access token')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Access token')).toBeVisible();
  });
});
