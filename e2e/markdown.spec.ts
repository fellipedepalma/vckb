import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Page } from '@playwright/test';
import { strings } from '../web/src/strings.js';
import { expect, signIn, taskFile, test, TOKEN } from './fixtures.js';

/** Markdown in the description: Edit / Preview tabs, safe rendering, the raw text is what is saved. */

const auth = () => ({ Authorization: `Bearer ${TOKEN()}` });
const uniqueSlug = (base: string) => `${base}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const d = strings.details;
const md = d.markdown;

async function createProject(request: APIRequestContext, slug: string, tasks: Record<string, unknown>[]) {
  expect((await request.post('/api/projects', { headers: auth(), data: { name: slug, slug } })).status()).toBe(201);
  for (const task of tasks) {
    expect((await request.post(`/api/projects/${slug}/tasks`, { headers: auth(), data: task })).status()).toBe(201);
  }
}

const card = (page: Page, title: string) => page.locator('article[tabindex="0"]', { has: page.getByRole('heading', { name: title, exact: true }) });
const dialog = (page: Page) => page.getByRole('dialog');
const description = (page: Page) => dialog(page).getByLabel(d.fields.description, { exact: true });
const tab = (page: Page, name: string) => dialog(page).getByRole('tab', { name, exact: true });
const preview = (page: Page) => dialog(page).getByRole('tabpanel', { name: md.preview });
const save = (page: Page) => dialog(page).getByRole('button', { name: d.save, exact: true });

async function openDetails(page: Page, slug: string, title: string) {
  await signIn(page);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await page.goto(`/p/${slug}`);
  await expect(card(page, title)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await card(page, title).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel(d.fields.title, { exact: true })).toBeFocused();
}

/** Types `text` in the Description and shows the Preview tab. */
async function previewOf(page: Page, text: string) {
  await description(page).fill(text);
  await tab(page, md.preview).click();
  await expect(preview(page)).toBeVisible();
}

/** What a browser made of the preview: forbidden elements, on* attributes, hrefs. */
const inspect = (page: Page) =>
  preview(page).evaluate((panel) => {
    const forbidden = 'script, iframe, frame, object, embed, img, svg, math, style, form, input, textarea, select, meta, base, link, video, audio, source, canvas';
    const urlAttrs = ['src', 'srcset', 'action', 'formaction', 'data', 'poster', 'xlink:href', 'background', 'ping'];
    const badAttrs: string[] = [];
    for (const el of panel.querySelectorAll('*')) {
      for (const name of el.getAttributeNames()) {
        if (name.startsWith('on') || urlAttrs.includes(name)) badAttrs.push(`${el.tagName}.${name}`);
      }
    }
    return {
      forbidden: [...panel.querySelectorAll(forbidden)].map((e) => e.tagName),
      badAttrs,
      hrefs: [...panel.querySelectorAll('[href]')].map((e) => `${e.tagName}:${e.getAttribute('href')}:${e.getAttribute('rel')}:${e.getAttribute('target')}`),
      text: panel.textContent ?? '',
    };
  });

const PAYLOADS = [
  '<script>window.__xss = 1</script>',
  '<img src="http://evil.example/p.png" onerror="window.__xss = 2">',
  '<iframe src="http://evil.example/frame"></iframe>',
  '<svg onload="window.__xss = 3"></svg>',
  "<style>@import 'http://evil.example/x.css'; body { display: none }</style>",
  '<form action="http://evil.example/post"><input name="x"></form>',
  '<meta http-equiv="refresh" content="0;url=http://evil.example/">',
  '<base href="http://evil.example/">',
  '<link rel="stylesheet" href="http://evil.example/y.css">',
  '[js](javascript:window.__xss=4)',
  '[mixed](JaVaScRiPt:window.__xss=5)',
  '[entity](&#106;avascript:window.__xss=6)',
  '[spaced]( javascript:window.__xss=7)',
  '[data](data:text/html,<script>window.__xss=8</script>)',
  '[vb](vbscript:msgbox(1))',
  '[file](file:///etc/passwd)',
  '[relative](//evil.example/rel)',
  '[ref][1]',
  '[1]: javascript:window.__xss=9',
  '<javascript:window.__xss=10>',
  '![remote](http://evil.example/track.png)',
  '![js](javascript:window.__xss=11)',
  '`<script>window.__xss = 12</script>`',
  '```\n<img src=x onerror="window.__xss = 13">\n```',
  '&lt;script&gt;window.__xss = 14&lt;/script&gt;',
  '[good](https://example.com/docs "t")',
];

test.describe('Markdown preview in the browser', () => {
  test('hostile text: nothing is injected, loaded, run or followed', async ({ page, request, context }) => {
    const slug = uniqueSlug('md-xss');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    const requests: string[] = [];
    const dialogs: string[] = [];
    const popups: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    page.on('dialog', (dlg) => {
      dialogs.push(`${dlg.type()}: ${dlg.message()}`);
      void dlg.dismiss();
    });
    context.on('page', (p) => popups.push(p.url()));
    await openDetails(page, slug, 'Alpha');
    const before = page.url();

    await previewOf(page, PAYLOADS.join('\n\n'));
    const seen = await inspect(page);
    expect(seen.forbidden).toEqual([]);
    expect(seen.badAttrs).toEqual([]);
    // Of all the links in the text, only the valid https one is a link.
    expect(seen.hrefs).toEqual(['A:https://example.com/docs:noopener noreferrer nofollow:_blank']);
    // The hostile text is on the page as text.
    for (const literal of [
      '<script>window.__xss = 1</script>',
      '<iframe src="http://evil.example/frame">',
      '[js](javascript:window.__xss=4)',
      md.image('remote', 'http://evil.example/track.png'),
      '<script>window.__xss = 14</script>', // from the entities
    ]) {
      expect(seen.text).toContain(literal);
    }

    // Clicking the text of a "link" does nothing.
    await preview(page).getByText('[js](javascript:window.__xss=4)', { exact: false }).first().click();
    await preview(page).getByText('<javascript:window.__xss=10>', { exact: false }).first().click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
    expect(page.url()).toBe(before);

    // No request left this machine, no dialog, no new tab.
    const external = requests.filter((u) => new URL(u).hostname !== '127.0.0.1');
    expect(external, 'requests to other hosts').toEqual([]);
    expect(dialogs).toEqual([]);
    expect(popups).toEqual([]);
    await expect(dialog(page)).toBeVisible(); // and the dialog is still here
  });

  test('a valid link has rel and target; images are text', async ({ page, request }) => {
    const slug = uniqueSlug('md-link');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openDetails(page, slug, 'Alpha');
    await previewOf(page, '[site](https://example.com/a?b=1&c=2) and [mail](mailto:me@example.com) ![cat](https://example.com/cat.png)');
    const link = preview(page).getByRole('link', { name: 'site' });
    await expect(link).toHaveAttribute('href', 'https://example.com/a?b=1&c=2');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    await expect(preview(page).getByRole('link', { name: 'mail' })).toHaveAttribute('href', 'mailto:me@example.com');
    await expect(preview(page).getByRole('link')).toHaveCount(2);
    await expect(preview(page)).toContainText(md.image('cat', 'https://example.com/cat.png'));
    await expect(preview(page).locator('img')).toHaveCount(0);
  });

  test('absurd text stays fast and the dialog keeps working', async ({ page, request }) => {
    const slug = uniqueSlug('md-absurd');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openDetails(page, slug, 'Alpha');
    // One second of a normal CPU: with VCKB_E2E_CPU_THROTTLE=N the page runs N times slower, so does the budget.
    const budget = 1000 * Math.max(1, Number(process.env.VCKB_E2E_CPU_THROTTLE) || 1);
    const cases: [string, string][] = [
      ['100,000 "["', '['.repeat(100_000)],
      ['100,000 "*"', '*'.repeat(100_000)],
      ['100,000 "_"', '_'.repeat(100_000)],
      ['2,000 list levels on one line', '- '.repeat(2_000) + 'x'],
      ['unbalanced brackets', '[a](b '.repeat(15_000)],
      ['5,000 nested ">"', '>'.repeat(5_000) + ' deep'],
    ];
    for (const [name, text] of cases) {
      await description(page).fill(text); // (edit tab is active whenever we get here)
      const started = Date.now();
      await tab(page, md.preview).click();
      await expect(preview(page)).toBeVisible();
      await page.evaluate(() => 1); // the page answers: it is not stuck
      expect(Date.now() - started, name).toBeLessThan(budget);
      const seen = await inspect(page);
      expect(seen.forbidden, name).toEqual([]);
      expect(seen.badAttrs, name).toEqual([]);
      if (name.includes('nested')) {
        // The parser gives up on this one: raw text and a notice.
        await expect(preview(page).getByRole('status')).toHaveText(md.renderFailed);
      }
      await tab(page, md.edit).click();
      await expect(description(page)).toHaveValue(text); // nothing was lost
    }
    // Still a working dialog.
    await dialog(page).getByLabel(d.fields.title, { exact: true }).fill('Still alive');
    await expect(dialog(page).getByLabel(d.fields.title, { exact: true })).toHaveValue('Still alive');
  });
});

test.describe('the tabs', () => {
  test('WAI-ARIA tabs: roles, arrows, Home and End, one tab stop, Tab goes to the panel', async ({ page, request }) => {
    const slug = uniqueSlug('md-tabs');
    await createProject(request, slug, [{ title: 'Alpha', description: 'Some **text**' }]);
    await openDetails(page, slug, 'Alpha');

    await expect(dialog(page).getByRole('tablist', { name: md.tabsLabel })).toBeVisible();
    await expect(dialog(page).getByRole('tab')).toHaveCount(2);
    await expect(dialog(page).getByRole('tabpanel')).toHaveCount(1); // the hidden panel is not exposed
    const edit = tab(page, md.edit);
    const prev = tab(page, md.preview);
    await expect(edit).toHaveAttribute('aria-selected', 'true');
    await expect(edit).toHaveAttribute('tabindex', '0');
    await expect(prev).toHaveAttribute('tabindex', '-1');
    // The first focus of the dialog is still the title.
    await expect(dialog(page).getByLabel(d.fields.title, { exact: true })).toBeFocused();

    await edit.focus();
    await page.keyboard.press('ArrowRight');
    await expect(prev).toBeFocused();
    await expect(prev).toHaveAttribute('aria-selected', 'true');
    await expect(prev).toHaveAttribute('tabindex', '0');
    await expect(edit).toHaveAttribute('tabindex', '-1');
    await expect(preview(page)).toContainText('Some text');
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(edit).toBeFocused();
    await expect(edit).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft'); // wraps back
    await expect(prev).toBeFocused();
    await page.keyboard.press('Home');
    await expect(edit).toBeFocused();
    await page.keyboard.press('End');
    await expect(prev).toBeFocused();
    await expect(prev).toHaveAttribute('aria-controls', (await preview(page).getAttribute('id'))!);
    expect(await preview(page).getAttribute('aria-labelledby')).toBe(await prev.getAttribute('id'));

    // From the tab list, Tab goes to the panel (the preview scrolls, so it is a stop), then on.
    await page.keyboard.press('Tab');
    await expect(preview(page)).toBeFocused();
    await edit.click();
    await edit.focus();
    await page.keyboard.press('Tab');
    await expect(description(page)).toBeFocused();
  });

  test('switching tabs is not a change; the text, selection and scroll survive; Esc closes at once', async ({ page, request }) => {
    const slug = uniqueSlug('md-keep');
    const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the description`).join('\n');
    await createProject(request, slug, [{ title: 'Alpha', description: long }]);
    await openDetails(page, slug, 'Alpha');
    const area = description(page);
    await area.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      ta.focus();
      ta.setSelectionRange(40, 75);
      ta.scrollTop = 120;
    });
    const view = () => area.evaluate((el) => ({ start: (el as HTMLTextAreaElement).selectionStart, end: (el as HTMLTextAreaElement).selectionEnd, top: (el as HTMLTextAreaElement).scrollTop }));
    const before = await view();
    expect(before.top).toBeGreaterThan(50);

    for (let i = 0; i < 3; i++) {
      await tab(page, md.preview).click();
      await expect(preview(page)).toContainText('line 1 of the description');
      await tab(page, md.edit).click();
      await expect(area).toBeVisible();
    }
    expect(await view()).toEqual(before);
    await expect(area).toHaveValue(long);
    await expect(dialog(page).getByRole('alert')).toHaveCount(0);

    await page.keyboard.press('Escape'); // nothing changed: no confirmation
    await expect(dialog(page)).toHaveCount(0);
  });

  test('"Nothing to preview" for an empty description', async ({ page, request }) => {
    const slug = uniqueSlug('md-empty');
    await createProject(request, slug, [{ title: 'Alpha' }]);
    await openDetails(page, slug, 'Alpha');
    await tab(page, md.preview).click();
    await expect(preview(page)).toHaveText(md.empty);
    await tab(page, md.edit).click();
    await description(page).fill('   \n  '); // blank is empty too
    await tab(page, md.preview).click();
    await expect(preview(page)).toHaveText(md.empty);
  });

  test('Save sends exactly the typed text, not the rendered one; Checklist and Agent notes stay byte for byte', async ({ page, request }) => {
    const slug = uniqueSlug('md-save');
    await createProject(request, slug, [{ title: 'Alpha', description: 'Before', checklist: [{ text: 'step one', done: true }, { text: 'step two', done: false }] }]);
    expect((await request.post(`/api/projects/${slug}/tasks/T-001/notes`, { headers: auth(), data: { text: 'a note' } })).ok()).toBe(true);
    const file = taskFile(slug, 'T-001-alpha.md');
    const tail = (raw: string) => raw.slice(raw.indexOf('## Checklist'));
    const before = await readFile(file, 'utf8');
    const patches: { description?: unknown; keys: string[] }[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH') {
        const body = r.postDataJSON() as Record<string, unknown>;
        patches.push({ description: body.description, keys: Object.keys(body) });
      }
    });
    await openDetails(page, slug, 'Alpha');

    const typed = '# Heading\n\nSome **bold** and a <b>tag</b> & [x](javascript:alert(1))\n\n- one\n- two\n\n```\ncode <script>\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    await description(page).fill(typed);
    await tab(page, md.preview).click();
    await expect(preview(page).getByRole('heading', { name: 'Heading' })).toBeVisible();
    await tab(page, md.edit).click();
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);

    expect(patches).toHaveLength(1);
    expect(patches[0].keys).toEqual(['description']);
    expect(patches[0].description).toBe(typed); // identical, character for character
    const after = await readFile(file, 'utf8');
    expect(after).toContain(`---\n${typed}\n\n## Checklist`);
    expect(tail(after)).toBe(tail(before));
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('wide code, a wide table and a long URL scroll inside the preview, never the page', async ({ page, request }) => {
    const slug = uniqueSlug('md-phone');
    await createProject(request, slug, [{ title: 'Alpha', status: 'backlog' }]);
    await openDetails(page, slug, 'Alpha');
    const text = [
      '```',
      'const aVeryLongLineOfCode = "x".repeat(200) + "and it just keeps going and going past the edge of the screen";',
      '```',
      '',
      '| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 | c11 | c12 |',
      '|----|----|----|----|----|----|----|----|----|-----|-----|-----|',
      '| aaaaaaaaaa | bbbbbbbbbb | cccccccccc | dddddddddd | eeeeeeeeee | ffffffffff | gggggggggg | hhhhhhhhhh | iiiiiiiiii | jjjjjjjjjj | kkkkkkkkkk | llllllllll |',
      '',
      `https://example.com/${'a-very-long-path-segment-'.repeat(12)}end`,
      '',
      'Averyveryverylongwordwithoutanyspacesatalltoforcetheoverflowwrapruleinthepreviewbox'.repeat(2),
    ].join('\n');
    await previewOf(page, text);

    const m = await page.evaluate(() => {
      const panel = document.querySelector('[role="tabpanel"][id$="panel-preview"]') as HTMLElement;
      const pre = panel.querySelector('pre') as HTMLElement;
      const table = panel.querySelector('table') as HTMLElement;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dialog: (document.querySelector('dialog') as HTMLElement).scrollWidth - (document.querySelector('dialog') as HTMLElement).clientWidth,
        panel: panel.scrollWidth - panel.clientWidth,
        preScrolls: pre.scrollWidth > pre.clientWidth,
        tableWrapperScrolls: (table.parentElement as HTMLElement).scrollWidth > (table.parentElement as HTMLElement).clientWidth,
      };
    });
    expect(m).toEqual({ page: 0, dialog: 0, panel: 0, preScrolls: true, tableWrapperScrolls: true });
    await expect(save(page)).toBeInViewport({ ratio: 1 });
    await expect(dialog(page).getByRole('button', { name: d.cancel, exact: true })).toBeInViewport({ ratio: 1 });
  });
});
