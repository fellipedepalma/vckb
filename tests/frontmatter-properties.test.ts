import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.js';
import { parseTaskFile, RESERVED_HEADING_RE, serializeTask, type TaskDoc } from '../src/core/task-file.js';
import { apiSetup } from './api-helpers.js';
import { awkwardText, extraValue, seeded, validLabel } from './seeded.js';

/**
 * What goes into a task file comes back exactly, whatever it contains. The cases come from a seeded
 * generator (the same ones on every run). Titles and labels are full of characters that mean
 * something in YAML; extra fields are nested values; nothing may leak into another field.
 */

const SEED = 20261006;
const PURE_CASES = 5000;
const API_CASES = 200;
const CLI_CASES = 60;

const baseDoc = (over: Partial<TaskDoc>): TaskDoc => ({
  id: 'T-001',
  title: 'x',
  status: 'todo',
  priority: 'medium',
  labels: [],
  order: 10,
  created: '2026-09-30',
  updated: '2026-09-30',
  extra: {},
  body: '',
  ...over,
});

describe(`the writer and the reader agree (${PURE_CASES} seeded cases)`, () => {
  it('titles, labels and extra fields come back exactly; the file is canonical and stable', () => {
    const rng = seeded(SEED);
    for (let i = 0; i < PURE_CASES; i++) {
      const doc = baseDoc({
        title: awkwardText(rng, { control: rng.chance(0.2) }),
        labels: Array.from({ length: rng.int(4) }, () => validLabel(rng)),
        extra: Object.fromEntries(Array.from({ length: rng.int(4) }, (_, k) => [`extra${k}`, extraValue(rng)])),
        body: rng.chance(0.5) ? `Some text\n\n## Checklist\n\n- [ ] one\n\n## Agent notes\n\n- note: ${awkwardText(rng)}\n` : '',
        ...(rng.chance(0.2) ? { bom: true } : {}),
        ...(rng.chance(0.2) ? { eol: '\r\n' as const } : {}),
      });
      const text = serializeTask(doc);
      const back = parseTaskFile(text).doc;
      const where = `case ${i}: ${JSON.stringify(doc.title)}`;
      expect(back.title, where).toBe(doc.title);
      expect(back.labels, where).toEqual(doc.labels);
      expect(back.extra, where).toEqual(JSON.parse(JSON.stringify(doc.extra)));
      expect(back.body, where).toBe(doc.body);
      expect(back.id, where).toBe('T-001');
      expect(back.status, where).toBe('todo');
      expect(back.priority, where).toBe('medium');
      expect(Object.keys(back.extra), where).toEqual(Object.keys(doc.extra));
      // Writing what was read changes nothing (so writing twice is writing once).
      expect(serializeTask(back), where).toBe(text);
    }
  });

  it('a title can never end the frontmatter or add a field', () => {
    const attacks = ['x\nstatus: done\n---\ninjection', 'x\r\nstatus: done', 'x: y\nstatus: done', '---\nstatus: done\n---', 'x\n---\n## Checklist\n- [x] hijack', '"\nstatus: done\n"', "'\nstatus: done"];
    for (const title of attacks) {
      const text = serializeTask(baseDoc({ title, status: 'todo' }));
      const back = parseTaskFile(text).doc;
      expect(back.title, JSON.stringify(title)).toBe(title);
      expect(back.status, JSON.stringify(title)).toBe('todo');
      expect(back.body, JSON.stringify(title)).toBe('');
      expect(text.split('\n').filter((l) => /^---\s*$/.test(l)), JSON.stringify(title)).toHaveLength(2);
    }
  });
});

