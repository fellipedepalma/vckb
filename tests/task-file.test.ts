import { describe, expect, it } from 'vitest';
import {
  appendNote,
  getChecklist,
  getDescription,
  kebab,
  newTaskBody,
  parseTask,
  serializeTask,
  setChecklist,
  setDescription,
} from '../src/core/task-file.js';

const SAMPLE = `---
id: T-001
title: Short title
status: todo
priority: high
labels: [backend, ui]
order: 10
created: 2026-09-30
updated: 2026-09-30
---
Free-form **Markdown** description.

## Checklist
- [ ] item 1
- [x] item 2

## Notas do agente
(agents record decisions and what was done here)
`;

describe('frontmatter parse/serialize', () => {
  it('reads every field, normalizing YAML dates to YYYY-MM-DD', () => {
    const t = parseTask(SAMPLE);
    expect(t).toMatchObject({
      id: 'T-001',
      title: 'Short title',
      status: 'todo',
      priority: 'high',
      labels: ['backend', 'ui'],
      order: 10,
      created: '2026-09-30',
      updated: '2026-09-30',
    });
  });

  it('round-trips the file byte for byte', () => {
    expect(serializeTask(parseTask(SAMPLE))).toBe(SAMPLE);
  });

  it('keeps the body intact when only the frontmatter changes', () => {
    const t = parseTask(SAMPLE);
    const out = serializeTask({ ...t, status: 'doing', order: 30 });
    expect(parseTask(out).body).toBe(t.body);
    expect(out).toContain('status: doing\n');
    expect(out.split('---\n').slice(2).join('---\n')).toBe(t.body);
  });

  it('preserves unknown extra fields', () => {
    const raw = SAMPLE.replace('order: 10\n', 'order: 10\nassignee: claude\n');
    const out = serializeTask(parseTask(raw));
    expect(out).toContain('assignee: claude');
    expect(parseTask(out).extra).toEqual({ assignee: 'claude' });
  });

  it('quotes titles containing YAML special characters', () => {
    const t = parseTask(SAMPLE);
    const out = serializeTask({ ...t, title: 'API: route #1 [beta]' });
    expect(parseTask(out).title).toBe('API: route #1 [beta]');
  });

  it('tolerates missing fields but requires id and title', () => {
    const t = parseTask('---\nid: T-9\ntitle: X\n---\nbody\n');
    expect(t).toMatchObject({ priority: 'medium', labels: [], order: 0, status: '' });
    expect(() => parseTask('---\ntitle: X\n---\n')).toThrow(/id/);
    expect(() => parseTask('---\nid: T-1\n---\n')).toThrow(/title/);
  });
});

describe('Markdown body', () => {
  const body = parseTask(SAMPLE).body;

  it('extracts checklist and description', () => {
    expect(getChecklist(body)).toEqual([
      { text: 'item 1', done: false },
      { text: 'item 2', done: true },
    ]);
    expect(getDescription(body)).toBe('Free-form **Markdown** description.');
  });

  it('setChecklist replaces only the items and keeps the other sections', () => {
    const out = setChecklist(body, [
      { text: 'item 1', done: true },
      { text: 'new', done: false },
    ]);
    expect(getChecklist(out)).toEqual([
      { text: 'item 1', done: true },
      { text: 'new', done: false },
    ]);
    expect(out).toContain('## Notas do agente\n(agents record');
    expect(getDescription(out)).toBe(getDescription(body));
  });

  it('setChecklist creates the section before the notes when missing', () => {
    const out = setChecklist('Text\n\n## Notas do agente\n- x\n', [{ text: 'a', done: false }]);
    expect(out).toBe('Text\n\n## Checklist\n\n- [ ] a\n\n## Notas do agente\n- x\n');
  });

  it('setDescription replaces only the leading text', () => {
    const out = setDescription(body, 'New description');
    expect(out.startsWith('New description\n\n## Checklist')).toBe(true);
    expect(getChecklist(out)).toEqual(getChecklist(body));
  });

  it('appendNote appends to the end of the notes section', () => {
    const out = appendNote(body, 'chose Hono', '2026-09-30');
    expect(out.endsWith('(agents record decisions and what was done here)\n- 2026-09-30: chose Hono\n')).toBe(true);
    const twice = appendNote(out, 'second', '2026-10-01');
    expect(twice.endsWith('- 2026-09-30: chose Hono\n- 2026-10-01: second\n')).toBe(true);
  });

  it('appendNote creates the section if missing and leaves later sections alone', () => {
    expect(appendNote('Just text\n', 'hi', '2026-09-30')).toBe('Just text\n\n## Notas do agente\n\n- 2026-09-30: hi\n');
    const mid = appendNote('## Notas do agente\n- a\n\n## Extra\nend\n', 'b', 'D');
    expect(mid).toBe('## Notas do agente\n- a\n- D: b\n\n## Extra\nend\n');
  });

  it('newTaskBody generates the default skeleton', () => {
    expect(newTaskBody('Desc', [{ text: 'a', done: false }])).toBe(
      'Desc\n\n## Checklist\n\n- [ ] a\n\n## Notas do agente\n',
    );
  });

  it('kebab strips accents and symbols', () => {
    expect(kebab('Crème Brûlée & Deploy!')).toBe('creme-brulee-deploy');
    expect(kebab('!!!')).toBe('task');
  });
});
