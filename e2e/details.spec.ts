import { readFile, writeFile } from 'node:fs/promises';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { strings } from '../web/src/strings.js';
import { expect, httpErrors, signIn, taskFile, test, TOKEN } from './fixtures.js';

/** The task details dialog (edit an existing task): open, edit, save, errors, unsaved changes. */

const auth = () => ({ Authorization: `Bearer ${TOKEN()}` });
const uniqueSlug = (base: string) => `${base}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const d = strings.details;
/** The sign-in screen's session probe answers 401 by design. */
const SESSION = [{ status: 401, url: /\/api\/session$/ }] as const;

interface NewTask {
  title: string;
  status?: string;
  priority?: string;
  labels?: string[];
  description?: string;
  checklist?: { text: string; done: boolean }[];
}

async function createProject(request: APIRequestContext, slug: string, tasks: NewTask[]) {
  expect((await request.post('/api/projects', { headers: auth(), data: { name: slug, slug } })).status()).toBe(201);
  for (const task of tasks) {
    expect((await request.post(`/api/projects/${slug}/tasks`, { headers: auth(), data: task })).status()).toBe(201);
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
const dialog = (page: Page) => page.getByRole('dialog');
const field = (page: Page, name: string) => dialog(page).getByLabel(name, { exact: true });
const save = (page: Page) => dialog(page).getByRole('button', { name: d.save, exact: true });
const cancel = (page: Page) => dialog(page).getByRole('button', { name: d.cancel, exact: true });

async function openProject(page: Page, slug: string, firstTitle: string) {
  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.goto(`/p/${slug}`);
  await expect(card(page, firstTitle)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
}

async function openDetails(page: Page, title: string) {
  await card(page, title).click();
  await expect(dialog(page)).toBeVisible();
  await expect(field(page, d.fields.title)).toBeFocused();
}

function recordPatches(page: Page) {
  const sent: { url: string; body: Record<string, unknown>; ifMatch: string | undefined; start: number; end: number; status: number }[] = [];
  const open = new Map<unknown, (typeof sent)[number]>();
  page.on('request', (r) => {
    if (r.method() !== 'PATCH') return;
    const entry = { url: r.url(), body: r.postDataJSON(), ifMatch: r.headers()['if-match'], start: Date.now(), end: 0, status: 0 };
    sent.push(entry);
    open.set(r, entry);
  });
  page.on('response', (res) => {
    const entry = open.get(res.request());
    if (entry) Object.assign(entry, { end: Date.now(), status: res.status() });
  });
  return sent;
}

const frontmatter = async (file: string, key: string) => new RegExp(`^${key}: (.*)$`, 'm').exec(await readFile(file, 'utf8'))?.[1];

async function mouseDrag(page: Page, from: Locator, to: Locator, { at = 0.5 }: { at?: number } = {}) {
  const a = (await from.boundingBox())!;
  const sx = a.x + a.width / 2;
  const sy = a.y + a.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 12, { steps: 4 });
  const b = (await to.boundingBox())!;
  const tx = b.x + b.width / 2;
  const ty = b.y + b.height * at;
  await page.mouse.move(tx, ty, { steps: 20 });
  await page.mouse.move(tx, ty + 2, { steps: 2 });
  await page.mouse.up();
}

test.describe('opening the details', () => {
  test('a click and Enter open it with the fields filled in; the first field has focus', async ({ page, request }) => {
    const slug = uniqueSlug('det-open');
    await createProject(request, slug, [{ title: 'Alpha', priority: 'high', labels: ['ui', 'forms'], description: 'Some text', status: 'todo' }]);
    await openProject(page, slug, 'Alpha');

    await openDetails(page, 'Alpha'); // by click
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    await expect(dialog(page)).toHaveAccessibleName(/T-001/);
    await expect(dialog(page).getByRole('heading')).toContainText('T-001');
    await expect(field(page, d.fields.title)).toHaveValue('Alpha');
    await expect(field(page, d.fields.status)).toHaveValue('todo');
    await expect(field(page, d.fields.priority)).toHaveValue('high');
    await expect(field(page, d.fields.labels)).toHaveValue('ui, forms');
    await expect(field(page, d.fields.description)).toHaveValue('Some text');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Alpha')).toBeFocused();

    await page.keyboard.press('Enter'); // by keyboard
    await expect(dialog(page)).toBeVisible();
    await expect(field(page, d.fields.title)).toBeFocused();
    await expect(field(page, d.fields.title)).toHaveValue('Alpha');
  });

  test('Space still picks the card up; Enter only opens the details (never while carrying a card)', async ({ page, request }) => {
    const slug = uniqueSlug('det-space');
    await createProject(request, slug, [{ title: 'Alpha', status: 'todo' }]);
    await openProject(page, slug, 'Alpha');
    const patches = recordPatches(page);

    await card(page, 'Alpha').focus();
    await page.keyboard.press('Space');
    await expect(liveRegion(page)).toContainText('Picked up');
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.press('Enter'); // carrying the card: Enter does nothing
    await page.waitForTimeout(300);
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(liveRegion(page)).toContainText('cancelled');
    await expect(dialog(page)).toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    expect(await liveRegion(page).textContent()).not.toContain('Picked up Alpha');
    expect(patches).toEqual([]);
  });

  test('the screen reader instructions mention Enter', async ({ page, request }) => {
    const slug = uniqueSlug('det-hint');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openProject(page, slug, 'Alpha');
    expect(strings.dnd.instructions).toContain('Press Enter to open its details');
    await expect(page.locator('[id^="DndDescribedBy-"]').first()).toHaveText(strings.dnd.instructions);
  });

  test('dragging a card never opens the details, nor does dropping it', async ({ page, request }) => {
    const slug = uniqueSlug('det-drag');
    await createProject(request, slug, [{ title: 'Alpha', status: 'todo' }, { title: 'Beta', status: 'todo' }]);
    await openProject(page, slug, 'Alpha');

    // To another column.
    await mouseDrag(page, card(page, 'Alpha'), column(page, slug, 'Doing').locator('ol'), { at: 0.9 });
    await expect(column(page, slug, 'Doing').getByRole('article', { name: 'Alpha' })).toBeVisible();
    await page.waitForTimeout(700);
    await expect(dialog(page)).toHaveCount(0);

    // A little drag that ends on the same spot (a click event may follow it).
    const b = (await card(page, 'Beta').boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 20, b.y + b.height / 2 + 4, { steps: 5 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => serverOrder(request, slug, 'doing')).toEqual(['Alpha']);
  });

  test.describe('with touch', () => {
    test.use({ hasTouch: true });

    test('a quick tap opens it; a long press is still a drag and does not', async ({ page, request }) => {
      const slug = uniqueSlug('det-touch');
      await createProject(request, slug, [{ title: 'Tappy', status: 'todo' }, { title: 'Dragged', status: 'todo' }]);
      await openProject(page, slug, 'Tappy');
      const box = (await card(page, 'Tappy').boundingBox())!;
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(dialog(page)).toBeVisible();
      await expect(field(page, d.fields.title)).toHaveValue('Tappy');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toHaveCount(0);

      // Long press, drag into Doing, release: moved, and no dialog.
      const cdp = await page.context().newCDPSession(page);
      const touch = (type: string, x?: number, y?: number) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y: y! }] } as never);
      const a = (await card(page, 'Dragged').boundingBox())!;
      const target = (await column(page, slug, 'Doing').locator('ol').boundingBox())!;
      const sx = a.x + a.width / 2;
      const sy = a.y + a.height / 2;
      await touch('touchStart', sx, sy);
      await page.waitForTimeout(350);
      const tx = target.x + target.width / 2;
      const ty = target.y + target.height / 2;
      for (let i = 1; i <= 20; i++) await touch('touchMove', sx + ((tx - sx) * i) / 20, sy + ((ty - sy) * i) / 20);
      await touch('touchEnd');
      await expect(column(page, slug, 'Doing').getByRole('article', { name: 'Dragged' })).toBeVisible();
      await page.waitForTimeout(700);
      await expect(dialog(page)).toHaveCount(0);
    });
  });
});

test.describe('editing and saving', () => {
  test('title, priority, status, labels and description are saved; the card updates and keeps focus', async ({ page, request }) => {
    const slug = uniqueSlug('det-save');
    await createProject(request, slug, [
      { title: 'Alpha', status: 'todo', priority: 'high', labels: ['old'], description: 'Before' },
      { title: 'Beta', status: 'todo' },
      { title: 'Gamma', status: 'doing' },
    ]);
    await openProject(page, slug, 'Alpha');
    const patches = recordPatches(page);
    const file = taskFile(slug, 'T-001-alpha.md');
    const etagBefore = (await (await request.get(`/api/projects/${slug}/tasks/T-001`, { headers: auth() })).json()).etag as string;

    await openDetails(page, 'Alpha');
    await field(page, d.fields.title).fill('  Alpha renamed ');
    await field(page, d.fields.priority).selectOption('low');
    await field(page, d.fields.status).selectOption({ label: 'Doing' });
    await field(page, d.fields.labels).fill('ui, forms,, ui');
    await expect(dialog(page).getByRole('list', { name: d.labelsChips }).getByRole('listitem')).toHaveText(['ui', 'forms']);
    await field(page, d.fields.description).fill('Line one\n\nLine two');
    await save(page).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(column(page, slug, 'Doing').getByRole('article', { name: 'Alpha renamed' })).toBeVisible();
    await expect(card(page, 'Alpha renamed')).toBeFocused();
    await expect(card(page, 'Alpha renamed')).toContainText('forms');

    // Only what changed was sent, with the etag the task had; never body, checklist or position.
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({
      title: 'Alpha renamed',
      priority: 'low',
      status: 'doing',
      labels: ['ui', 'forms'],
      description: 'Line one\n\nLine two',
    });
    expect(patches[0].ifMatch).toBe(`"${etagBefore}"`);
    expect(patches[0].status).toBe(200);

    const raw = await readFile(file, 'utf8');
    expect(raw).toMatch(/^title: Alpha renamed$/m);
    expect(raw).toMatch(/^priority: low$/m);
    expect(raw).toMatch(/^status: doing$/m);
    expect(raw).toMatch(/^labels: \[ui, forms\]$/m);
    expect(raw).toContain('---\nLine one\n\nLine two\n');
    expect(raw).not.toContain('Before');
    // Status changed without a position: the server puts the card at the end of the new column.
    expect(await serverOrder(request, slug, 'doing')).toEqual(['Gamma', 'Alpha renamed']);
    expect(await serverOrder(request, slug, 'todo')).toEqual(['Beta']);
  });

  test('the checklist and the agent notes in the file stay byte for byte the same', async ({ page, request }) => {
    const slug = uniqueSlug('det-keep');
    await createProject(request, slug, [
      {
        title: 'Alpha',
        description: 'Original text',
        checklist: [
          { text: 'first step', done: true },
          { text: 'second step', done: false },
        ],
      },
    ]);
    for (const text of ['first note', 'second note with: colon']) {
      expect((await request.post(`/api/projects/${slug}/tasks/T-001/notes`, { headers: auth(), data: { text } })).ok()).toBe(true);
    }
    await openProject(page, slug, 'Alpha');
    const patches = recordPatches(page);
    const file = taskFile(slug, 'T-001-alpha.md');
    const before = await readFile(file, 'utf8');
    const tail = (raw: string) => raw.slice(raw.indexOf('## Checklist'));
    expect(tail(before)).toContain('second note with: colon');

    await openDetails(page, 'Alpha');
    await field(page, d.fields.title).fill('Alpha edited');
    await field(page, d.fields.description).fill('A new description\nwith two lines');
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Alpha edited')).toBeVisible();

    const after = await readFile(file, 'utf8');
    expect(after).toContain('A new description\nwith two lines');
    expect(after).not.toContain('Original text');
    expect(tail(after)).toBe(tail(before)); // byte for byte
    expect(Object.keys(patches[0].body).sort()).toEqual(['description', 'title']);
    // The card still shows its checklist progress.
    await expect(card(page, 'Alpha edited')).toContainText('1/2');
  });

  test('saving without changes closes without sending anything', async ({ page, request }) => {
    const slug = uniqueSlug('det-noop');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openProject(page, slug, 'Alpha');
    const patches = recordPatches(page);
    await openDetails(page, 'Alpha');
    await field(page, d.fields.title).fill('Alpha  '); // trailing spaces are no change
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Alpha')).toBeFocused();
    expect(patches).toEqual([]);
  });

  test('while saving the controls are disabled and "Saving…" is announced', async ({ page, request }) => {
    const slug = uniqueSlug('det-saving');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openProject(page, slug, 'Alpha');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route(`**/api/projects/${slug}/tasks/T-001`, async (route) => {
      if (route.request().method() === 'PATCH') await gate;
      await route.continue();
    });
    await openDetails(page, 'Alpha');
    await field(page, d.fields.title).fill('Alpha 2');
    await save(page).click();
    await expect(dialog(page).getByRole('status')).toHaveText(d.saving);
    for (const control of [field(page, d.fields.title), field(page, d.fields.status), field(page, d.fields.description), save(page), cancel(page)]) {
      await expect(control).toBeDisabled();
    }
    release();
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Alpha 2')).toBeFocused();
  });

  test('a save right after the dialog closes does not overlap a drag, and both use the right etags', async ({ page, request }) => {
    const slug = uniqueSlug('det-seq');
    await createProject(request, slug, [{ title: 'Alpha', status: 'todo' }, { title: 'Beta', status: 'todo' }, { title: 'Gamma', status: 'doing' }]);
    await openProject(page, slug, 'Alpha');
    const patches = recordPatches(page);

    await openDetails(page, 'Alpha');
    await field(page, d.fields.priority).selectOption('low');
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    // Straight away: drag Beta into Doing.
    await mouseDrag(page, card(page, 'Beta'), column(page, slug, 'Doing').locator('ol'), { at: 0.9 });
    await expect(column(page, slug, 'Doing').getByRole('article', { name: 'Beta' })).toBeVisible();
    await expect.poll(() => serverOrder(request, slug, 'doing')).toEqual(['Gamma', 'Beta']);
    await page.waitForTimeout(500);
    expect(patches.map((p) => p.status)).toEqual([200, 200]);
    expect(patches[0].body).toEqual({ priority: 'low' });
    expect(patches[1].body).toMatchObject({ status: 'doing' });
    expect(patches[1].start).toBeGreaterThanOrEqual(patches[0].end);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('an edit saved while a move is still being saved waits for it (one queue)', async ({ page, request }) => {
    const slug = uniqueSlug('det-queue');
    await createProject(request, slug, [{ title: 'Alpha', status: 'todo' }, { title: 'Beta', status: 'todo' }, { title: 'Gamma', status: 'doing' }]);
    await openProject(page, slug, 'Alpha');
    const patches = recordPatches(page);
    let first = true;
    await page.route(`**/api/projects/${slug}/tasks/*`, async (route) => {
      if (route.request().method() === 'PATCH' && first) {
        first = false;
        await new Promise((r) => setTimeout(r, 800)); // the move's save is slow
      }
      await route.continue();
    });

    await mouseDrag(page, card(page, 'Beta'), column(page, slug, 'Doing').locator('ol'), { at: 0.9 });
    await expect(column(page, slug, 'Doing').getByRole('article', { name: 'Beta' })).toBeVisible();
    // The move is still in flight: open Alpha, edit, save.
    await card(page, 'Alpha').click();
    await expect(dialog(page)).toBeVisible();
    await field(page, d.fields.title).fill('Alpha edited');
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(card(page, 'Alpha edited')).toBeVisible();

    expect(patches).toHaveLength(2);
    expect(patches[0].body).toMatchObject({ status: 'doing' });
    expect(patches[1].body).toEqual({ title: 'Alpha edited' });
    expect(patches[1].start).toBeGreaterThanOrEqual(patches[0].end); // never in parallel
    expect(patches.map((p) => p.status)).toEqual([200, 200]); // the renumbered etag was used: no 412
    expect(await serverOrder(request, slug, 'doing')).toEqual(['Gamma', 'Beta']);
    expect(await frontmatter(taskFile(slug, 'T-001-alpha.md'), 'title')).toBe('Alpha edited');
  });
});

test.describe('modal behaviour', () => {
  test('focus is trapped (Tab and Shift+Tab cycle), the page behind is inert, Esc closes and focus returns to the card', async ({ page, request }) => {
    const slug = uniqueSlug('det-focus');
    await createProject(request, slug, [{ title: 'Alpha', status: 'todo' }, { title: 'Beta', status: 'todo' }]);
    await openProject(page, slug, 'Alpha');
    await openDetails(page, 'Alpha');

    const where = () =>
      page.evaluate(() => {
        const dlg = document.querySelector('dialog')!;
        const el = document.activeElement as HTMLElement;
        return { inside: dlg.contains(el), name: el.getAttribute('aria-label') || el.id.replace(/^.*-/, '') || el.textContent?.trim() };
      });
    const forward: string[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const w = await where();
      expect(w.inside, `Tab ${i + 1}`).toBe(true);
      forward.push(String(w.name));
    }
    // It cycles: the sequence repeats with the length of the dialog's focus order (Title is where it started).
    const period = forward.indexOf(forward[0], 1);
    expect(period).toBeGreaterThan(3);
    expect(forward.slice(period, period + 3)).toEqual(forward.slice(0, 3));
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect((await where()).inside, `Shift+Tab ${i + 1}`).toBe(true);
    }
    // From the first control, Shift+Tab goes to the last (Save); from Save, Tab goes back to the first.
    await dialog(page).getByRole('button', { name: d.close }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(save(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: d.close })).toBeFocused();

    // The page behind does not receive the pointer: whatever sits over a card is the dialog (backdrop).
    const hit = await page.evaluate(() => {
      const art = document.querySelector('article[tabindex="0"]')!;
      const r = art.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { isCard: !!top?.closest('article'), modal: !!document.querySelector('dialog:modal') };
    });
    expect(hit).toEqual({ isCard: false, modal: true });

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Alpha')).toBeFocused();
  });

  test('Cancel and the close button give focus back to the card too', async ({ page, request }) => {
    const slug = uniqueSlug('det-return');
    await createProject(request, slug, [{ title: 'Alpha' }, { title: 'Beta' }]);
    await openProject(page, slug, 'Alpha');
    await openDetails(page, 'Beta');
    await cancel(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Beta')).toBeFocused();
    await openDetails(page, 'Alpha');
    await dialog(page).getByRole('button', { name: d.close }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(card(page, 'Alpha')).toBeFocused();
  });

  test('an empty title is refused in the field, with no request', async ({ page, request }) => {
    const slug = uniqueSlug('det-empty');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openProject(page, slug, 'Alpha');
    const patches = recordPatches(page);
    await openDetails(page, 'Alpha');
    for (const empty of ['', '   ']) {
      await field(page, d.fields.title).fill(empty);
      await save(page).click();
      await expect(dialog(page).getByText(d.errors.required)).toBeVisible();
      await expect(field(page, d.fields.title)).toHaveAttribute('aria-invalid', 'true');
      const describedBy = await field(page, d.fields.title).getAttribute('aria-describedby');
      expect(await page.locator(`[id="${describedBy}"]`).textContent()).toBe(d.errors.required);
      await expect(field(page, d.fields.title)).toBeFocused();
      await expect(dialog(page)).toBeVisible();
    }
    // Typing clears the error.
    await field(page, d.fields.title).fill('Alpha again');
    await expect(dialog(page).getByText(d.errors.required)).toHaveCount(0);
    expect(patches).toEqual([]);
  });

  test('an invalid label is refused in its field, with no request', async ({ page, request }) => {
    const slug = uniqueSlug('det-label');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openProject(page, slug, 'Alpha');
    const patches = recordPatches(page);
    await openDetails(page, 'Alpha');
    await field(page, d.fields.labels).fill('ok, -bad');
    await save(page).click();
    await expect(dialog(page).getByText(d.errors.badLabel('-bad'))).toBeVisible();
    await expect(field(page, d.fields.labels)).toBeFocused();
    expect(patches).toEqual([]);
  });

  test.describe('unsaved changes', () => {
    const closers: [string, (page: Page) => Promise<void>][] = [
      ['Cancel', (page) => cancel(page).click()],
      ['Escape', (page) => page.keyboard.press('Escape')],
      ['the close button', (page) => dialog(page).getByRole('button', { name: d.close }).click()],
      ['a click outside', (page) => page.mouse.click(4, 4)],
    ];

    for (const [name, close] of closers) {
      test(`${name}: closes at once when nothing changed`, async ({ page, request }) => {
        const slug = uniqueSlug('det-clean');
        await createProject(request, slug, [{ title: 'Alpha' }]);
        await openProject(page, slug, 'Alpha');
        await openDetails(page, 'Alpha');
        await close(page);
        await expect(dialog(page)).toHaveCount(0);
        await expect(card(page, 'Alpha')).toBeFocused();
      });

      test(`${name}: asks first when something changed; Keep editing keeps it, Discard closes without a request`, async ({ page, request }) => {
        const slug = uniqueSlug('det-dirty');
        await createProject(request, slug, [{ title: 'Alpha' }]);
        await openProject(page, slug, 'Alpha');
        const patches = recordPatches(page);
        await openDetails(page, 'Alpha');
        await field(page, d.fields.title).fill('Alpha, edited');
        await close(page);
        await expect(dialog(page)).toBeVisible();
        const alert = dialog(page).getByRole('alert');
        await expect(alert).toHaveCount(1);
        await expect(alert).toContainText(d.discard.title);
        await expect(alert.getByRole('button', { name: d.discard.keep })).toBeFocused();

        await alert.getByRole('button', { name: d.discard.keep }).click();
        await expect(alert).toHaveCount(0);
        await expect(field(page, d.fields.title)).toHaveValue('Alpha, edited');

        await close(page);
        await expect(alert).toContainText(d.discard.title);
        await dialog(page).getByRole('button', { name: d.discard.confirm }).click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(card(page, 'Alpha')).toBeFocused();
        expect(patches).toEqual([]);
      });
    }

    test('Escape twice does not slip past the confirmation: the second one means Keep editing', async ({ page, request }) => {
      const slug = uniqueSlug('det-esc2');
      await createProject(request, slug, [{ title: 'Alpha' }]);
      await openProject(page, slug, 'Alpha');
      await openDetails(page, 'Alpha');
      await field(page, d.fields.title).fill('Changed');
      await page.keyboard.press('Escape');
      await expect(dialog(page).getByRole('alert')).toContainText(d.discard.title);
      await page.keyboard.press('Escape');
      await expect(dialog(page).getByRole('alert')).toHaveCount(0);
      await expect(dialog(page)).toBeVisible();
      await expect(field(page, d.fields.title)).toHaveValue('Changed');
    });

    test('selecting text and releasing the mouse outside does not close it', async ({ page, request }) => {
      const slug = uniqueSlug('det-select');
      await createProject(request, slug, [{ title: 'Alpha', description: 'Some words here' }]);
      await openProject(page, slug, 'Alpha');
      await openDetails(page, 'Alpha');
      const box = (await field(page, d.fields.description).boundingBox())!;
      await page.mouse.move(box.x + 20, box.y + 12);
      await page.mouse.down();
      await page.mouse.move(2, 2, { steps: 8 });
      await page.mouse.up();
      await expect(dialog(page)).toBeVisible();
    });
  });
});

test.describe('errors inside the dialog', () => {
  test.describe('412', () => {
    test.use({ expectedHttpErrors: httpErrors(...SESSION, { status: 412, url: /\/tasks\/T-001$/ }) });

    test('a file changed on disk is never overwritten; Keep editing and Reload from disk', async ({ page, request }) => {
      const slug = uniqueSlug('det-412');
      await createProject(request, slug, [{ title: 'Alpha', description: 'Original' }]);
      await openProject(page, slug, 'Alpha');
      const file = taskFile(slug, 'T-001-alpha.md');
      await openDetails(page, 'Alpha');

      // An agent edits the file while the dialog is open.
      const agent = (await readFile(file, 'utf8')).replace('title: Alpha', 'title: Alpha by agent').replace('Original', 'Agent text');
      await writeFile(file, agent);
      await expect(page.locator('article h3', { hasText: 'Alpha by agent' })).toBeVisible(); // the board behind caught up

      await field(page, d.fields.description).fill('My edit');
      await save(page).click();
      const alert = dialog(page).getByRole('alert');
      await expect(alert).toHaveCount(1);
      await expect(alert).toContainText(d.conflict.title);
      expect(await readFile(file, 'utf8')).toBe(agent); // nothing was overwritten
      await expect(field(page, d.fields.description)).toHaveValue('My edit');
      await expect(alert.getByRole('button', { name: d.conflict.keep })).toBeFocused();

      await alert.getByRole('button', { name: d.conflict.keep }).click();
      await expect(alert).toHaveCount(0);
      await expect(field(page, d.fields.description)).toHaveValue('My edit');
      await save(page).click(); // still stale: refused again
      await expect(alert).toContainText(d.conflict.title);
      expect(await readFile(file, 'utf8')).toBe(agent);

      await alert.getByRole('button', { name: d.conflict.reload }).click();
      await expect(alert).toHaveCount(0);
      await expect(field(page, d.fields.title)).toHaveValue('Alpha by agent');
      await expect(field(page, d.fields.description)).toHaveValue('Agent text');
      await expect(dialog(page).getByRole('status')).toHaveText(d.reloaded);

      // Edit again from the reloaded state: now it saves.
      await field(page, d.fields.title).fill('After reload');
      await save(page).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect(card(page, 'After reload')).toBeFocused();
      expect(await frontmatter(file, 'title')).toBe('After reload');
      expect(await readFile(file, 'utf8')).toContain('Agent text');
    });
  });

  test.describe('409', () => {
    test.use({ expectedHttpErrors: httpErrors(...SESSION, { status: 409, url: /\/tasks\/T-001$/ }) });

    test('an ID shared by two files tells how to repair it', async ({ page, request }) => {
      const slug = uniqueSlug('det-409');
      await createProject(request, slug, [{ title: 'Dup' }]);
      const original = await readFile(taskFile(slug, 'T-001-dup.md'), 'utf8');
      await writeFile(taskFile(slug, 'T-001-twin.md'), original.replace('title: Dup', 'title: Twin'));
      await openProject(page, slug, 'Dup');
      await openDetails(page, 'Dup');
      await field(page, d.fields.title).fill('Dup renamed');
      await save(page).click();
      const alert = dialog(page).getByRole('alert');
      await expect(alert).toHaveCount(1);
      await expect(alert).toContainText(`vckb doctor ${slug} --fix`);
      await expect(field(page, d.fields.title)).toHaveValue('Dup renamed'); // nothing typed is lost
      expect(await readFile(taskFile(slug, 'T-001-dup.md'), 'utf8')).toBe(original);
    });
  });

  test.describe('400 and 5xx', () => {
    test.use({ expectedHttpErrors: httpErrors(...SESSION, { status: 400, url: /\/tasks\/T-001$/ }, { status: 500, url: /\/tasks\/T-001$/ }) });

    test('a 400 from the server is shown in the right field and keeps the dialog open', async ({ page, request }) => {
      const slug = uniqueSlug('det-400');
      await createProject(request, slug, [{ title: 'Alpha' }]);
      await openProject(page, slug, 'Alpha');
      await page.route(`**/api/projects/${slug}/tasks/T-001`, (route) =>
        route.request().method() === 'PATCH'
          ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid label: "x y"' }) })
          : route.continue(),
      );
      await openDetails(page, 'Alpha');
      await field(page, d.fields.labels).fill('fine');
      await save(page).click();
      await expect(dialog(page).getByText('invalid label: "x y"')).toBeVisible();
      await expect(field(page, d.fields.labels)).toBeFocused();
      await expect(field(page, d.fields.labels)).toHaveAttribute('aria-invalid', 'true');
      expect(await field(page, d.fields.labels).getAttribute('aria-describedby')).toContain('error');
      await expect(dialog(page).getByRole('alert')).toHaveCount(0);
      await expect(field(page, d.fields.labels)).toHaveValue('fine');
    });

    test('a 500 shows a message, keeps what was typed and Try again sends it', async ({ page, request }) => {
      const slug = uniqueSlug('det-500');
      await createProject(request, slug, [{ title: 'Alpha' }]);
      await openProject(page, slug, 'Alpha');
      let fail = true;
      await page.route(`**/api/projects/${slug}/tasks/T-001`, (route) => {
        if (route.request().method() === 'PATCH' && fail) {
          fail = false;
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk on fire' }) });
        }
        return route.continue();
      });
      await openDetails(page, 'Alpha');
      await field(page, d.fields.title).fill('Alpha again');
      await save(page).click();
      const alert = dialog(page).getByRole('alert');
      await expect(alert).toContainText('disk on fire');
      await expect(field(page, d.fields.title)).toHaveValue('Alpha again');
      await alert.getByRole('button', { name: d.retry }).click();
      await expect(dialog(page)).toHaveCount(0);
      expect(await frontmatter(taskFile(slug, 'T-001-alpha.md'), 'title')).toBe('Alpha again');
    });
  });

  test.describe('network', () => {
  test.use({ expectedHttpErrors: httpErrors(...SESSION, { status: 0, url: /\/tasks\/T-001$/ }) });

  test('a network failure keeps the dialog and what was typed; Try again works', async ({ page, request }) => {
    const slug = uniqueSlug('det-net');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openProject(page, slug, 'Alpha');
    let fail = true;
    await page.route(`**/api/projects/${slug}/tasks/T-001`, (route) => {
      if (route.request().method() === 'PATCH' && fail) {
        fail = false;
        return route.abort('connectionrefused');
      }
      return route.continue();
    });
    await openDetails(page, 'Alpha');
    await field(page, d.fields.title).fill('Alpha again');
    await save(page).click();
    const alert = dialog(page).getByRole('alert');
    await expect(alert).toContainText(d.network);
    await expect(field(page, d.fields.title)).toHaveValue('Alpha again');
    await alert.getByRole('button', { name: d.retry }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await frontmatter(taskFile(slug, 'T-001-alpha.md'), 'title')).toBe('Alpha again');
  });
  });
});

test.describe('the board behind', () => {
  test('keeps updating while the dialog is open and a refetch never touches the form', async ({ page, request }) => {
    const slug = uniqueSlug('det-sse');
    await createProject(request, slug, [{ title: 'Alpha', status: 'todo' }, { title: 'Beta', status: 'todo' }]);
    await openProject(page, slug, 'Alpha');
    await openDetails(page, 'Alpha');
    await field(page, d.fields.title).fill('My draft');
    await field(page, d.fields.labels).fill('draft-label');
    await field(page, d.fields.description).fill('typed but not saved');

    // Another card changes on disk, then this task's own file does.
    const beta = taskFile(slug, 'T-002-beta.md');
    await writeFile(beta, (await readFile(beta, 'utf8')).replace('title: Beta', 'title: Beta by agent'));
    await expect(page.locator('article h3', { hasText: 'Beta by agent' })).toBeVisible();
    const alpha = taskFile(slug, 'T-001-alpha.md');
    await writeFile(alpha, (await readFile(alpha, 'utf8')).replace('title: Alpha', 'title: Alpha on disk').replace('priority: medium', 'priority: high'));
    await expect(page.locator('article h3', { hasText: 'Alpha on disk' })).toBeVisible();
    await page.waitForTimeout(600); // let any further refetch land

    await expect(dialog(page)).toBeVisible();
    await expect(field(page, d.fields.title)).toHaveValue('My draft');
    await expect(field(page, d.fields.labels)).toHaveValue('draft-label');
    await expect(field(page, d.fields.description)).toHaveValue('typed but not saved');
    await expect(field(page, d.fields.priority)).toHaveValue('medium'); // the form still shows what it was opened with
    await expect(field(page, d.fields.description)).toBeFocused(); // and focus stayed where the user was typing
  });
});

test.describe('small screens and motion', () => {
  test.describe('390x844', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('the dialog fits, nothing scrolls sideways and Save and Cancel stay reachable', async ({ page, request }) => {
      const slug = uniqueSlug('det-phone');
      const longText = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of a long description`).join('\n');
      await createProject(request, slug, [{ title: 'Alpha', status: 'backlog', labels: ['a-rather-long-label-name', 'another-label'], description: longText }]);
      await openProject(page, slug, 'Alpha');
      // Regression: the visually hidden texts inside the scrolling board used to widen the whole page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await openDetails(page, 'Alpha');

      const box = (await dialog(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      expect(box.width).toBeGreaterThanOrEqual(370); // almost the whole screen
      const overflow = await page.evaluate(() => {
        const dlg = document.querySelector('dialog')!;
        return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, dialog: dlg.scrollWidth - dlg.clientWidth };
      });
      expect(overflow).toEqual({ page: 0, dialog: 0 });
      await expect(save(page)).toBeInViewport({ ratio: 1 });
      await expect(cancel(page)).toBeInViewport({ ratio: 1 });
      // The long description scrolls inside the dialog; the buttons did not move.
      await field(page, d.fields.description).focus();
      await page.keyboard.press('Control+End');
      await expect(save(page)).toBeInViewport({ ratio: 1 });
    });
  });

  test('the opening animation is skipped with prefers-reduced-motion', async ({ page, request }) => {
    const slug = uniqueSlug('det-motion');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openProject(page, slug, 'Alpha');
    const duration = () => dialog(page).evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openDetails(page, 'Alpha');
    expect(await duration()).toBeGreaterThan(0.05); // a short fade and slide
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDetails(page, 'Alpha');
    expect(await duration()).toBeLessThan(0.001);
  });

  test('no inline styles, no console errors, no CSP violations (the fixture fails the test otherwise)', async ({ page, request }) => {
    const slug = uniqueSlug('det-csp');
    await createProject(request, slug, [{ title: 'Alpha', labels: ['x'] }]);
    await openProject(page, slug, 'Alpha');
    await openDetails(page, 'Alpha');
    await field(page, d.fields.title).fill('Alpha 2');
    await field(page, d.fields.labels).fill('x, y');
    expect(await dialog(page).locator('[style]').count()).toBe(0);
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await openDetails(page, 'Alpha 2');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });
});
