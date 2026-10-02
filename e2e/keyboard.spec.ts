import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { strings } from '../web/src/strings.js';
import { BOARDS, expect, httpErrors, signIn, taskFile, test, TOKEN } from './fixtures.js';

/** Keyboard drag and drop: Space picks up/drops, arrows move, Escape cancels; screen reader text. */

const auth = () => ({ Authorization: `Bearer ${TOKEN()}` });
const uniqueSlug = (base: string) => `${base}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const col = (name: string) => strings.board.columnName(name);
const s = strings.dnd;

async function createProject(request: APIRequestContext, slug: string, tasks: [string, string][]) {
  expect((await request.post('/api/projects', { headers: auth(), data: { name: slug, slug } })).status()).toBe(201);
  for (const [title, status] of tasks) {
    expect((await request.post(`/api/projects/${slug}/tasks`, { headers: auth(), data: { title, status } })).status()).toBe(201);
  }
}

async function serverOrder(request: APIRequestContext, slug: string, status: string) {
  const res = await request.get(`/api/projects/${slug}/tasks?status=${status}`, { headers: auth() });
  return ((await res.json()) as { title: string }[]).map((t) => t.title);
}

const column = (page: Page, project: string, name: string) =>
  page.getByRole('region', { name: project }).locator('section', { has: page.getByRole('heading', { name, exact: true }) });
/** The focusable card (not the dragged copy, which has tabindex -1). */
const card = (page: Page, title: string) => page.locator('article[tabindex="0"]', { has: page.getByRole('heading', { name: title, exact: true }) });
const liveRegion = (page: Page) => page.locator('[id^="DndLiveRegion-"][role="status"]');
const frontmatterStatus = async (file: string) => /^status: (.+)$/m.exec(await readFile(file, 'utf8'))?.[1];

async function openProject(page: Page, slug: string, firstTitle: string) {
  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.goto(`/p/${slug}`);
  await expect(card(page, firstTitle)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
}

/** Keyboard modality: put focus on a card, then everything else with page.keyboard. */
async function focusCard(page: Page, title: string) {
  await card(page, title).focus();
  await expect(card(page, title)).toBeFocused();
}

/**
 * Space on the focused card, then wait for "Picked up…" like a screen reader user would. dnd-kit's
 * KeyboardSensor starts listening for the next keys in a setTimeout after the pick-up, so a key fired
 * in the same instant (only a script can type that fast) would be missed.
 */
async function pickUp(page: Page) {
  await page.keyboard.press('Space');
  await expect(liveRegion(page)).toContainText('Picked up');
}

function countPatches(page: Page) {
  const patches: string[] = [];
  page.on('request', (r) => r.method() === 'PATCH' && patches.push(r.url()));
  return patches;
}

async function expectFocusedWithRing(target: Locator) {
  await expect(target).toBeFocused();
  await expect(target).toHaveCSS('outline-style', 'solid');
}

test.describe('keyboard drag and drop', () => {
  test('Tab to T-004, Space, Right, Space: saved as doing on disk, focus stays on the moved card', async ({ page }) => {
    const dir = path.join(BOARDS(), 'example', 'tasks');
    const saved = new Map<string, string>();
    for (const f of await readdir(dir)) saved.set(f, await readFile(path.join(dir, f), 'utf8'));
    try {
      await signIn(page);
      // Other tests create projects that sort before "Example": open it explicitly.
      await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
      await page.goto('/p/example');
      await expect(card(page, 'Sync list with API')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
      const target = card(page, 'Sync list with API');
      // Tab from the last control before the board: every project in the top bar is a Tab stop, and
      // other tests keep creating projects, so starting at the top made the count unbounded.
      await page.getByRole('button', { name: 'Sign out' }).focus();
      for (let i = 0; i < 20 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
      await expect(target).toBeFocused();
      await pickUp(page);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Space');
      await expect(column(page, 'Example', 'Doing').locator('article[tabindex="0"]', { hasText: 'Sync list with API' })).toBeVisible();
      await expect.poll(() => frontmatterStatus(taskFile('example', 'T-004-sync-list-with-api.md'))).toBe('doing');
      await expectFocusedWithRing(card(page, 'Sync list with API'));
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      for (const [f, raw] of saved) await writeFile(path.join(dir, f), raw);
    }
  });

  test('Up and Down reorder inside the column, matching the server', async ({ page, request }) => {
    const slug = uniqueSlug('kbd-reorder');
    await createProject(request, slug, [
      ['Alpha', 'todo'],
      ['Bravo', 'todo'],
      ['Charlie', 'todo'],
    ]);
    await openProject(page, slug, 'Alpha');
    await focusCard(page, 'Charlie');
    await pickUp(page);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp'); // against the top edge: no-op
    await page.keyboard.press('Space');
    await expect.poll(() => serverOrder(request, slug, 'todo')).toEqual(['Charlie', 'Alpha', 'Bravo']);
    await expectFocusedWithRing(card(page, 'Charlie'));
    await focusCard(page, 'Alpha');
    await pickUp(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await expect.poll(() => serverOrder(request, slug, 'todo')).toEqual(['Charlie', 'Bravo', 'Alpha']);
    await expect.poll(() => column(page, slug, 'Todo').locator('article h3').allTextContents()).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  test('arrows reach empty columns', async ({ page, request }) => {
    const slug = uniqueSlug('kbd-empty');
    await createProject(request, slug, [['Solo', 'todo']]);
    await openProject(page, slug, 'Solo');
    await focusCard(page, 'Solo');
    await pickUp(page);
    await page.keyboard.press('ArrowRight'); // empty Doing
    await page.keyboard.press('ArrowRight'); // empty Review
    await page.keyboard.press('Space');
    await expect.poll(() => serverOrder(request, slug, 'review')).toEqual(['Solo']);
    await expect(column(page, slug, 'Review').locator('article[tabindex="0"]')).toHaveCount(1);
    await expectFocusedWithRing(card(page, 'Solo'));
  });

  test('Escape cancels: no PATCH, the card is back and keeps focus', async ({ page, request }) => {
    const slug = uniqueSlug('kbd-cancel');
    await createProject(request, slug, [['Undecided', 'todo']]);
    await openProject(page, slug, 'Undecided');
    const patches = countPatches(page);
    await focusCard(page, 'Undecided');
    await pickUp(page);
    await page.keyboard.press('ArrowRight');
    await expect(column(page, slug, 'Doing').locator('li[data-sortable-file]')).toHaveCount(1); // moved while held
    await page.keyboard.press('Escape');
    await expect(column(page, slug, 'Todo').locator('article[tabindex="0"]', { hasText: 'Undecided' })).toBeVisible();
    await expect(column(page, slug, 'Doing').locator('article[tabindex="0"]')).toHaveCount(0);
    await expectFocusedWithRing(card(page, 'Undecided'));
    await page.waitForTimeout(600);
    expect(patches).toEqual([]);
  });

  test('Space, Space without moving sends no PATCH', async ({ page, request }) => {
    const slug = uniqueSlug('kbd-noop');
    await createProject(request, slug, [['Stay', 'todo']]);
    await openProject(page, slug, 'Stay');
    const patches = countPatches(page);
    await focusCard(page, 'Stay');
    await pickUp(page);
    await expect(liveRegion(page)).toHaveText(s.pickedUp('T-001', 'Stay', col('todo'), 1, 1));
    await page.keyboard.press('Space');
    await expect(liveRegion(page)).toHaveText(s.dropped('T-001', col('todo'), 1, 1));
    await page.waitForTimeout(600);
    expect(patches).toEqual([]);
    await expectFocusedWithRing(card(page, 'Stay'));
  });

  test('the live region says each step: picked up, moved, dropped, cancelled', async ({ page, request }) => {
    const slug = uniqueSlug('kbd-announce');
    await createProject(request, slug, [
      ['Spoken', 'todo'],
      ['Neighbour', 'doing'],
    ]);
    await openProject(page, slug, 'Spoken');
    // Instructions are attached to the card (hidden text), and the card keeps its own role.
    const spoken = card(page, 'Spoken');
    await expect(spoken).toHaveAttribute('aria-roledescription', s.roleDescription);
    expect(await spoken.getAttribute('role')).toBeNull();
    const describedBy = (await spoken.getAttribute('aria-describedby'))!;
    await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(s.instructions);
    await expect(liveRegion(page)).toHaveCount(1);

    await focusCard(page, 'Spoken');
    await pickUp(page);
    await expect(liveRegion(page)).toHaveText(s.pickedUp('T-001', 'Spoken', col('todo'), 1, 1));
    await page.keyboard.press('ArrowRight');
    await expect(liveRegion(page)).toHaveText(s.moved('T-001', col('doing'), 1, 2));
    await page.keyboard.press('ArrowDown');
    await expect(liveRegion(page)).toHaveText(s.moved('T-001', col('doing'), 2, 2));
    await page.keyboard.press('Space');
    await expect(liveRegion(page)).toHaveText(s.dropped('T-001', col('doing'), 2, 2));
    await expect.poll(() => serverOrder(request, slug, 'doing')).toEqual(['Neighbour', 'Spoken']);

    await focusCard(page, 'Spoken');
    await pickUp(page);
    await expect(liveRegion(page)).toHaveText(s.pickedUp('T-001', 'Spoken', col('doing'), 2, 2));
    await page.keyboard.press('ArrowRight');
    await expect(liveRegion(page)).toHaveText(s.moved('T-001', col('review'), 1, 1));
    await page.keyboard.press('Escape');
    await expect(liveRegion(page)).toHaveText(s.cancelled('T-001', col('doing')));
    await expect(liveRegion(page)).toHaveCount(1); // still one live region
  });

  test('one Tab stop per card', async ({ page, request }) => {
    const slug = uniqueSlug('kbd-tabstops');
    await createProject(request, slug, [
      ['First', 'todo'],
      ['Second', 'todo'],
      ['Third', 'doing'],
    ]);
    await openProject(page, slug, 'First');
    await focusCard(page, 'First');
    await page.keyboard.press('Tab');
    await expect(card(page, 'Second')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(card(page, 'Third')).toBeFocused();
    expect(await page.locator('li[data-sortable-file][tabindex]').count()).toBe(0);
    expect(await page.locator('article[role="button"]').count()).toBe(0);
  });
});

test.describe('keyboard drop that fails to save', () => {
  test.use({ expectedHttpErrors: httpErrors({ status: 401, url: /\/api\/session$/ }, { status: 500, url: /\/api\/projects\/[^/]+\/tasks\/[^/]+$/ }) });

  test('a 500 rolls back, shows the alert, announces the error and gives focus back to the card', async ({ page, request }) => {
    const slug = uniqueSlug('kbd-fail');
    await createProject(request, slug, [['Unlucky', 'todo']]);
    await openProject(page, slug, 'Unlucky');
    await page.route('**/api/projects/*/tasks/*', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal error' }) })
        : route.continue(),
    );
    await focusCard(page, 'Unlucky');
    await pickUp(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(page.getByRole('alert')).toContainText('Couldn’t move T-001');
    await expect(liveRegion(page)).toHaveText(s.saveFailed('T-001', col('todo')));
    await expect(column(page, slug, 'Todo').locator('article[tabindex="0"]', { hasText: 'Unlucky' })).toBeVisible();
    await expect(column(page, slug, 'Doing').locator('article[tabindex="0"]')).toHaveCount(0);
    await expectFocusedWithRing(card(page, 'Unlucky'));
    expect(await serverOrder(request, slug, 'todo')).toEqual(['Unlucky']);
  });
});
