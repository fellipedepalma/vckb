import matter from 'gray-matter';
import * as yaml from 'js-yaml';

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CHECKLIST_HEADING = 'Checklist';
/** Part of the file format (kept in Portuguese for compatibility with existing boards). */
export const NOTES_HEADING = 'Notas do agente';

export interface ChecklistItem {
  text: string;
  done: boolean;
}

/** A task as stored on disk: frontmatter + untouched Markdown body. */
export interface TaskDoc {
  id: string;
  title: string;
  status: string;
  priority: Priority;
  labels: string[];
  order: number;
  created: string;
  updated: string;
  /** Unknown frontmatter fields, preserved when the file is rewritten. */
  extra: Record<string, unknown>;
  body: string;
}

const KNOWN_KEYS = ['id', 'title', 'status', 'priority', 'labels', 'order', 'created', 'updated'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDateString(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return typeof v === 'string' ? v.trim() : '';
}

function toLabels(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

const refuseEngine = () => {
  throw new Error('frontmatter must be YAML');
};

/**
 * gray-matter options. Passing options also disables its internal cache, which would
 * hand back the same mutable object.
 * SECURITY: gray-matter accepts "---js" and evaluates that frontmatter with eval(). A
 * malicious .md would run code just by being read, so only YAML is accepted (checked in
 * parseTask) and the code engines are neutralized as a second barrier.
 */
const MATTER_OPTIONS = {
  language: 'yaml',
  engines: { javascript: refuseEngine, js: refuseEngine, coffee: refuseEngine },
};

/**
 * Reads a task .md file. Tolerant of hand-edited files (missing fields get defaults),
 * but `id` and `title` are required.
 */
export function parseTask(raw: string): TaskDoc {
  const lang = /^---([^\r\n]*)/.exec(raw)?.[1].trim().toLowerCase();
  if (lang && lang !== 'yaml' && lang !== 'yml') throw new Error('frontmatter must be YAML');
  const parsed = matter(raw, MATTER_OPTIONS as Parameters<typeof matter>[1]);
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  if (typeof data.id !== 'string' || !data.id.trim()) throw new Error('frontmatter is missing "id"');
  if (data.title === undefined || data.title === null || String(data.title).trim() === '') {
    throw new Error('frontmatter is missing "title"');
  }
  const priority = PRIORITIES.includes(data.priority as Priority) ? (data.priority as Priority) : 'medium';
  const order = Number(data.order);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!KNOWN_KEYS.includes(k) && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') extra[k] = v;
  }
  return {
    id: data.id.trim(),
    title: String(data.title).trim(),
    status: String(data.status ?? '').trim(),
    priority,
    labels: toLabels(data.labels),
    order: Number.isFinite(order) ? order : 0,
    created: toDateString(data.created),
    updated: toDateString(data.updated),
    extra,
    body: parsed.content,
  };
}

function scalar(v: unknown): string {
  return yaml.dump(v, { lineWidth: -1 }).trimEnd();
}

/** Serializes with a stable field order, in the same style as the documented format. */
export function serializeTask(t: TaskDoc): string {
  const date = (d: string) => (DATE_RE.test(d) ? d : scalar(d));
  const lines = [
    `id: ${scalar(t.id)}`,
    `title: ${scalar(t.title)}`,
    `status: ${scalar(t.status)}`,
    `priority: ${t.priority}`,
    `labels: ${yaml.dump(t.labels, { flowLevel: 0, lineWidth: -1 }).trimEnd()}`,
    `order: ${t.order}`,
    `created: ${date(t.created)}`,
    `updated: ${date(t.updated)}`,
  ];
  const extraKeys = Object.keys(t.extra);
  if (extraKeys.length) lines.push(yaml.dump(t.extra, { lineWidth: -1 }).trimEnd());
  return `---\n${lines.join('\n')}\n---\n${t.body}`;
}

// ---------------------------------------------------------------------------
// Markdown body: free-form description, "## Checklist" and "## Notas do agente" (agent notes).
// Every function returns a new body, changing only the part it is about.
// ---------------------------------------------------------------------------

interface Section {
  /** Index where the "## ..." heading line starts. */
  start: number;
  /** Index right after the heading line. */
  contentStart: number;
  /** Index of the next "## " heading (or end of body). */
  end: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findSection(body: string, heading: string): Section | null {
  const re = new RegExp(`^##[ \\t]+${escapeRe(heading)}[ \\t]*\\r?$`, 'im');
  const m = re.exec(body);
  if (!m) return null;
  let contentStart = m.index + m[0].length;
  if (body[contentStart] === '\n') contentStart++;
  const next = /^##[ \t]+/m.exec(body.slice(contentStart));
  const end = next ? contentStart + next.index : body.length;
  return { start: m.index, contentStart, end };
}

// No adjacent quantifiers over whitespace (avoids quadratic backtracking / ReDoS);
// the text is trimmed in JS instead.
const CHECK_RE = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t](.*)$/;

export function getChecklist(body: string): ChecklistItem[] {
  const sec = findSection(body, CHECKLIST_HEADING);
  if (!sec) return [];
  const items: ChecklistItem[] = [];
  for (const line of body.slice(sec.contentStart, sec.end).split(/\r?\n/)) {
    const m = CHECK_RE.exec(line);
    if (m && m[2].trim()) items.push({ done: m[1] !== ' ', text: m[2].trim() });
  }
  return items;
}

function checklistLines(items: ChecklistItem[]): string {
  return items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text.replace(/\r?\n/g, ' ').trim()}`).join('\n');
}

/** Replaces the items of the Checklist section, keeping lines that are not items. */
export function setChecklist(body: string, items: ChecklistItem[]): string {
  const clean = items.filter((i) => i.text.trim());
  const sec = findSection(body, CHECKLIST_HEADING);
  if (!sec) {
    if (!clean.length) return body;
    const block = `## ${CHECKLIST_HEADING}\n\n${checklistLines(clean)}\n\n`;
    const notes = findSection(body, NOTES_HEADING);
    if (notes) return body.slice(0, notes.start) + block + body.slice(notes.start);
    return `${body.replace(/\s*$/, '')}${body.trim() ? '\n\n' : ''}${block}`;
  }
  const others = body
    .slice(sec.contentStart, sec.end)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !CHECK_RE.test(l));
  const parts = [checklistLines(clean), others.join('\n')].filter(Boolean);
  const content = `\n${parts.join('\n\n')}${parts.length ? '\n' : ''}${sec.end < body.length ? '\n' : ''}`;
  return body.slice(0, sec.contentStart) + content + body.slice(sec.end);
}

