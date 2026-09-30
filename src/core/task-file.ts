import matter from 'gray-matter';
import * as yaml from 'js-yaml';

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CHECKLIST_HEADING = 'Checklist';
export const NOTES_HEADING = 'Notas do agente';

export interface ChecklistItem {
  text: string;
  done: boolean;
}

/** Tarefa como está no disco: frontmatter + corpo Markdown intacto. */
export interface TaskDoc {
  id: string;
  title: string;
  status: string;
  priority: Priority;
  labels: string[];
  order: number;
  created: string;
  updated: string;
  /** Campos extras do frontmatter que não conhecemos: preservados na reescrita. */
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
  throw new Error('frontmatter deve ser YAML');
};

/**
 * Opções do gray-matter. Passar options também desliga o cache interno dele, que
 * devolveria o mesmo objeto mutável.
 * SEGURANÇA: o gray-matter aceita "---js" e avalia o frontmatter com eval(). Um .md
 * malicioso executaria código ao ser lido; por isso só YAML é aceito (checagem em
 * parseTask) e os motores de código ficam neutralizados como segunda barreira.
 */
const MATTER_OPTIONS = {
  language: 'yaml',
  engines: { javascript: refuseEngine, js: refuseEngine, coffee: refuseEngine },
};

/**
 * Lê um .md de tarefa. É tolerante com arquivos editados à mão (campos ausentes
 * ganham padrões), mas exige `id` e `title`.
 */
export function parseTask(raw: string): TaskDoc {
  const lang = /^---([^\r\n]*)/.exec(raw)?.[1].trim().toLowerCase();
  if (lang && lang !== 'yaml' && lang !== 'yml') throw new Error('frontmatter deve ser YAML');
  const parsed = matter(raw, MATTER_OPTIONS as Parameters<typeof matter>[1]);
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  if (typeof data.id !== 'string' || !data.id.trim()) throw new Error('frontmatter sem "id"');
  if (data.title === undefined || data.title === null || String(data.title).trim() === '') {
    throw new Error('frontmatter sem "title"');
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

/** Serializa com ordem de campos estável e no mesmo estilo do formato documentado. */
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
// Corpo Markdown: descrição livre, "## Checklist" e "## Notas do agente".
// Todas as funções devolvem um novo corpo alterando só a parte necessária.
// ---------------------------------------------------------------------------

interface Section {
  /** Índice do início da linha do título "## ..." */
  start: number;
  /** Índice logo após a linha do título. */
  contentStart: number;
  /** Índice do próximo "## " (ou fim do corpo). */
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

// Sem quantificadores adjacentes sobre espaço (evita backtracking quadrático/ReDoS);
// o texto é aparado em JS.
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

/** Substitui os itens da seção Checklist, preservando linhas que não são itens. */
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

/** Texto livre antes das seções Checklist/Notas. */
export function getDescription(body: string): string {
  return body.slice(0, descriptionEnd(body)).trim();
}

export function setDescription(body: string, description: string): string {
  const rest = body.slice(descriptionEnd(body));
  const desc = description.trim();
  if (!rest) return desc ? `${desc}\n` : '';
  return desc ? `${desc}\n\n${rest}` : rest;
}

/** Acrescenta "- AAAA-MM-DD: texto" ao fim da seção "Notas do agente" (cria se faltar). */
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

/** "Título com Acentuação!" -> "titulo-com-acentuacao" */
export function kebab(title: string): string {
  const s = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return s || 'tarefa';
}