describe('through the API and the CLI', () => {
  async function ctxWithProject() {
    const ctx = await apiSetup();
    await ctx.req('POST', '/api/projects', { name: 'App', slug: 'app' });
    const tasks = path.join(ctx.boards, 'app', 'tasks');
    return { ...ctx, tasks };
  }
  const only = async (tasks: string) => (await readdir(tasks)).filter((f) => f.endsWith('.md'));

  it(`${API_CASES} titles and labels written by POST and PATCH are read back exactly`, async () => {
    const rng = seeded(SEED + 1);
    const { req, tasks } = await ctxWithProject();
    const created = await (await req('POST', '/api/projects/app/tasks', { title: 'start' })).json();
    for (let i = 0; i < API_CASES; i++) {
      const title = awkwardText(rng);
      const labels = Array.from({ length: rng.int(4) }, () => validLabel(rng));
      const res = await req('PATCH', `/api/projects/app/tasks/${created.id}`, { title, labels });
      expect(res.status, JSON.stringify(title)).toBe(200);
      const got = await (await req('GET', `/api/projects/app/tasks/${created.id}`)).json();
      const raw = await readFile(path.join(tasks, created.file), 'utf8');
      const onDisk = parseTaskFile(raw).doc;
      const expected = title.trim();
      expect(got.title, JSON.stringify(title)).toBe(expected);
      expect(got.labels).toEqual([...new Set(labels)]);
      expect(onDisk.title).toBe(expected);
      expect(onDisk.status).toBe('backlog');
      expect(raw.split('\n').filter((l) => l === '---')).toHaveLength(2);
      if (i % 50 === 0) {
        // The same text through POST creates a task whose title is that text.
        const post = await req('POST', '/api/projects/app/tasks', { title, labels });
        expect(post.status).toBe(201);
        expect((await post.json()).title).toBe(expected);
      }
    }
    expect((await only(tasks)).length).toBe(1 + Math.ceil(API_CASES / 50));
  }, 120_000);

  it('a line break or NUL in a frontmatter field is refused with 400 and nothing changes', async () => {
    const { req, tasks } = await ctxWithProject();
    const t = await (await req('POST', '/api/projects/app/tasks', { title: 'Safe' })).json();
    const file = path.join(tasks, t.file);
    const before = await readFile(file, 'utf8');
    const hostile = ['x\nstatus: done\n---\ninjection', 'x\rstatus: done', 'a\r\nb', 'x\n'.repeat(3) + 'y'];
    for (const title of hostile) {
      const patch = await req('PATCH', `/api/projects/app/tasks/${t.id}`, { title });
      expect(patch.status, JSON.stringify(title)).toBe(400);
      expect((await patch.json()).error).toContain('"title"');
      const post = await req('POST', '/api/projects/app/tasks', { title });
      expect(post.status, JSON.stringify(title)).toBe(400);
      expect((await req('PATCH', `/api/projects/app/tasks/${t.id}`, { labels: [title] })).status).toBe(400);
      expect((await req('POST', '/api/projects/app/tasks', { title: 'ok', status: title })).status).toBe(400);
      expect((await req('POST', '/api/projects/app/tasks', { title: 'ok', priority: title })).status).toBe(400);
    }
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await only(tasks)).toHaveLength(1);
    // Line breaks at the ends are only whitespace: trimmed, and the text that is left is a plain title.
    const trimmed = await req('PATCH', `/api/projects/app/tasks/${t.id}`, { title: '\nstatus: done\n' });
    expect(trimmed.status).toBe(200);
    const after = await (await req('GET', `/api/projects/app/tasks/${t.id}`)).json();
    expect(after).toMatchObject({ title: 'status: done', status: 'backlog' });
    await req('PATCH', `/api/projects/app/tasks/${t.id}`, { title: 'Safe' });
    // NUL is escaped by the writer, never written raw, and reads back as it was.
    const nul = await req('PATCH', `/api/projects/app/tasks/${t.id}`, { title: 'a\u0000b' });
    expect(nul.status).toBe(200);
    expect(await readFile(file, 'utf8')).not.toContain('\u0000');
    expect((await (await req('GET', `/api/projects/app/tasks/${t.id}`)).json()).title).toBe('a\u0000b');
  });

  it(`${CLI_CASES} titles added with the CLI are read back exactly`, async () => {
    const rng = seeded(SEED + 2);
    const { boards, tasks } = await ctxWithProject();
    const cli = async (...args: string[]) => {
      let out = '';
      let err = '';
      const code = await run([...args, '--dir', boards], { out: (s) => (out += s), err: (s) => (err += s) });
      return { code, out, err };
    };
    for (let i = 0; i < CLI_CASES; i++) {
      const title = awkwardText(rng).replace(/^-+/, 'x');
      const label = validLabel(rng);
      const add = await cli('add', 'app', title, '--label', label, '--status', 'todo');
      expect(add.code, `${JSON.stringify(title)}: ${add.err}`).toBe(0);
      const files = (await only(tasks)).sort();
      const raw = await readFile(path.join(tasks, files[files.length - 1]), 'utf8');
      const doc = parseTaskFile(raw).doc;
      expect(doc.title, JSON.stringify(title)).toBe(title.trim());
      expect(doc.labels).toEqual([label]);
      expect(doc.status).toBe('todo');
    }
    const hostile = await cli('add', 'app', 'x\nstatus: done\n---\ninjection');
    expect(hostile.code).not.toBe(0);
    expect(hostile.err).toContain('line breaks');
  }, 120_000);

  it('writing without changes leaves the file byte for byte the same, once or twice', async () => {
    const { req, tasks } = await ctxWithProject();
    const t = await (
      await req('POST', '/api/projects/app/tasks', { title: 'Canonical: "yes" # really', labels: ['a', 'b'], description: 'Text', checklist: [{ text: 'one', done: true }], status: 'todo' })
    ).json();
    await req('POST', `/api/projects/app/tasks/${t.id}/notes`, { text: 'a note' });
    const file = path.join(tasks, t.file);
    const original = await readFile(file, 'utf8');
    expect(serializeTask(parseTaskFile(original).doc)).toBe(original); // parse then write
    for (let i = 0; i < 2; i++) {
      const same = await req('PATCH', `/api/projects/app/tasks/${t.id}`, { title: 'Canonical: "yes" # really', description: 'Text' });
      expect(same.status).toBe(200);
      expect(await readFile(file, 'utf8')).toBe(original);
    }
  });

  it('a BOM and CRLF are kept; extra fields and unknown sections are kept', async () => {
    const { req, tasks } = await ctxWithProject();
    const frontmatter = ['id: T-001', 'title: Windows', 'status: todo', 'priority: medium', 'labels: [a]', 'order: 10', 'created: 2026-09-30', 'updated: 2026-09-30', 'owner: me', 'meta:', '  tags: [x, y]', '  n: 3'];
    const body = 'Intro text\r\n\r\n## Links\r\n\r\n- https://example.com\r\n\r\n## Checklist\r\n\r\n- [ ] item\r\n\r\n## Agent notes\r\n\r\n- 2026-09-30: note\r\n';
    const raw = `﻿---\r\n${frontmatter.join('\r\n')}\r\n---\r\n${body}`;
    await writeFile(path.join(tasks, 'T-001-windows.md'), raw);
    expect((await req('PATCH', '/api/projects/app/tasks/T-001', { priority: 'high' })).status).toBe(200);
    const after = await readFile(path.join(tasks, 'T-001-windows.md'), 'utf8');
    expect(after.startsWith('﻿---\r\n')).toBe(true);
    const front = after.slice(1, after.indexOf('\r\n---\r\n') + 7);
    expect(front.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // every frontmatter line ends in CRLF
    expect(after.endsWith(`---\r\n${body}`)).toBe(true); // the body is untouched
    const doc = parseTaskFile(after).doc;
    expect(doc).toMatchObject({ priority: 'high', bom: true, eol: '\r\n' });
    expect(doc.extra).toEqual({ owner: 'me', meta: { tags: ['x', 'y'], n: 3 } });
    // And an LF file without a BOM stays that way.
    const lf = await (await req('POST', '/api/projects/app/tasks', { title: 'Unix' })).json();
    const lfRaw = await readFile(path.join(tasks, lf.file), 'utf8');
    expect(lfRaw.startsWith('---\n')).toBe(true);
    expect(lfRaw).not.toContain('\r');
  });
});

