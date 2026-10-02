import type { APIRequestContext, Page } from '@playwright/test';
import { strings } from '../../web/src/strings.js';
import { expect, signIn, test, TOKEN } from '../fixtures.js';

/**
 * Escape must always cancel a keyboard move. Loop: Tab to the card, Space (wait "Picked up"),
 * Right (wait "moved"), Escape (wait "cancelled"); then 0 PATCH and the card back in its column.
 * Run with VCKB_E2E_CPU_THROTTLE=4 or 6 to make timing problems show up.
 */

const ITERATIONS = Number(process.env.VCKB_STRESS_ITERATIONS ?? 40);
const auth = () => ({ Authorization: `Bearer ${TOKEN()}` });
const s = strings.dnd;
const col = (name: string) => strings.board.columnName(name);

async function setup(page: Page, request: APIRequestContext, base: string, tasks: [string, string][]) {
  const slug = `${base}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  expect((await request.post('/api/projects', { headers: auth(), data: { name: slug, slug } })).status()).toBe(201);
  for (const [title, status] of tasks) {
    expect((await request.post(`/api/projects/${slug}/tasks`, { headers: auth(), data: { title, status } })).status()).toBe(201);
  }
  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.goto(`/p/${slug}`);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  return slug;
}

const region = (page: Page) => page.locator('[id^="DndLiveRegion-"][role="status"]');
const cardIn = (page: Page, slug: string, column: string, title: string) =>
  page
    .getByRole('region', { name: slug })
    .locator('section', { has: page.getByRole('heading', { name: column, exact: true }) })
    .locator('article[tabindex="0"]', { hasText: title });

/** State dump attached to a failure, to tell "Escape ignored" apart from other problems. */
async function diagnose(page: Page, title: string) {
  return page.evaluate((t) => {
    const card = [...document.querySelectorAll('article[tabindex="0"]')].find((a) => a.textContent?.includes(t));
    return {
      region: document.querySelector('[id^="DndLiveRegion-"]')?.textContent,
      cardColumn: card?.closest('section')?.querySelector('h2')?.textContent ?? '(not found)',
      dragOverlayPresent: !!document.querySelector('article[tabindex="-1"]'),
      dropTargetHighlighted: !!document.querySelector('[data-drop-target]'),
      activeElement: (document.activeElement as HTMLElement | null)?.dataset?.cardFile ?? document.activeElement?.tagName,
    };
  }, title);
}

async function tabTo(page: Page, slug: string, column: string, title: string) {
  const target = cardIn(page, slug, column, title);
  for (let i = 0; i < 200 && !(await target.evaluate((el) => el === document.activeElement).catch(() => false)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

async function cancelLoop(page: Page, slug: string, title: string, from: string, origin: { position: number; total: number }) {
  const patches: string[] = [];
  page.on('request', (r) => r.method() === 'PATCH' && patches.push(r.url()));
  let ignored = 0;
  for (let i = 1; i <= ITERATIONS; i++) {
    await tabTo(page, slug, col(from), title);
    await page.keyboard.press('Space');
    await expect(region(page)).toHaveText(s.pickedUp('T-001', title, col(from), origin.position, origin.total));
    await page.keyboard.press('ArrowRight');
    await expect(region(page)).toContainText(' moved to ');
    await page.keyboard.press('Escape');
    try {
      await expect(region(page)).toHaveText(s.cancelled('T-001', col(from)));
    } catch {
      ignored++;
      const state = await diagnose(page, title);
      throw new Error(`iteration ${i}: Escape did not cancel. State: ${JSON.stringify(state)}`);
    }
    await expect(cardIn(page, slug, col(from), title)).toBeVisible();
    expect(patches, `iteration ${i}`).toEqual([]);
  }
  console.log(`[stress] ${ITERATIONS} iterations, Escape ignored ${ignored} times, PATCH sent ${patches.length}`);
}

test('Escape always cancels a keyboard move (no PATCH, card back)', async ({ page, request }) => {
  const slug = await setup(page, request, 'stress-cancel', [['Escapee', 'todo']]);
  await cancelLoop(page, slug, 'Escapee', 'todo', { position: 1, total: 1 });
});

test('Escape always cancels right after a keyboard drop was saved', async ({ page, request }) => {
  const slug = await setup(page, request, 'stress-after-drop', [
    ['Mover', 'todo'],
    ['Resident', 'doing'],
  ]);
  // A saved drop first (as in the e2e where Escape was once ignored), then the cancel loop.
  await tabTo(page, slug, col('todo'), 'Mover');
  await page.keyboard.press('Space');
  await expect(region(page)).toContainText('Picked up');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(region(page)).toHaveText(s.dropped('T-001', col('doing'), 2, 2));
  await expect
    .poll(async () => ((await (await request.get(`/api/projects/${slug}/tasks?status=doing`, { headers: auth() })).json()) as { title: string }[]).map((t) => t.title))
    .toEqual(['Resident', 'Mover']);
  await cancelLoop(page, slug, 'Mover', 'doing', { position: 2, total: 2 });
});
