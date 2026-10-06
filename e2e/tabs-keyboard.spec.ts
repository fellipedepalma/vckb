import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { strings } from '../web/src/strings.js';
import { expect, signIn, test, TOKEN } from './fixtures.js';
import { runScenarios } from './tab-scenarios.js';

/**
 * The Edit / Preview tabs of the Description, used the way a person uses them: real mouse clicks and
 * real key presses, never a programmatic focus(). (A first version of the tab tests forced the focus,
 * which cannot tell "the keys do not work" from "the focus was somewhere else".)
 */

const auth = () => ({ Authorization: `Bearer ${TOKEN()}` });
const uniqueSlug = (base: string) => `${base}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const d = strings.details;
const md = d.markdown;

async function createProject(request: APIRequestContext, slug: string, tasks: Record<string, unknown>[]) {
  expect((await request.post('/api/projects', { headers: auth(), data: { name: slug, slug } })).status()).toBe(201);
  for (const task of tasks) expect((await request.post(`/api/projects/${slug}/tasks`, { headers: auth(), data: task })).status()).toBe(201);
}

/** Signs in, opens the board and opens the details of `title` with a real click. */
async function openWithTheMouse(page: Page, slug: string, title: string) {
  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.goto(`/p/${slug}`);
  const card = page.locator('article[tabindex="0"]', { has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(card).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  const box = (await card.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel(d.fields.title, { exact: true })).toBeFocused();
}

/** The accent colour as the browser computes it, from the --color-accent token. */
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

async function expectMintRing(target: Locator, accent: string) {
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS('outline-style', 'solid');
  await expect(target).toHaveCSS('outline-width', '2px');
  await expect(target).toHaveCSS('outline-color', accent);
}

test.describe('the Description tabs, with a real keyboard and mouse', () => {
  // A short window, so the dialog body really scrolls (that is where Home/End could do harm).
  test.use({ viewport: { width: 1100, height: 560 } });

  test('A to E: Tab to the tab, arrows, Home, End, the mouse, the textarea, the preview panel', async ({ page, request }) => {
    const slug = uniqueSlug('tabs-kbd');
    await createProject(request, slug, [{ title: 'Alpha', description: 'Some **markdown**' }]);
    await openWithTheMouse(page, slug, 'Alpha');

    const { rows, tabsToReachEdit, notes } = await runScenarios(page);

    expect(tabsToReachEdit, 'Tab presses from the Title to the Edit tab (Status, Priority, Labels, Edit)').toBe(4);
    const failed = rows.filter((r) => !r.ok).map((r) => `${r.scenario} ${r.key}: wanted ${r.expected.focus} / ${r.expected.selected}, got ${r.observed.focus} / ${r.observed.tabs} / ${r.observed.panel}`);
    expect(failed, notes.join('; ')).toEqual([]);
    expect(rows.map((r) => r.scenario)).toEqual(expect.arrayContaining(['A', 'B', 'C', 'D', 'E']));
    // Home and End on the tabs scroll neither the page nor the dialog.
    for (const note of notes.filter((n) => /on the tabs/.test(n))) {
      const [, page0, page1, dialog0, dialog1] = /page scroll (\d+)->(\d+), dialog (\d+)->(\d+)/.exec(note)!;
      expect([page1, dialog1]).toEqual([page0, dialog0]);
    }
  });

  test('the help under the Description names the arrows and is tied to the tab list', async ({ page, request }) => {
    const slug = uniqueSlug('tabs-hint');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openWithTheMouse(page, slug, 'Alpha');
    expect(d.descriptionHint).toBe('Markdown. Use ← → on the Edit/Preview tabs to switch. The checklist and the agent notes in the file are left untouched.');
    const hint = page.getByRole('dialog').getByText(d.descriptionHint, { exact: true });
    await expect(hint).toBeVisible();
    const hintId = await hint.getAttribute('id');
    await expect(page.getByRole('dialog').getByRole('tablist')).toHaveAttribute('aria-describedby', hintId!);
    await expect(page.getByRole('dialog').getByLabel(d.fields.description, { exact: true })).toHaveAttribute('aria-describedby', new RegExp(hintId!)); // the textarea too
    await expect(page.getByRole('dialog').getByRole('tablist')).toHaveAccessibleDescription(d.descriptionHint);
  });

  test('the tabs and the preview panel show the mint focus ring when reached with the keyboard', async ({ page, request }) => {
    const slug = uniqueSlug('tabs-ring');
    await createProject(request, slug, [{ title: 'Alpha', description: 'Text' }]);
    await openWithTheMouse(page, slug, 'Alpha');
    const accent = await accentColor(page);
    const dialog = page.getByRole('dialog');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab'); // Status, Priority, Labels, the Edit tab
    await expectMintRing(dialog.getByRole('tab', { name: md.edit }), accent);
    await page.keyboard.press('ArrowRight');
    await expectMintRing(dialog.getByRole('tab', { name: md.preview }), accent);
    await page.keyboard.press('Tab');
    await expectMintRing(dialog.getByRole('tabpanel', { name: md.preview }), accent);
    // The ring is not left behind when the focus moves on.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('tabpanel', { name: md.preview })).not.toBeFocused();
    await expect(dialog.getByRole('tabpanel', { name: md.preview })).toHaveCSS('outline-style', 'none');
  });
});
