import * as yaml from 'js-yaml';

/**
 * Task files are written by people and by agents, and they come from clones and pull requests, so
 * they are UNTRUSTED INPUT. These limits keep reading one cheap whatever it contains.
 */
export const PARSE_LIMITS = {
  /** A task file larger than this is not read at all (the store checks the size before opening it). */
  fileBytes: 1_048_576,
  /** The frontmatter block, between the two `---` lines. */
  frontmatterBytes: 65_536,
  /** Nesting depth of lists and mappings inside the frontmatter. */
  depth: 20,
} as const;

/**
 * How the frontmatter is read: js-yaml's core schema (no tags beyond the YAML basics, so nothing like
 * `!!js/function`), no anchors or aliases (`&a` / `*a`: a few of them nest into billions of values),
 * no merge keys (they only exist to be used with aliases), limited depth. Duplicate keys are an error.
 */
const READ_OPTIONS = { schema: yaml.CORE_SCHEMA, maxAliases: 0, maxDepth: PARSE_LIMITS.depth };

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CHECKLIST_HEADING = 'Checklist';
/** Agent-notes heading used for new tasks. */
export const NOTES_HEADING = 'Agent notes';
/**
 * Agent-notes headings accepted when reading/appending. "Notas do agente" is the Portuguese
 * form used by older boards; whichever heading a task already has is preserved.
 */
export const NOTES_HEADINGS = [NOTES_HEADING, 'Notas do agente'] as const;

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
  /** The file started with a byte order mark; written back as it was. */
  bom?: boolean;
  /** The frontmatter lines ended in CRLF (the body is always kept exactly as it was). */
  eol?: '\r\n';
}

const KNOWN_KEYS = ['id', 'title', 'status', 'priority', 'labels', 'order', 'created', 'updated'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDateString(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return typeof v === 'string' ? v.trim() : '';
}

function toLabels(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

/**
 * Splits a task file into its frontmatter block and Markdown body.
 * The first line is `---` (optionally `---yaml`/`---yml`, checked by the caller); the block ends at the
 * first line that is exactly `---` (trailing spaces and tabs allowed), so `----` or `---text` do not
 * end it and a `---` line inside the body is just body. A block that is never closed is an error:
 * guessing where the body starts would reinterpret text as YAML and rewrite it.
 * SECURITY: only js-yaml reads the block (see READ_OPTIONS); there is no code engine to run.
 */
function splitFrontmatter(raw: string): { block: string; content: string; eol: '\n' | '\r\n' } {
  const firstLineEnd = raw.search(/\r?\n/);
  if (firstLineEnd === -1) throw new Error('frontmatter is not closed (no closing "---" line)');
  const eol = raw[firstLineEnd] === '\r' ? '\r\n' : '\n';
  const start = firstLineEnd + eol.length;
  let pos = start;
  while (pos <= raw.length) {
    const nl = raw.indexOf('\n', pos);
    const lineEnd = nl === -1 ? raw.length : nl;
    const line = raw.slice(pos, raw[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd);
    if (/^---[ \t]*$/.test(line)) {
      const block = raw.slice(start, pos);
      if (Buffer.byteLength(block, 'utf8') > PARSE_LIMITS.frontmatterBytes) {
        throw new Error(`frontmatter is larger than ${PARSE_LIMITS.frontmatterBytes} bytes`);
      }
      return { block, content: nl === -1 ? '' : raw.slice(nl + 1), eol };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  throw new Error('frontmatter is not closed (no closing "---" line)');
}

/** Keys that could reach an object's prototype if some code ever assigned them; dropped everywhere. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A copy of a parsed YAML value without the unsafe keys at any depth (the parser limits the depth). */
function cleanValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanValue);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!UNSAFE_KEYS.has(k)) out[k] = cleanValue(x);
    return out;
  }
  return v;
}

/** A parsed file plus the known fields that were absent or unusable (defaults were applied). */
export interface ParsedTask {
  doc: TaskDoc;
  missing: string[];
}

/**
 * Reads a task .md file. Tolerant of hand-edited files: absent or invalid fields get
 * defaults and are listed in `missing` (id/title fall back to ''; the store fills them in).
 * Throws (an Error the store reports as an invalid file) when the file is too big, has no closed
 * `---` frontmatter block, the block is not a YAML mapping, or it breaks the rules in READ_OPTIONS.
 */
export function parseTaskFile(input: string): ParsedTask {
  if (input.length > PARSE_LIMITS.fileBytes) throw new Error(`file is larger than ${PARSE_LIMITS.fileBytes} bytes`);
  const bom = input.startsWith('﻿'); // left by some Windows editors; kept when the file is rewritten
  const raw = bom ? input.slice(1) : input;
  const lang = /^---([^\r\n]*)/.exec(raw)?.[1].trim().toLowerCase();
  if (lang === undefined) throw new Error('file has no frontmatter (it must start with "---")');
  if (lang && lang !== 'yaml' && lang !== 'yml') throw new Error('frontmatter must be YAML');
  const { block, content, eol } = splitFrontmatter(raw);
  const blank = block.split(/\r?\n/).every((line) => line.trim() === '' || line.trimStart().startsWith('#'));
  const loaded = blank ? {} : yaml.load(block, READ_OPTIONS);
  if (loaded !== null && loaded !== undefined && (typeof loaded !== 'object' || Array.isArray(loaded))) {
    throw new Error('frontmatter must be a YAML mapping (key: value lines)');
  }
  const data = (loaded ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

  const id = typeof data.id === 'string' ? data.id.trim() : '';
  if (!id) missing.push('id');
  const title = str(data.title);
  if (!title) missing.push('title');
  const status = str(data.status);
  if (!status) missing.push('status');
  const priority = PRIORITIES.includes(data.priority as Priority) ? (data.priority as Priority) : 'medium';
  if (priority !== data.priority) missing.push('priority');
  const order = typeof data.order === 'number' || typeof data.order === 'string' ? (data.order === '' ? NaN : Number(data.order)) : NaN;
  if (!Number.isFinite(order)) missing.push('order');
  const created = toDateString(data.created);
  if (!created) missing.push('created');
  const updated = toDateString(data.updated);
  if (!updated) missing.push('updated');

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!KNOWN_KEYS.includes(k) && !UNSAFE_KEYS.has(k)) extra[k] = cleanValue(v);
  }
  return {
    doc: {
      id,
      title,
      status,
      priority,
      labels: toLabels(data.labels),
      order: Number.isFinite(order) ? order : 0,
      created,
      updated,
      extra,
      body: content,
      ...(bom ? { bom: true } : {}),
      ...(eol === '\r\n' ? { eol } : {}),
    },
    missing,
  };
}

