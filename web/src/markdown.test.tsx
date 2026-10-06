import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownPreview, PREVIEW_MAX_CHARS, safeHref } from './markdown';
import { strings } from './strings';

const FORBIDDEN = 'script, iframe, frame, object, embed, img, svg, math, style, form, input, button, textarea, select, meta, base, link, video, audio, source, canvas';
const URL_ATTRS = ['src', 'srcset', 'action', 'formaction', 'data', 'poster', 'xlink:href', 'background', 'ping'];

/** What must be true of ANY preview, whatever was typed. */
function expectSafe(container: HTMLElement) {
  expect([...container.querySelectorAll(FORBIDDEN)].map((e) => e.tagName), 'forbidden elements').toEqual([]);
  for (const el of container.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith('on'), `${el.tagName} has ${attr}`).toBe(false);
      expect(URL_ATTRS.includes(attr), `${el.tagName} has ${attr}`).toBe(false);
    }
    if (el.tagName !== 'A') expect(el.hasAttribute('href'), `${el.tagName} has href`).toBe(false);
  }
  for (const a of container.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    expect(href, 'link href').toMatch(/^(https?:\/\/|mailto:)\S+$/);
    expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(a.getAttribute('target')).toBe('_blank');
  }
}

const show = (source: string) => render(<MarkdownPreview source={source} />).container;

interface Payload {
  name: string;
  src: string;
  /** Shown as text (part of the text content). */
  text?: string;
  /** The only links allowed to exist. */
  links?: string[];
}

const PAYLOADS: Payload[] = [
  { name: 'script', src: '<script>alert(1)</script>', text: '<script>alert(1)</script>' },
  { name: 'img onerror', src: '<img src=x onerror=alert(1)>', text: '<img src=x onerror=alert(1)>' },
  { name: 'iframe', src: '<iframe src="javascript:alert(1)"></iframe>', text: '<iframe src="javascript:alert(1)"></iframe>' },
  { name: 'svg onload', src: '<svg onload=alert(1)>', text: '<svg onload=alert(1)>' },
  { name: 'style @import', src: "<style>@import 'http://evil.example/x.css';</style>", text: '@import' },
  { name: 'form action', src: '<form action="http://evil.example"><input name=x></form>', text: '<form action=' },
  { name: 'meta refresh', src: '<meta http-equiv="refresh" content="0;url=http://evil.example">', text: 'http-equiv' },
  { name: 'base href', src: '<base href="http://evil.example/">', text: '<base href=' },
  { name: 'link tag', src: '<link rel="stylesheet" href="http://evil.example/x.css">', text: '<link rel=' },
  { name: 'object data', src: '<object data="javascript:alert(1)"></object>', text: '<object data=' },
  { name: 'video source onerror', src: '<video><source onerror=alert(1)></video>', text: 'onerror=alert(1)' },
  { name: 'math xlink', src: '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', text: 'xlink:href' },
  { name: 'details ontoggle', src: '<details open ontoggle=alert(1)>x</details>', text: 'ontoggle=alert(1)' },
  { name: 'anchor html', src: '<a href="javascript:alert(1)">click</a>', text: '<a href="javascript:alert(1)">' },
  { name: 'inline html in a sentence', src: 'before <b onmouseover=alert(1)>bold</b> after', text: '<b onmouseover=alert(1)>' },
  { name: 'javascript: link', src: '[x](javascript:alert(1))', text: '[x](javascript:alert(1))' },
  { name: 'mixed case scheme', src: '[x](JaVaScRiPt:alert(1))', text: '[x](JaVaScRiPt:alert(1))' },
  { name: 'space before scheme', src: '[x]( javascript:alert(1))', text: 'javascript:alert(1)' },
  { name: 'newline inside scheme', src: '[x](java\nscript:alert(1))', text: 'script:alert(1)' },
  { name: 'tab inside scheme', src: '[x](java\tscript:alert(1))', text: 'script:alert(1)' },
  { name: 'control character first', src: '[x](\u0001javascript:alert(1))', text: 'alert(1)' },
  { name: 'numeric entity scheme', src: '[x](&#106;avascript:alert(1))', text: 'avascript:alert(1)' },
  { name: 'named entity colon', src: '[x](javascript&colon;alert(1))', text: 'alert(1)' },
  { name: 'percent-encoded scheme', src: '[x](%6Aavascript:alert(1))', text: '%6Aavascript:alert(1)' },
  { name: 'data: html', src: '[x](data:text/html,<script>alert(1)</script>)', text: 'data:text/html' },
  { name: 'vbscript:', src: '[x](vbscript:msgbox(1))', text: 'vbscript:msgbox(1)' },
  { name: 'file:', src: '[x](file:///etc/passwd)', text: 'file:///etc/passwd' },
  { name: 'blob:', src: '[x](blob:http://a.example/b)', text: 'blob:http://a.example/b' },
  { name: 'protocol-relative', src: '[x](//evil.example/x)', text: '//evil.example/x' },
  { name: 'relative', src: '[x](relative/path.md)', text: 'relative/path.md' },
  { name: 'upper-case HTTP', src: '[x](HTTP://EVIL.EXAMPLE/x)', text: 'HTTP://EVIL.EXAMPLE/x' },
  { name: 'https without host', src: '[x](https://)', text: 'https://' },
  { name: 'reference definition', src: '[x][1]\n\n[1]: javascript:alert(1)', text: '[x][1]' },
  { name: 'autolink javascript:', src: '<javascript:alert(1)>', text: '<javascript:alert(1)>' },
  { name: 'autolink data:', src: '<data:text/html;base64,PHNjcmlwdD4=>', text: 'data:text/html' },
  { name: 'image http', src: '![x](http://evil.example/t.png)', text: 'x (http://evil.example/t.png)' },
  { name: 'image javascript:', src: '![x](javascript:alert(1))', text: 'x (javascript:alert(1))' },
  { name: 'image data:', src: '![x](data:image/svg+xml,<svg onload=alert(1)>)', text: '![x](data:image/svg+xml' }, // not even an image to the parser: its literal source
  { name: 'image with a title', src: '![logo](https://evil.example/l.png "t")', text: 'logo (https://evil.example/l.png)' },
  { name: 'html inside inline code', src: '`<script>alert(1)</script>`', text: '<script>alert(1)</script>' },
  { name: 'html inside a code block', src: '```html\n<img src=x onerror=alert(1)>\n```', text: '<img src=x onerror=alert(1)>' },
  { name: 'html inside an indented code block', src: '    <script>alert(1)</script>', text: '<script>alert(1)</script>' },
  { name: 'escaped entities', src: '&lt;script&gt;alert(1)&lt;/script&gt;', text: '<script>alert(1)</script>' },
  { name: 'html in a table cell', src: '| a |\n|---|\n| <img src=x onerror=alert(1)> |', text: 'onerror=alert(1)' },
  { name: 'html in a heading', src: '# <script>alert(1)</script>', text: '<script>alert(1)</script>' },
  { name: 'html in a quote and a list', src: '> <iframe src=x></iframe>\n\n- <svg onload=alert(1)>', text: '<iframe src=x></iframe>' },
  { name: 'link with html in its text', src: '[<img src=x onerror=alert(1)>](javascript:alert(1))', text: 'onerror=alert(1)' },
  { name: 'html comment', src: '<!-- <script>alert(1)</script> -->', text: '<!--' },
  { name: 'cdata and processing instruction', src: '<![CDATA[<script>alert(1)</script>]]> <?php echo 1; ?>', text: '<?php' },
  // The allowed cases keep working.
  { name: 'https link', src: '[docs](https://example.com/a?b=1&c=2 "title")', text: 'docs', links: ['https://example.com/a?b=1&c=2'] },
  { name: 'http link', src: '[docs](http://example.com/)', text: 'docs', links: ['http://example.com/'] },
  { name: 'mailto link', src: '[me](mailto:someone@example.com)', text: 'me', links: ['mailto:someone@example.com'] },
  { name: 'https autolink', src: '<https://example.com/x>', text: 'https://example.com/x', links: ['https://example.com/x'] },
  { name: 'bare URL', src: 'see https://example.com/y now', text: 'see', links: ['https://example.com/y'] },
  { name: 'reference link to https', src: '[x][1]\n\n[1]: https://example.com/ref', text: 'x', links: ['https://example.com/ref'] },
];

