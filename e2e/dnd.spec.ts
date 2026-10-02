import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { BOARDS, expect, httpErrors, signIn, taskFile, test, TOKEN } from './fixtures.js';

/** Drag-and-drop with mouse and touch (keyboard comes later). */

const auth = () => ({ Authorization: `Bearer ${TOKEN()}` });

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

const card = (page: Page, title: string) => page.getByRole('article', { name: title, exact: true });

/** Titles of the cards in a column, top to bottom. */
const titlesIn = (page: Page, project: string, name: string) => column(page, project, name).locator('article h3').allTextContents();

const frontmatterStatus = async (file: string) => /^status: (.+)$/m.exec(await readFile(file, 'utf8'))?.[1];

async function openProject(page: Page, slug: string, firstTitle: string) {
  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.goto(`/p/${slug}`);
  await expect(card(page, firstTitle)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
}

/**
 * Mouse drag: press on `from`, move past the 8px threshold, optionally run `whileDragging`, then glide
 * to `to` (at a vertical fraction of its box: 0.1 = near its top) and release.
 */
async function mouseDrag(page: Page, from: Locator, to: Locator, { at = 0.5, whileDragging }: { at?: number; whileDragging?: () => Promise<void> } = {}) {
  const a = (await from.boundingBox())!;
  const sx = a.x + a.width / 2;
  const sy = a.y + a.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 12, { steps: 4 });
  await whileDragging?.();
  const b = (await to.boundingBox())!;
  const tx = b.x + b.width / 2;
  const ty = b.y + b.height * at;
  await page.mouse.move(tx, ty, { steps: 20 });
  await page.mouse.move(tx, ty + 2, { steps: 2 });
  await page.mouse.up();
}