/** Same as `parseTaskFile`, returning only the document. */
export function parseTask(raw: string): TaskDoc {
  return parseTaskFile(raw).doc;
}

function scalar(v: unknown): string {
  return yaml.dump(v, { lineWidth: -1, noRefs: true }).trimEnd();
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
  if (extraKeys.length) lines.push(yaml.dump(t.extra, { lineWidth: -1, noRefs: true }).trimEnd());
  const eol = t.eol ?? '\n';
  const front = `---\n${lines.join('\n')}\n---\n`.replace(/\n/g, eol);
  return `${t.bom ? '﻿' : ''}${front}${t.body}`;
}

// ---------------------------------------------------------------------------
// Markdown body: free-form description, "## Checklist" and "## Agent notes" (or "## Notas do agente").
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

/**
 * A line of a description that would start one of the file's own sections ("## Checklist",
 * "## Agent notes", "## Notas do agente"). The store refuses such a description: the first matching
 * line is where the file's sections are taken to begin, so it would cut the description short,
 * turn its text into a fake checklist or notes, and duplicate text on every later save.
 */
export const RESERVED_HEADING_RE = new RegExp(
  `^##[ \\t]+(?:${[CHECKLIST_HEADING, ...NOTES_HEADINGS].map(escapeRe).join('|')})[ \\t]*\\r?$`,
  'im',
);

/** Finds the first section whose heading matches any of `headings` (case-insensitive). */
function findSection(body: string, headings: string | readonly string[]): Section | null {
  const alternatives = (typeof headings === 'string' ? [headings] : headings).map(escapeRe).join('|');
  const re = new RegExp(`^##[ \\t]+(?:${alternatives})[ \\t]*\\r?$`, 'im');
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
    const notes = findSection(body, NOTES_HEADINGS);
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
  const idx = [findSection(body, CHECKLIST_HEADING), findSection(body, NOTES_HEADINGS)]
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
  const sec = findSection(body, NOTES_HEADINGS);
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