describe('descriptions that look like the file’s own sections', () => {
  const reserved = ['## Checklist', '##  checklist  ', '## CHECKLIST', '## Agent notes', '## agent NOTES', '## Notas do agente', 'before\n\n## Checklist\n\n- [x] fake\n\nafter', 'text\r\n## Agent notes\r\n- fake', '```md\n## Checklist\n```'];
  const fine = ['### Checklist', '## Checklist items', '## My Agent notes', 'a ## Checklist', '#Checklist', '## Check list', '- ## Checklist', 'Checklist\n---'];

  it('the pattern', () => {
    for (const d of reserved) expect(RESERVED_HEADING_RE.test(d), JSON.stringify(d)).toBe(true);
    for (const d of fine) expect(RESERVED_HEADING_RE.test(d), JSON.stringify(d)).toBe(false);
  });

  it('POST and PATCH refuse them with 400 about "description", and the task is untouched', async () => {
    const { req, tasks } = await apiSetup().then(async (c) => {
      await c.req('POST', '/api/projects', { name: 'App', slug: 'app' });
      return { ...c, tasks: path.join(c.boards, 'app', 'tasks') };
    });
    const t = await (await req('POST', '/api/projects/app/tasks', { title: 'Real', description: 'Intro', checklist: [{ text: 'real item', done: false }] })).json();
    await req('POST', `/api/projects/app/tasks/${t.id}/notes`, { text: 'a real note' });
    const file = path.join(tasks, t.file);
    const before = await readFile(file, 'utf8');
    for (const description of reserved) {
      const patch = await req('PATCH', `/api/projects/app/tasks/${t.id}`, { description });
      expect(patch.status, JSON.stringify(description)).toBe(400);
      const error = (await patch.json()).error as string;
      expect(error).toMatch(/^"description" must not contain/);
      expect(error).toContain('## Checklist');
      const post = await req('POST', '/api/projects/app/tasks', { title: 'New', description });
      expect(post.status).toBe(400);
    }
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await readdir(tasks)).filter((f) => f.endsWith('.md'))).toHaveLength(1);
    for (const description of fine) {
      const ok = await req('PATCH', `/api/projects/app/tasks/${t.id}`, { description });
      expect(ok.status, JSON.stringify(description)).toBe(200);
      const got = await (await req('GET', `/api/projects/app/tasks/${t.id}`)).json();
      expect(got.description).toBe(description.trim());
      expect(got.checklist).toEqual([{ text: 'real item', done: false }]); // the real sections kept working
    }
  });
});