test.describe('drag and drop with the mouse', () => {
  test('T-004 from Todo to Doing: the board updates and the file on disk has the new status', async ({ page }) => {
    // Shared example board: snapshot every task file and restore them afterwards.
    const dir = path.join(BOARDS(), 'example', 'tasks');
    const saved = new Map<string, string>();
    for (const f of await readdir(dir)) saved.set(f, await readFile(path.join(dir, f), 'utf8'));
    try {
      await signIn(page);
      await expect(card(page, 'Sync list with API')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
      // Read-only observer: counts card nodes inserted into Todo AFTER the drop (pointerup), i.e. the
      // card flashing back while the PATCH and the refetches land. (At drag start the card's own
      // placeholder is inserted there too; that is expected and not counted.)
      await column(page, 'Example', 'Todo').locator('ol').evaluate((ol) => {
        const w = window as unknown as { flashes: number; dropped: boolean };
        w.flashes = 0;
        w.dropped = false;
        window.addEventListener('pointerup', () => (w.dropped = true), { capture: true, once: true });
        new MutationObserver((records) => {
          if (!w.dropped) return;
          for (const r of records) for (const n of r.addedNodes) if (n instanceof Element && n.querySelector('article')) w.flashes++;
        }).observe(ol, { childList: true, subtree: true });
      });
      await mouseDrag(page, card(page, 'Sync list with API'), column(page, 'Example', 'Doing').locator('ol'), { at: 0.9 });
      await expect(column(page, 'Example', 'Doing').getByRole('article', { name: 'Sync list with API' })).toBeVisible();
      await expect(column(page, 'Example', 'Todo').getByRole('article')).toHaveCount(0);
      await expect.poll(() => frontmatterStatus(taskFile('example', 'T-004-sync-list-with-api.md'))).toBe('doing');
      // Let the PATCH refetch and the SSE refetch land, then check nothing flashed back into Todo.
      await page.waitForTimeout(1_000);
      expect(await page.evaluate(() => (window as unknown as { flashes: number }).flashes)).toBe(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      for (const [f, raw] of saved) await writeFile(path.join(dir, f), raw);
    }
  });

  test('reorders inside a column, up and down, matching the server', async ({ page, request }) => {
    await createProject(request, 'dnd-reorder', [
      ['Alpha', 'todo'],
      ['Bravo', 'todo'],
      ['Charlie', 'todo'],
    ]);
    await openProject(page, 'dnd-reorder', 'Alpha');
    // Up: Charlie onto the top part of Alpha -> first.
    await mouseDrag(page, card(page, 'Charlie'), card(page, 'Alpha'), { at: 0.2 });
    await expect.poll(() => titlesIn(page, 'dnd-reorder', 'Todo')).toEqual(['Charlie', 'Alpha', 'Bravo']);
    await expect.poll(() => serverOrder(request, 'dnd-reorder', 'todo')).toEqual(['Charlie', 'Alpha', 'Bravo']);
    // The drop animation (overlay copy) must be over before grabbing the card again.
    await expect(card(page, 'Charlie')).toHaveCount(1);
    // Down: Charlie onto the bottom part of Bravo -> last.
    await mouseDrag(page, card(page, 'Charlie'), card(page, 'Bravo'), { at: 0.8 });
    await expect.poll(() => titlesIn(page, 'dnd-reorder', 'Todo')).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await expect.poll(() => serverOrder(request, 'dnd-reorder', 'todo')).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('drops into empty columns (Review and Done)', async ({ page, request }) => {
    await createProject(request, 'dnd-empty', [
      ['Lonely', 'todo'],
      ['Other', 'todo'],
    ]);
    await openProject(page, 'dnd-empty', 'Lonely');
    await mouseDrag(page, card(page, 'Lonely'), column(page, 'dnd-empty', 'Review').locator('ol'));
    await expect(column(page, 'dnd-empty', 'Review').getByRole('article', { name: 'Lonely' })).toBeVisible();
    await expect.poll(() => serverOrder(request, 'dnd-empty', 'review')).toEqual(['Lonely']);
    await mouseDrag(page, card(page, 'Other'), column(page, 'dnd-empty', 'Done').locator('ol'));
    await expect.poll(() => serverOrder(request, 'dnd-empty', 'done')).toEqual(['Other']);
    await expect(column(page, 'dnd-empty', 'Todo').getByRole('article')).toHaveCount(0);
  });

  test('a click (or a move under 8px) never starts a drag nor sends a PATCH', async ({ page, request }) => {
    await createProject(request, 'dnd-click', [['Still', 'todo']]);
    await openProject(page, 'dnd-click', 'Still');
    const patches: string[] = [];
    page.on('request', (r) => r.method() === 'PATCH' && patches.push(r.url()));
    const box = (await card(page, 'Still').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 5, y + 3, { steps: 3 }); // under the 8px threshold
    await page.mouse.up();
    await page.waitForTimeout(800);
    expect(patches).toEqual([]);
    await expect(column(page, 'dnd-click', 'Todo').getByRole('article', { name: 'Still' })).toBeVisible();
  });
});

test.describe('failed moves roll back', () => {
  test.use({
    expectedHttpErrors: httpErrors(
      { status: 401, url: /\/api\/session$/ },
      { status: 500, url: /\/api\/projects\/[^/]+\/tasks\/[^/]+$/ },
      { status: 412, url: /\/api\/projects\/[^/]+\/tasks\/[^/]+$/ },
    ),
  });

  test('a 500 on the PATCH puts the card back and shows a dismissible alert', async ({ page, request }) => {
    await createProject(request, 'dnd-rollback', [['Fragile', 'todo']]);
    await openProject(page, 'dnd-rollback', 'Fragile');
    let patched = 0;
    await page.route('**/api/projects/*/tasks/*', (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patched++;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal error' }) });
    });
    await mouseDrag(page, card(page, 'Fragile'), column(page, 'dnd-rollback', 'Doing').locator('ol'));
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Couldn’t move T-001');
    await expect(alert).toContainText('It is back where it was');
    await expect(column(page, 'dnd-rollback', 'Todo').getByRole('article', { name: 'Fragile' })).toBeVisible();
    await expect(column(page, 'dnd-rollback', 'Doing').getByRole('article')).toHaveCount(0);
    expect(patched).toBe(1);
    expect(await serverOrder(request, 'dnd-rollback', 'todo')).toEqual(['Fragile']);
    await alert.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('412: the file changed on disk during the drag -> rollback, refetch and a clear message', async ({ page, request }) => {
    await createProject(request, 'dnd-conflict', [['Contested', 'todo']]);
    await openProject(page, 'dnd-conflict', 'Contested');
    const file = taskFile('dnd-conflict', 'T-001-contested.md');
    await mouseDrag(page, card(page, 'Contested'), column(page, 'dnd-conflict', 'Doing').locator('ol'), {
      // An agent edits the file while the card is in the air (its live refetch is held back).
      whileDragging: async () => {
        await writeFile(file, (await readFile(file, 'utf8')).replace('title: Contested', 'title: Contested (edited by an agent)'));
        await page.waitForTimeout(700);
      },
    });
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('T-001 changed on disk; the board was reloaded');
    // Refetched: the agent's title is shown, still in Todo; the server kept the agent's version.
    await expect(column(page, 'dnd-conflict', 'Todo').getByRole('article', { name: 'Contested (edited by an agent)' })).toBeVisible();
    await expect(column(page, 'dnd-conflict', 'Doing').getByRole('article')).toHaveCount(0);
    expect(await frontmatterStatus(file)).toBe('todo');
  });
});

test.describe('drag and drop with touch', () => {
  test.use({ hasTouch: true });

  test('long press then drag moves a card (CDP touch events)', async ({ page, request }) => {
    await createProject(request, 'dnd-touch', [['Touchy', 'todo']]);
    await openProject(page, 'dnd-touch', 'Touchy');
    const cdp = await page.context().newCDPSession(page);
    const a = (await card(page, 'Touchy').boundingBox())!;
    const b = (await column(page, 'dnd-touch', 'Doing').locator('ol').boundingBox())!;
    const touch = (type: string, x?: number, y?: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: y! }] } as never);
    const sx = a.x + a.width / 2;
    const sy = a.y + a.height / 2;
    await touch('touchStart', sx, sy);
    await page.waitForTimeout(350); // long press (sensor delay is 200ms)
    const steps = 20;
    const tx = b.x + b.width / 2;
    const ty = b.y + b.height / 2;
    for (let i = 1; i <= steps; i++) await touch('touchMove', sx + ((tx - sx) * i) / steps, sy + ((ty - sy) * i) / steps);
    await touch('touchEnd');
    await expect(column(page, 'dnd-touch', 'Doing').getByRole('article', { name: 'Touchy' })).toBeVisible();
    await expect.poll(() => serverOrder(request, 'dnd-touch', 'doing')).toEqual(['Touchy']);
  });

  test('a quick swipe (no long press) does not move the card', async ({ page, request }) => {
    await createProject(request, 'dnd-swipe', [['Swiped', 'todo']]);
    await openProject(page, 'dnd-swipe', 'Swiped');
    const patches: string[] = [];
    page.on('request', (r) => r.method() === 'PATCH' && patches.push(r.url()));
    const cdp = await page.context().newCDPSession(page);
    const a = (await card(page, 'Swiped').boundingBox())!;
    const sx = a.x + a.width / 2;
    const sy = a.y + a.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] } as never);
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + i * 30, y: sy }] } as never);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] } as never);
    await page.waitForTimeout(800);
    expect(patches).toEqual([]);
    await expect(column(page, 'dnd-swipe', 'Todo').getByRole('article', { name: 'Swiped' })).toBeVisible();
  });
});
