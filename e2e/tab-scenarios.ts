import type { Page } from '@playwright/test';
import { strings } from '../web/src/strings.js';

/**
 * Keyboard and mouse scenarios for the Edit / Preview tabs of the Description, driven the way a person
 * does it: real clicks (page.mouse) and real keys (page.keyboard). Nothing here calls .focus() or
 * dispatches an event. Shared by the permanent e2e (e2e/tabs-keyboard.spec.ts, which asserts) and by
 * a one-off script that replays them against the demo server (which only prints the table).
 */

const md = strings.details.markdown;

export interface Observed {
  /** The focused element: `button[role=tab] "Edit"`, `textarea "Description"`, `div[role=tabpanel] "Preview"`... */
  focus: string;
  /** `Edit=true:0 Preview=false:-1`: aria-selected and tabindex of each tab. */
  tabs: string;
  /** The visible tab panel(s). */
  panel: string;
  /** Scroll offsets of the page and of the dialog's body, to see that a key did not scroll them. */
  scroll: { page: number; dialog: number; preview: number };
  caret: [number, number];
}

export interface Row {
  scenario: string;
  key: string;
  expected: { focus: string; selected: 'Edit' | 'Preview' };
  observed: Observed;
  ok: boolean;
}

export async function observe(page: Page): Promise<Observed> {
  return page.evaluate(() => {
    const dialog = document.querySelector('dialog') as HTMLElement;
    const active = document.activeElement as HTMLElement | null;
    // (No named inner functions: tsx would wrap them in a helper that does not exist in the page.)
    const labelled = active?.getAttribute('aria-labelledby');
    const name = active
      ? (active.getAttribute('aria-label') ??
        (labelled ? document.getElementById(labelled)?.textContent : null) ??
        (active as HTMLInputElement).labels?.[0]?.textContent ??
        active.textContent?.trim().slice(0, 24) ??
        '')
      : '';
    const focus = active ? `${active.tagName.toLowerCase()}${active.getAttribute('role') ? `[role=${active.getAttribute('role')}]` : ''} "${name}"` : 'none';
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((t) => `${t.textContent}=${t.getAttribute('aria-selected')}:${t.getAttribute('tabindex')}`).join(' ');
    const panel = [...dialog.querySelectorAll('[role="tabpanel"]')]
      .filter((p) => !(p as HTMLElement).hidden)
      .map((p) => document.getElementById(p.getAttribute('aria-labelledby') ?? '')?.textContent)
      .join(',');
    const body = dialog.querySelector('.overflow-y-auto') as HTMLElement;
    const preview = dialog.querySelector('[role="tabpanel"][id$="panel-preview"]') as HTMLElement;
    const area = dialog.querySelector('textarea') as HTMLTextAreaElement;
    return {
      focus,
      tabs,
      panel,
      scroll: { page: document.scrollingElement?.scrollTop ?? 0, dialog: body?.scrollTop ?? 0, preview: preview?.scrollTop ?? 0 },
      caret: [area.selectionStart, area.selectionEnd] as [number, number],
    };
  });
}

const tabsText = (selected: 'Edit' | 'Preview') => `${md.edit}=${selected === 'Edit'}:${selected === 'Edit' ? 0 : -1} ${md.preview}=${selected === 'Preview'}:${selected === 'Preview' ? 0 : -1}`;
const tabFocus = (name: 'Edit' | 'Preview') => `button[role=tab] "${name}"`;

/** Presses `key` and records what the page looks like, against what a person expects. */
export async function press(page: Page, rows: Row[], scenario: string, key: string, expected: Row['expected']) {
  await page.keyboard.press(key);
  const observed = await observe(page);
  const ok = observed.focus === expected.focus && observed.tabs === tabsText(expected.selected) && observed.panel === expected.selected;
  rows.push({ scenario, key, expected, observed, ok });
  return observed;
}