describe('Markdown preview: payloads', () => {
  it('has a corpus of at least 25 payloads', () => {
    expect(PAYLOADS.length).toBeGreaterThanOrEqual(25);
  });

  it.each(PAYLOADS)('$name', ({ src, text, links = [] }) => {
    const container = show(src);
    expectSafe(container);
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(links);
    if (text) expect(container.textContent).toContain(text);
  });

  it('the rendered text of an entity is the character, as text', () => {
    const container = show('&lt;b&gt;not bold&lt;/b&gt; &amp; more');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>not bold</b> & more');
  });

  it('an image is its alt text and its URL as text; there is no img and nothing to request', () => {
    const container = show('![a cat](https://evil.example/cat.png)');
    expect(container.querySelector('img, picture, source')).toBeNull();
    expect(container.textContent).toBe(strings.details.markdown.image('a cat', 'https://evil.example/cat.png'));
  });
});

describe('Markdown preview: what is rendered', () => {
  it('paragraphs, line breaks, emphasis, strong, strike and inline code', () => {
    const c = show('one\ntwo\n\n*em* **strong** ~~gone~~ `code`');
    expect(c.querySelectorAll('p')).toHaveLength(2);
    expect(c.querySelector('br')).not.toBeNull();
    expect(c.querySelector('em')?.textContent).toBe('em');
    expect(c.querySelector('strong')?.textContent).toBe('strong');
    expect(c.querySelector('del')?.textContent).toBe('gone');
    expect(c.querySelector('p code')?.textContent).toBe('code');
  });
  it('six heading levels use three visual sizes', () => {
    const c = show('# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f');
    const sizes = [...c.querySelectorAll('h3, h4, h5, h6')].map((h) => /text-\[(\d+)px\]/.exec(h.className)?.[1]);
    expect(sizes).toEqual(['18', '16', '14', '14', '14', '14']);
    expect(new Set(sizes).size).toBe(3);
  });
  it('code blocks, quotes, rules, lists (ordered, unordered, nested, task) and tables', () => {
    const c = show(
      '```\nlet a = 1;\n```\n\n> quoted\n\n---\n\n- a\n  - nested\n- b\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo\n\n| h1 | h2 |\n|----|:--:|\n| 1 | **2** |',
    );
    expect(c.querySelector('pre code')?.textContent).toBe('let a = 1;');
    expect(c.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(c.querySelector('hr')).not.toBeNull();
    expect(c.querySelectorAll('ul ul li')).toHaveLength(1);
    expect(c.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(c.querySelectorAll('[role="img"]')).toHaveLength(2); // checkboxes are text, not inputs
    expect(c.querySelectorAll('thead th')).toHaveLength(2);
    expect(c.querySelector('tbody td strong')?.textContent).toBe('2');
    expect(c.querySelector('table')?.parentElement?.className).toContain('overflow-x-auto'); // tables scroll inside
    expect(c.querySelector('pre')?.className).toContain('overflow-x-auto'); // so do code blocks
    expectSafe(c);
  });
  it('empty or blank text says there is nothing to preview', () => {
    for (const blank of ['', '  \n\t ']) expect(show(blank).textContent).toBe(strings.details.markdown.empty);
  });
});

describe('safeHref', () => {
  it('allows absolute http, https and mailto only', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHref('http://localhost:8787/p/x')).toBe('http://localhost:8787/p/x');
    expect(safeHref('mailto:a@b.example')).toBe('mailto:a@b.example');
  });
  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' https://example.com',
    'https://example.com ',
    'https://exa mple.com',
    'https://example.com/\n',
    'https:\\\\example.com',
    'HTTPS://EXAMPLE.COM',
    'Mailto:a@b.example',
    '//example.com',
    '/path',
    'path',
    '#top',
    'https://',
    'https:example.com',
    'mailto:',
    'data:text/html,x',
    'ftp://example.com',
    'tel:123',
    '',
    'https://example.com/\u0007',
    'https://example.com/\u0085',
  ])('refuses %j', (href) => {
    expect(safeHref(href)).toBeNull();
  });
  it('refuses what is not a string', () => {
    for (const v of [undefined, null, 1, {}, ['https://example.com']]) expect(safeHref(v)).toBeNull();
  });
});

