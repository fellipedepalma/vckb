import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.js';
import { PARSE_LIMITS, parseTaskFile, serializeTask } from '../src/core/task-file.js';
import { apiSetup } from './api-helpers.js';

/**
 * Task files are written by agents and arrive in clones and pull requests: they are untrusted input.
 * Every case here must end as a valid task (maybe with a warning) or as a file reported as invalid,
 * quickly, without running anything, without polluting prototypes and without blowing up memory.
 */

const fm = (body: string, extra = '') => `---\nid: T-001\ntitle: Hostile\nstatus: todo\n${body}\n---\nBody\n${extra}`;
const BUDGET_MS = 2000;
const MAX_RSS_GROWTH = 200 * 1024 * 1024;

async function setup() {
  const ctx = await apiSetup();
  await ctx.store.createProject({ name: 'App', slug: 'app' });
  const tasks = path.join(ctx.boards, 'app', 'tasks');
  const put = (file: string, content: string | Buffer) => writeFile(path.join(tasks, file), content);
  const cli = async (...args: string[]) => {
    let out = '';
    let err = '';
    const code = await run([...args, '--dir', ctx.boards], { out: (s) => (out += s), err: (s) => (err += s) });
    return { code, out, err };
  };
  return { ...ctx, tasks, put, cli };
}

/** Runs `fn`, returning how long it took and how much the process grew (RSS). */
async function measured<T>(fn: () => Promise<T>) {
  const rss0 = process.memoryUsage().rss;
  const t = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t, rss: process.memoryUsage().rss - rss0 };
}

const codes = (ws: { code: string }[]) => ws.map((w) => w.code).sort();
/** The files reported as unreadable (the task files here may also trip unrelated warnings, like nextId). */
const invalid = (ws: { code: string }[]) => codes(ws.filter((w) => w.code === 'invalid_file'));

/** Walks a parsed value and returns the paths of the keys that must never survive. */
function unsafeKeys(v: unknown, at = '$'): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => unsafeKeys(x, `${at}[${i}]`));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.entries(v).flatMap(([k, x]) => [...(['__proto__', 'constructor', 'prototype'].includes(k) ? [`${at}.${k}`] : []), ...unsafeKeys(x, `${at}.${k}`)]);
  }
  return [];
}

describe('frontmatter engines are never run', () => {
  const marker = path.join(os.tmpdir(), `vckb-engine-marker-${process.pid}-${Date.now()}`);
  const payload = (engine: string) => `---${engine}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n---\nBody\n`;

  it.each(['js', 'javascript', 'coffee', 'json', 'JS', 'Javascript'])('---%s: refused, nothing created', async (engine) => {
    expect(() => parseTaskFile(payload(engine))).toThrow('frontmatter must be YAML');
    const { put, store } = await setup();
    await put('T-001-engine.md', payload(engine));
    const { tasks, warnings } = await store.scanTasks('app');
    expect(tasks).toEqual([]);
    expect(invalid(warnings)).toEqual(['invalid_file']);
    expect(warnings.find((w) => w.code === 'invalid_file')?.message).toContain('frontmatter must be YAML');
    expect(existsSync(marker), 'the file the payload tried to create').toBe(false);
  });
});