function descriptionEnd(body: string): number {
  const idx = [findSection(body, CHECKLIST_HEADING), findSection(body, NOTES_HEADING)]
    .filter((s): s is Section => s !== null)
    .map((s) => s.start);
  return idx.length ? Math.min(...idx) : body.length;
}

/** Free-form text before the Checklist/notes sections. */
export function getDescription(body: string): string {
  return body.slice(0, descriptionEnd(body)).trim();
}

export function setDescription(body: string, description: string): string {
  const rest = body.slice(descriptionEnd(body));
  const desc = description.trim();
  if (!rest) return desc ? `${desc}\n` : '';
  return desc ? `${desc}\n\n${rest}` : rest;
}

/** Appends "- YYYY-MM-DD: text" to the end of the agent notes section (creating it if missing). */
export function appendNote(body: string, text: string, date: string): string {
  const note = `- ${date}: ${text.replace(/\r?\n+/g, ' ').trim()}`;
  const sec = findSection(body, NOTES_HEADING);
  if (!sec) {
    const base = body.replace(/\s*$/, '');
    return `${base}${base ? '\n\n' : ''}## ${NOTES_HEADING}\n\n${note}\n`;
  }
  const content = body.slice(sec.contentStart, sec.end).replace(/\s*$/, '');
  const after = body.slice(sec.end);
  return `${body.slice(0, sec.contentStart)}${content ? `${content}\n` : '\n'}${note}\n${after ? '\n' : ''}${after}`;
}

export function newTaskBody(description: string, checklist: ChecklistItem[]): string {
  const desc = description.trim();
  const items = checklist.filter((i) => i.text.trim());
  return (
    `${desc ? `${desc}\n\n` : ''}` +
    `## ${CHECKLIST_HEADING}\n\n${items.length ? `${checklistLines(items)}\n\n` : ''}` +
    `## ${NOTES_HEADING}\n`
  );
}

/** "Crème Brûlée & Co!" -> "creme-brulee-co" (accents stripped) */
export function kebab(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return s || 'task';
}