describe('Markdown preview: absurd input', () => {
  afterEach(() => vi.restoreAllMocks());
  const BUDGET_MS = 1000;

  /** Renders `source`; the time it took and whether the plain-text fallback took over. */
  function timed(source: string) {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the error it hands to the boundary
    const start = performance.now();
    const { container } = render(<MarkdownPreview source={source} />);
    return { ms: performance.now() - start, container };
  }

  const nested = (n: number) => Array.from({ length: n }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n').slice(0, PREVIEW_MAX_CHARS);
  const cases: [string, string][] = [
    ['100,000 "["', '['.repeat(100_000)],
    ['100,000 "*"', '*'.repeat(100_000)],
    ['100,000 "_"', '_'.repeat(100_000)],
    ['100,000 "`"', '`'.repeat(100_000)],
    ['50,000 "!["', '!['.repeat(50_000)],
    ['5,000 nested ">"', '>'.repeat(5_000) + ' deep'],
    ['5,000 nested "> "', '> '.repeat(5_000) + 'deep'],
    ['2,000 nested lists on one line', '- '.repeat(2_000) + 'x'],
    ['2,000 indented list levels (cut at the limit)', nested(2_000)],
    ['unbalanced link brackets', '[a](b '.repeat(15_000)],
    ['"[[[[]("', '[[[['.repeat(20_000) + ']('],
    // (jsdom builds DOM several times slower than a browser, so the table is kept modest here)
    ['a table with 1,000 rows', '| a | b |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(1_000)],
  ];

  it.each(cases)('%s renders (or falls back) within a second', (_name, source) => {
    const { ms, container } = timed(source);
    expect(ms).toBeLessThan(BUDGET_MS);
    expectSafe(container);
    expect(container.firstElementChild).not.toBeNull(); // something was shown
  });

  it('text that makes the parser throw shows the raw text and a status notice, not a crash', () => {
    const source = '>'.repeat(5_000) + ' deep';
    const { container } = timed(source);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(strings.details.markdown.renderFailed);
    expect(container.querySelector('pre')?.textContent).toBe(source);
  });

  it('more than the limit is not parsed at all', () => {
    const source = 'x'.repeat(PREVIEW_MAX_CHARS + 1);
    const { container } = timed(source);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(strings.details.markdown.tooLong(PREVIEW_MAX_CHARS));
    expect(container.querySelector('pre')?.textContent).toBe(source);
  });

  it('very deep (but parseable) nesting is cut off and shown as text, never overflowing', () => {
    const { container } = timed('> '.repeat(300) + 'bottom');
    expect(container.textContent).toContain('bottom');
    expectSafe(container);
  });
});