describe('YAML tags', () => {
  const tags = [
    'x: !!js/function "function () { throw new Error(`ran`) }"',
    'x: !!js/regexp /a+/',
    'x: !!js/undefined ""',
    'x: !!python/object/apply:os.system ["touch /tmp/pwned"]',
    `x: !!binary ${'QUFB'.repeat(500_000)}`,
    'x: !foo bar',
    'x: !<tag:example.com,2026:thing> bar',
    '!!set {a, b}: 1',
  ];
  it.each(tags.map((t) => [t.slice(0, 40), t]))('%s is an invalid file, not an object', async (_name, line) => {
    const { value, ms } = await measured(async () => {
      try {
        return parseTaskFile(fm(line));
      } catch (err) {
        return err as Error;
      }
    });
    expect(value).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe('prototype pollution', () => {
  const cases: [string, string][] = [
    ['__proto__ at the top', '__proto__: {polluted: yes}'],
    ['constructor at the top', 'constructor: {prototype: {polluted: yes}}'],
    ['prototype at the top', 'prototype: {polluted: yes}'],
    ['nested', 'meta:\n  __proto__: {polluted: yes}\n  deeper:\n    constructor: {prototype: {polluted: yes}}\n    list:\n      - {__proto__: {polluted: yes}}'],
    ['inside a flow mapping', 'meta: {__proto__: {polluted: yes}, constructor: {prototype: {polluted: yes}}}'],
    ['through a merge key', '<<: {__proto__: {polluted: yes}}'],
    ['through a merge sequence', '<<: [{__proto__: {polluted: yes}}, {constructor: {prototype: {polluted: yes}}}]'],
    ['quoted keys', '"__proto__": {polluted: yes}\n"constructor": {"prototype": {polluted: yes}}'],
  ];

  it.each(cases)('%s: parse and rewrite leave every prototype alone', async (_name, body) => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const hostile = fm(body);
    // A complex key cannot even be loaded.
    expect(() => parseTaskFile(fm('? [__proto__]\n: {polluted: yes}'))).toThrow();

    const { put, store, boards } = await setup();
    await put('T-001-proto.md', hostile);
    const parsed = parseTaskFile(hostile).doc;
    expect(unsafeKeys(parsed.extra)).toEqual([]);
    expect(Object.getPrototypeOf(parsed.extra)).toBe(Object.prototype);

    // A rewrite through the store (what PATCH does).
    const task = await store.updateTask('app', 'T-001', { title: 'Rewritten' });
    expect(task.title).toBe('Rewritten');
    const after = await readFile(path.join(boards, 'app', 'tasks', 'T-001-proto.md'), 'utf8');
    expect(after).not.toMatch(/__proto__|polluted/);
    const reparsed = parseTaskFile(after).doc;
    expect(unsafeKeys(reparsed.extra)).toEqual([]);

    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(Object.getPrototypeOf(task)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('amplification: aliases and merge keys', () => {
  const laughs = (levels: number, fan: number) => {
    const lines = ['a0: &a0 [x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < levels; i++) lines.push(`a${i}: &a${i} [${Array(fan).fill(`*a${i - 1}`).join(', ')}]`);
    return lines;
  };
  const mergeChain = (n: number) => ['m0: &m0 {k0: 1}', ...Array.from({ length: n - 1 }, (_, i) => `m${i + 1}: &m${i + 1} {<<: *m${i}, k${i + 1}: 1}`)];
  // The fields the reader coerces (String(), Number()) are where a bomb would go off.
  const bombs: [string, string][] = [
    ['billion laughs in an extra field', laughs(30, 9).join('\n')],
    ['billion laughs as the labels', `${laughs(30, 9).join('\n')}\nlabels: *a29`],
    ['billion laughs as the order', `${laughs(30, 9).join('\n')}\norder: *a29`],
    ['billion laughs as the title', `${laughs(30, 9).join('\n')}\ntitle: *a29`],
    ['a chain of merge keys', mergeChain(60).join('\n')],
    ['a single alias', 'a: &a hello\nb: *a'],
  ];

  it.each(bombs)('%s: the file is reported invalid in a blink, by every operation', async (_name, body) => {
    const { put, store, req, cli, boards } = await setup();
    await store.createTask('app', { title: 'Healthy neighbour', status: 'todo' }); // T-001
    const hostileRaw = `---\nid: T-002\ntitle: Bomb\nstatus: todo\n${body}\n---\nBody\n`;
    await put('T-002-bomb.md', hostileRaw);
    const timings: [string, { ms: number; rss: number }][] = [];
    const run1 = async <T>(name: string, fn: () => Promise<T>) => {
      const m = await measured(fn);
      timings.push([name, m]);
      return m.value;
    };

    expect(() => parseTaskFile(hostileRaw)).toThrow(/alias/i);
    const board = await run1('GET board', async () => (await (await req('GET', '/api/projects/app/board')).json()) as { tasks: { id: string }[]; warnings: { code: string }[] });
    expect(board.tasks.map((t) => t.id)).toEqual(['T-001']);
    expect(invalid(board.warnings)).toEqual(['invalid_file']);
    expect((await run1('GET tasks', async () => req('GET', '/api/projects/app/tasks'))).status).toBe(200);
    expect((await run1('GET healthy task', async () => req('GET', '/api/projects/app/tasks/T-001'))).status).toBe(200);
    expect((await run1('GET bomb task', async () => req('GET', '/api/projects/app/tasks/T-002'))).status).toBe(404);
    const patch = await run1('PATCH healthy', async () => req('PATCH', '/api/projects/app/tasks/T-001', { priority: 'high' }));
    expect(patch.status).toBe(200);
    expect((await run1('PATCH bomb', async () => req('PATCH', '/api/projects/app/tasks/T-002', { priority: 'high' }))).status).toBe(404);
    const list = await run1('vckb list', () => cli('list', 'app', '--json'));
    expect(list.code).toBe(0);
    expect(invalid(JSON.parse(list.out).warnings)).toEqual(['invalid_file']);
    const doctor = await run1('vckb doctor', () => cli('doctor', 'app'));
    expect(doctor.out).toContain('T-002-bomb.md');
    const fix = await run1('vckb doctor --fix', () => cli('doctor', 'app', '--fix'));
    expect(fix.code).toBeLessThanOrEqual(1);

    for (const [name, m] of timings) {
      expect(m.ms, `${name} took ${Math.round(m.ms)} ms`).toBeLessThan(BUDGET_MS);
      expect(m.rss, `${name} grew RSS by ${Math.round(m.rss / 1e6)} MB`).toBeLessThan(MAX_RSS_GROWTH);
    }
    // doctor --fix never touches a file it cannot read.
    expect(await readFile(path.join(boards, 'app', 'tasks', 'T-002-bomb.md'), 'utf8')).toBe(hostileRaw);
  });

  it('quoted * and & in titles are not aliases', () => {
    const doc = parseTaskFile('---\nid: T-001\ntitle: "Fish & chips *special* &more *a"\nstatus: todo\nlabels: ["a&b", "*c"]\n---\n').doc;
    expect(doc.title).toBe('Fish & chips *special* &more *a');
    expect(doc.labels).toEqual(['a&b', '*c']);
    expect(parseTaskFile(serializeTask(doc)).doc.title).toBe(doc.title);
  });
});

describe('size and depth', () => {
  it('names the limits', () => {
    expect(PARSE_LIMITS).toEqual({ fileBytes: 1_048_576, frontmatterBytes: 65_536, depth: 20 });
  });

  const nested = (n: number) => `x: ${'['.repeat(n)}${']'.repeat(n)}`;
  const blockNested = (n: number) => Array.from({ length: n }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n');
  const cases: [string, () => string | Buffer, RegExp][] = [
    ['a 1 MB frontmatter', () => fm(`x: "${'a'.repeat(1_000_000)}"`), /frontmatter is larger/],
    ['10,000 keys', () => fm(Array.from({ length: 10_000 }, (_, i) => `k${i}: ${i}`).join('\n')), /frontmatter is larger/],
    ['10,000 levels of flow nesting', () => fm(nested(10_000)), /nesting exceeded/],
    ['300 levels of block nesting', () => fm(blockNested(300)), /nesting exceeded/],
    ['a 5 MB line', () => fm(`x: ${'b'.repeat(5_000_000)}`), /larger than/],
    ['a 50 MB file', () => Buffer.alloc(50 * 1024 * 1024, 'a'), /larger than/],
    ['a 1 MB title', () => `---\nid: T-001\ntitle: "${'T'.repeat(1_000_000)}"\nstatus: todo\n---\n`, /larger than/],
  ];

  it.each(cases)('%s: reported invalid, quickly, without growing memory', async (_name, make, why) => {
    const { put, store } = await setup();
    await put('T-001-big.md', make());
    const { value, ms, rss } = await measured(() => store.scanTasks('app'));
    expect(value.tasks).toEqual([]);
    expect(invalid(value.warnings)).toEqual(['invalid_file']);
    expect(value.warnings.find((w) => w.code === 'invalid_file')?.message).toMatch(why);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(rss).toBeLessThan(MAX_RSS_GROWTH);
  });

  it('a file over the limit is not even opened (the size is checked first)', async () => {
    const { put, store, tasks } = await setup();
    await put('T-001-huge.md', Buffer.alloc(PARSE_LIMITS.fileBytes + 1, 'a'));
    expect(invalid((await store.scanTasks('app')).warnings)).toEqual(['invalid_file']);
    expect((await stat(path.join(tasks, 'T-001-huge.md'))).size).toBe(PARSE_LIMITS.fileBytes + 1);
  });

  it('what is at the limits still works', async () => {
    const { put, store } = await setup();
    const body = 'x'.repeat(PARSE_LIMITS.fileBytes - 200);
    await put('T-001-edge.md', `---\nid: T-001\ntitle: Edge\nstatus: todo\n---\n${body}`);
    const frontmatter = `---\nid: T-002\ntitle: Wide\nstatus: todo\n${Array.from({ length: 4000 }, (_, i) => `k${i}: ${i}`).join('\n')}\n---\n`;
    expect(Buffer.byteLength(frontmatter)).toBeLessThan(PARSE_LIMITS.frontmatterBytes + 200);
    await put('T-002-wide.md', frontmatter);
    await put('T-003-deep.md', fm(`x: ${'['.repeat(PARSE_LIMITS.depth - 2)}${']'.repeat(PARSE_LIMITS.depth - 2)}`).replace('T-001', 'T-003'));
    const { tasks, warnings } = await store.scanTasks('app');
    expect(tasks.map((t) => t.id).sort()).toEqual(['T-001', 'T-002', 'T-003']);
    expect(warnings.filter((w) => w.code === 'invalid_file')).toEqual([]);
  });
});

describe('delimiters and encoding', () => {
  const head = 'id: T-001\ntitle: Edge\nstatus: todo\n';
  const ok = (raw: string) => parseTaskFile(raw).doc;

  it('accepts a BOM, CRLF, mixed endings and trailing spaces on the delimiters', () => {
    expect(ok(`﻿---\n${head}---\nBody\n`)).toMatchObject({ title: 'Edge', body: 'Body\n', bom: true });
    expect(ok(`---\r\n${head.replace(/\n/g, '\r\n')}---\r\nBody\r\n`)).toMatchObject({ title: 'Edge', body: 'Body\r\n', eol: '\r\n' });
    expect(ok(`---\n${head.replace('\n', '\r\n')}---\nBody\n`)).toMatchObject({ title: 'Edge', body: 'Body\n' }); // mixed
    expect(ok(`---  \t\n${head}---   \nBody\n`)).toMatchObject({ title: 'Edge', body: 'Body\n' });
    expect(ok(`---yaml\n${head}---\nB`)).toMatchObject({ title: 'Edge', body: 'B' });
  });

  it('the block ends at the first line that is exactly ---', () => {
    expect(ok(`---\n${head}---\nIntro\n\n---\n\nMore\n`).body).toBe('Intro\n\n---\n\nMore\n');
    expect(ok(`---\n${head}---`).body).toBe(''); // closed at the very end of the file
    expect(ok(`---\n${head}---\n`).body).toBe('');
  });

  it('"----" and "---text" are not delimiters', () => {
    expect(() => parseTaskFile(`---\n${head}----\nBody\n`)).toThrow(/not closed/);
    expect(() => parseTaskFile(`---\n${head}---text\nBody\n`)).toThrow(/not closed/);
    expect(() => parseTaskFile(`----\n${head}---\nBody\n`)).toThrow('frontmatter must be YAML'); // opening
    // A "----" line before the real end is just part of the block (and not valid YAML there).
    expect(() => parseTaskFile(`---\n${head}----\n---\nBody\n`)).toThrow();
  });

  it('a block that is never closed, or an empty file, or a lone ---, is invalid', () => {
    for (const raw of [`---\n${head}`, '---', '---\n', '', 'no frontmatter\n', `---\n${head}Body text with: a colon\n`]) {
      expect(() => parseTaskFile(raw), JSON.stringify(raw.slice(0, 30))).toThrow();
    }
  });

  it('empty and comment-only frontmatter are valid and everything is defaulted', () => {
    for (const raw of ['---\n---\nBody\n', '---\n\n  \n---\nBody\n', '---\n# a comment\n---\nBody\n']) {
      const { doc, missing } = parseTaskFile(raw);
      expect(doc.body).toBe('Body\n');
      expect(missing).toContain('title');
    }
  });

  it('the YAML document end marker "..." inside the block is not accepted silently', () => {
    const attempt = () => parseTaskFile(`---\n${head}...\nignored: yes\n---\nBody\n`);
    // Either an invalid file, or valid without ever reading what follows the marker: never a crash.
    try {
      expect(attempt().doc.extra).not.toHaveProperty('ignored');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
    expect(ok(`---\n${head}...\n---\nBody\n`)).toMatchObject({ title: 'Edge' });
  });

  it('NUL and other control characters in the block are refused', () => {
    for (const bad of ['\u0000', '\u0001', '\u0007', '\u001b']) {
      expect(() => parseTaskFile(`---\nid: T-001\ntitle: "a${bad}b"\n---\n`), JSON.stringify(bad)).toThrow();
      expect(() => parseTaskFile(`---\nid: T-001\ntitle: a${bad}b\n---\n`), JSON.stringify(bad)).toThrow();
    }
  });

  it('the body is not looked at: NUL, emoji and odd characters pass through', () => {
    const body = 'nul:\u0000 emoji:😀 zwsp:​ rtl:‮אב line:  bom:﻿\n';
    expect(ok(`---\n${head}---\n${body}`).body).toBe(body);
  });

  it('bytes that are not UTF-8 make the file invalid instead of being "repaired" with U+FFFD', async () => {
    const { put, store } = await setup();
    await put('T-001-bad-utf8.md', Buffer.concat([Buffer.from(`---\n${head}---\nBody `), Buffer.from([0xc3, 0x28, 0xff, 0xfe]), Buffer.from('\n')]));
    const { tasks, warnings } = await store.scanTasks('app');
    expect(tasks).toEqual([]);
    const w = warnings.find((x) => x.code === 'invalid_file');
    expect(w?.message).toContain('not valid UTF-8');
  });

  it('emoji, zero-width and right-to-left text in titles and labels read back unchanged', () => {
    const doc = ok('---\nid: T-001\ntitle: "😀 a​b ‮אב é漢"\nstatus: todo\nlabels: [😀, "é", "漢字"]\n---\n');
    expect(doc.title).toBe('😀 a​b ‮אב é漢');
    expect(doc.labels).toEqual(['😀', 'é', '漢字']);
    expect(parseTaskFile(serializeTask(doc)).doc).toEqual(doc);
  });
});

describe('duplicate keys and unexpected types', () => {
  it('a duplicate key makes the file invalid (the later value would silently win otherwise)', () => {
    expect(() => parseTaskFile(fm('title: second'))).toThrow(/duplicated mapping key/);
  });

  it('unexpected types become defaults with a warning, never an exception', async () => {
    const { put, store } = await setup();
    await put('T-001-types.md', '---\nid: T-001\ntitle: Types\nstatus: 5\npriority: [high, low]\nlabels: {a: 1}\norder: [1, 2]\ncreated: [x]\n---\nBody\n');
    await put('T-002-more.md', '---\nid: [T-002]\ntitle: {a: b}\nstatus: true\npriority: 7\nlabels: [[a], {b: 1}, 3, null, " ok "]\norder: yes\n---\n');
    await put('T-003-scalar.md', '---\njust a string\n---\nBody\n');
    await put('T-004-list.md', '---\n- a\n- b\n---\nBody\n');
    const { tasks, warnings } = await store.scanTasks('app');
    expect(warnings.filter((w) => w.code === 'invalid_file').map((w) => w.file).sort()).toEqual(['T-003-scalar.md', 'T-004-list.md']);
    const types = tasks.find((t) => t.file === 'T-001-types.md')!;
    expect(types).toMatchObject({ title: 'Types', priority: 'medium', labels: [] });
    const more = tasks.find((t) => t.file === 'T-002-more.md')!;
    expect(more.labels).toEqual(['3', 'ok']); // only strings and numbers count as labels
    expect(codes(warnings)).toContain('incomplete_frontmatter');
  });

  it('a very long title is accepted up to the frontmatter limit and no further', () => {
    const title = (n: number) => `---\nid: T-001\ntitle: "${'T'.repeat(n)}"\nstatus: todo\n---\n`;
    expect(parseTaskFile(title(60_000)).doc.title).toHaveLength(60_000);
    expect(() => parseTaskFile(title(70_000))).toThrow(/frontmatter is larger/);
  });
});

describe('what a readable file survives', () => {
  it('a directory or a file list full of oddities does not stop the scan', async () => {
    const { put, store, tasks } = await setup();
    await store.createTask('app', { title: 'Fine', status: 'todo' });
    await put('T-010-empty.md', '');
    await put('T-011-binary.md', Buffer.from([0, 1, 2, 3, 255, 254]));
    await put('T-012-js.md', '---js\nprocess.exit(1)\n---\n');
    const { tasks: list, warnings } = await store.scanTasks('app');
    expect(list.map((t) => t.title)).toEqual(['Fine']);
    expect(warnings.filter((w) => w.code === 'invalid_file')).toHaveLength(3);
    expect((await readdir(tasks)).sort()).toEqual(['T-001-fine.md', 'T-010-empty.md', 'T-011-binary.md', 'T-012-js.md']);
  });
});
