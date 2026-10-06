import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guard for the web UI: text from task files (descriptions, titles, notes) reaches the page
 * only as React text nodes. Nothing in web/src may turn a string into markup or code. If a library
 * ever seems to need one of these, stop and find another way (AGENTS.md, "Web UI rules").
 */
const FORBIDDEN: [string, RegExp][] = [
  ['React\'s raw-HTML prop', /dangerouslySetInnerHTML/],
  ['innerHTML', /innerHTML/],
  ['outerHTML', /outerHTML/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['document.write', /document\s*\.\s*write(ln)?\b/],
  ['eval()', /(^|[^\w.$])eval\s*\(/],
  ['new Function', /new\s+Function\b/],
];

const root = path.resolve(__dirname, '../web/src');
const self = path.resolve(__dirname, 'web-no-html-injection.test.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|jsx|mjs|html)$/.test(e.name) && full !== self ? [full] : [];
  });
}

describe('web/src never injects HTML or runs code from strings', () => {
  const files = sourceFiles(root);

  it('looks at the UI sources', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('markdown.tsx'))).toBe(true);
  });

  it.each(FORBIDDEN)('no %s', (_name, pattern) => {
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .flatMap((line, i) => (pattern.test(line) ? [`${path.relative(root, file)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits, 'forbidden in web/src; render text as React elements instead').toEqual([]);
  });
});