/** A real mouse click on the middle of an element, after scrolling it into view like a person would. */
async function clickCenter(page: Page, selector: string) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** A, B, C, D, E in order. The dialog for the task must be open with the first field (Title) focused. */
export async function runScenarios(page: Page): Promise<{ rows: Row[]; tabsToReachEdit: number; notes: string[] }> {
  const rows: Row[] = [];
  const notes: string[] = [];
  const edit = { focus: tabFocus('Edit'), selected: 'Edit' as const };
  const preview = { focus: tabFocus('Preview'), selected: 'Preview' as const };
  const area = 'dialog textarea';
  const tabEdit = 'dialog [role="tab"]:nth-child(1)';
  const tabPreview = 'dialog [role="tab"]:nth-child(2)';

  // A: from the Title with Tab to the Edit tab, then the arrows.
  let tabs = 0;
  for (; tabs < 12; tabs++) {
    await page.keyboard.press('Tab');
    if ((await observe(page)).focus === tabFocus('Edit')) {
      tabs++;
      break;
    }
  }
  rows.push({ scenario: 'A', key: `Tab x${tabs}`, expected: edit, observed: await observe(page), ok: (await observe(page)).focus === edit.focus });
  for (const [key, want] of [['ArrowRight', preview], ['ArrowLeft', edit], ['End', preview], ['Home', edit], ['ArrowRight', preview], ['ArrowRight', edit]] as const) {
    await press(page, rows, 'A', key, want);
  }

  // B: a mouse click on Preview, then the keys from there.
  await clickCenter(page, tabPreview);
  const afterClick = await observe(page);
  rows.push({ scenario: 'B', key: 'mouse click Preview', expected: preview, observed: afterClick, ok: afterClick.focus === preview.focus && afterClick.tabs === tabsText('Preview') && afterClick.panel === 'Preview' });
  for (const [key, want] of [['ArrowLeft', edit], ['ArrowRight', preview], ['Home', edit], ['End', preview]] as const) {
    await press(page, rows, 'B', key, want);
  }

  // C: click inside the textarea (Edit first), Shift+Tab goes to the active tab, then an arrow.
  await clickCenter(page, tabEdit);
  await clickCenter(page, area);
  const inArea = await observe(page);
  rows.push({ scenario: 'C', key: 'mouse click textarea', expected: { focus: 'textarea "Description"', selected: 'Edit' }, observed: inArea, ok: inArea.focus === 'textarea "Description"' && inArea.tabs === tabsText('Edit') });
  await press(page, rows, 'C', 'Shift+Tab', edit);
  await press(page, rows, 'C', 'ArrowRight', preview);
  await clickCenter(page, tabEdit);

  // D: inside the textarea the same keys move the caret and leave the tabs alone.
  await clickCenter(page, area);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('alpha beta gamma');
  const typed = await observe(page);
  const D = async (key: string, caret: number) => {
    await page.keyboard.press(key);
    const o = await observe(page);
    rows.push({
      scenario: 'D',
      key,
      expected: { focus: 'textarea "Description"', selected: 'Edit' },
      observed: o,
      ok: o.focus === 'textarea "Description"' && o.tabs === tabsText('Edit') && o.panel === 'Edit' && o.caret[0] === caret && o.caret[1] === caret,
    });
  };
  notes.push(`typed: caret ${typed.caret.join('-')}`);
  await D('Home', 0);
  await D('End', 16);
  await D('ArrowLeft', 15);
  await D('ArrowRight', 16);

  // E: after switching by arrow the focus stays on the tab, Tab goes to the panel, which scrolls; Home/End on the tabs scroll nothing.
  const long = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a long description`).join('\n\n');
  await clickCenter(page, area);
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(long);
  await clickCenter(page, tabEdit); // focus on the Edit tab, by mouse
  await page.mouse.wheel(0, 120); // scroll the dialog body a little, with the wheel
  await page.waitForTimeout(150);
  const before = await observe(page);
  await press(page, rows, 'E', 'ArrowRight', preview);
  const afterArrow = await observe(page);
  rows.push({ scenario: 'E', key: 'focus stays on the new tab', expected: preview, observed: afterArrow, ok: afterArrow.focus === preview.focus });
  for (const key of ['Home', 'End', 'Home']) {
    const was = await observe(page);
    await press(page, rows, 'E', key, key === 'End' ? preview : edit);
    const now = await observe(page);
    const same = was.scroll.page === now.scroll.page && was.scroll.dialog === now.scroll.dialog;
    rows[rows.length - 1].ok &&= same;
    notes.push(`${key} on the tabs: page scroll ${was.scroll.page}->${now.scroll.page}, dialog ${was.scroll.dialog}->${now.scroll.dialog}`);
  }
  await press(page, rows, 'E', 'End', preview);
  await page.keyboard.press('Tab');
  const onPanel = await observe(page);
  rows.push({ scenario: 'E', key: 'Tab (to the panel)', expected: { focus: 'div[role=tabpanel] "Preview"', selected: 'Preview' }, observed: onPanel, ok: onPanel.focus === 'div[role=tabpanel] "Preview"' && onPanel.panel === 'Preview' });
  for (const key of ['ArrowDown', 'ArrowDown', 'PageDown']) {
    const was = await observe(page);
    await page.keyboard.press(key);
    // Chrome animates keyboard scrolling; wait (up to 1 s) for the panel to move rather than guess a delay.
    await page
      .waitForFunction((from) => (document.querySelector('[role="tabpanel"][id$="panel-preview"]') as HTMLElement).scrollTop > from, was.scroll.preview, { timeout: 1000 })
      .catch(() => undefined);
    const now = await observe(page);
    rows.push({ scenario: 'E', key: `${key} in the panel`, expected: { focus: 'div[role=tabpanel] "Preview"', selected: 'Preview' }, observed: now, ok: now.focus === 'div[role=tabpanel] "Preview"' && now.scroll.preview > was.scroll.preview });
  }
  notes.push(`tab positions before E: dialog scroll ${before.scroll.dialog}`);
  return { rows, tabsToReachEdit: tabs, notes };
}
