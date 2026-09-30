import { promises as fs } from 'node:fs';
import { VckbError } from './errors.js';
import { atomicWrite, TEMP_FILE_RE, withLock } from './fs-utils.js';
import { assertSlug, COLUMN_RE, formatTaskId, normalizeTaskId, safeJoin, SLUG_RE } from './paths.js';
import {
  appendNote,
  type ChecklistItem,
  getChecklist,
  getDescription,
  kebab,
  newTaskBody,
  parseTaskFile,
  type Priority,
  PRIORITIES,
  serializeTask,
  setChecklist,
  setDescription,
  type TaskDoc,
} from './task-file.js';

export const DEFAULT_COLUMNS = ['backlog', 'todo', 'doing', 'review', 'done'];
export const LIMITS = {
  title: 200,
  body: 100_000,
  note: 2_000,
  labels: 20,
  projectName: 100,
  projectDescription: 1_000,
  columns: 12,
  checklist: 200,
};

export interface Board {
  name: string;
  description: string;
  columns: string[];
  nextId: number;
}

export interface Project extends Board {
  slug: string;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  priority: Priority;
  labels: string[];
  order: number;
  created: string;
  updated: string;
  body: string;
  description: string;
  checklist: ChecklistItem[];
  progress: { done: number; total: number };
  /** File name inside tasks/ (never an absolute path). Unique, unlike `id` on a damaged board. */
  file: string;
}

export type WarningCode =
  | 'invalid_file'
  | 'incomplete_frontmatter'
  | 'provisional_id'
  | 'duplicate_id'
  | 'duplicate_order'
  | 'unknown_status'
  | 'next_id_behind';

/** A problem found in a board's files. Listings keep working; `vckb doctor --fix` repairs most of them. */
export interface BoardWarning {
  code: WarningCode;
  message: string;
  file?: string;
  files?: string[];
  id?: string;
  column?: string;
  fields?: string[];
}

export interface DoctorAction {
  file: string;
  /** New file name, when the task gets a new ID. */
  renameTo?: string;
  changes: string[];
}

export interface DoctorReport {
  project: string;
  warnings: BoardWarning[];
  /** What --fix changes (or changed, when `fixed` is true). */
  actions: DoctorAction[];
  nextId: { from: number; to: number } | null;
  /** Problems --fix cannot solve (unparsable files). */
  manual: BoardWarning[];
  fixed: boolean;
  /** Warnings left after --fix. */
  remaining?: BoardWarning[];
}

export interface CreateTaskInput {
  title: string;
  status?: string;
  priority?: Priority;
  labels?: string[];
  description?: string;
  checklist?: ChecklistItem[];
  /** Full body; when given, description/checklist are ignored. */
  body?: string;
  /** Position (0 = top) within the column; defaults to the end. */
  position?: number;
}

export interface UpdateTaskInput {
  title?: string;
  status?: string;
  priority?: Priority;
  labels?: string[];
  body?: string;
  description?: string;
  checklist?: ChecklistItem[];
  /** New position (0 = top) in the target column; renumbers its neighbors. */
  position?: number;
  /** Explicit `order` value (alternative to `position`). */
  order?: number;
}

export interface Summary {
  project: { slug: string; name: string };
  columns: { name: string; count: number }[];
  total: number;
  next: Task[];
  warnings: BoardWarning[];
}

interface Entry {
  doc: TaskDoc;
  file: string;
  /** Fields defaulted in memory; writing the entry persists the defaults. */
  missing: string[];
}

interface Scan {
  board: Project;
  entries: Entry[];
  warnings: BoardWarning[];
  /** Highest task number on disk: frontmatter IDs and file-name prefixes, parsable files or not. */
  maxId: number;
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,31}$/u;
/** "T-004-title.md" -> 4 */
const FILE_ID_RE = /^T-(\d{1,6})(?=[-_.])/i;

const byOrder = (a: TaskDoc, b: TaskDoc) => a.order - b.order || a.id.localeCompare(b.id);
const byEntryOrder = (a: Entry, b: Entry) => byOrder(a.doc, b.doc) || a.file.localeCompare(b.file);
const byPriority = (a: TaskDoc, b: TaskDoc) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byOrder(a, b);
const idNumber = (id: string) => Number(id.slice(2));

const invalid = (msg: string) => new VckbError('INVALID', msg);

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException)?.code === code;
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "T-004-fix_login.md" -> "fix login" */
function titleFromFile(file: string): string {
  const s = file
    .replace(/\.md$/i, '')
    .replace(FILE_ID_RE, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return s || '(untitled)';
}

/** A column whose order values repeat or were defaulted: renumbered whenever it is rewritten. */
function columnNeedsRenumber(column: Entry[]): boolean {
  return column.some((e) => e.missing.includes('order')) || new Set(column.map((e) => e.doc.order)).size !== column.length;
}

// -------------------------------------------------------------- validation

function vString(v: unknown, field: string, max: number, { required = false, multiline = false } = {}): string {
  if (typeof v !== 'string') throw invalid(`"${field}" must be a string`);
  const s = multiline ? v : v.trim();
  if (required && !s.trim()) throw invalid(`"${field}" is required`);
  if (s.length > max) throw invalid(`"${field}" exceeds ${max} characters`);
  if (!multiline && /[\r\n]/.test(s)) throw invalid(`"${field}" must not contain line breaks`);
  return s;
}

function vPriority(v: unknown): Priority {
  if (!PRIORITIES.includes(v as Priority)) throw invalid(`"priority" must be ${PRIORITIES.join(' | ')}`);
  return v as Priority;
}

function vLabels(v: unknown): string[] {
  if (!Array.isArray(v)) throw invalid('"labels" must be a list');
  if (v.length > LIMITS.labels) throw invalid(`at most ${LIMITS.labels} labels`);
  const out = v.map((l) => {
    const s = typeof l === 'string' ? l.trim() : '';
    if (!LABEL_RE.test(s)) throw invalid(`invalid label: ${JSON.stringify(l)}`);
    return s;
  });
  return [...new Set(out)];
}

function vChecklist(v: unknown): ChecklistItem[] {
  if (!Array.isArray(v)) throw invalid('"checklist" must be a list');
  if (v.length > LIMITS.checklist) throw invalid(`at most ${LIMITS.checklist} checklist items`);
  return v.map((i) => {
    if (!i || typeof i !== 'object') throw invalid('invalid checklist item');
    const item = i as Record<string, unknown>;
    return { text: vString(item.text, 'checklist.text', 500), done: item.done === true };
  });
}

function vStatus(board: Board, v: unknown): string {
  if (typeof v !== 'string' || !board.columns.includes(v)) {
    throw invalid(`invalid status: ${JSON.stringify(v)}. Columns: ${board.columns.join(', ')}`);
  }
  return v;
}

function vInt(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`"${field}" must be an integer between ${min} and ${max}`);
  }
  return v;
}

function vColumns(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITS.columns) {
    throw invalid(`"columns" must have 1 to ${LIMITS.columns} columns`);
  }
  const cols = v.map((c) => {
    if (typeof c !== 'string' || !COLUMN_RE.test(c)) throw invalid(`invalid column: ${JSON.stringify(c)}`);
    return c;
  });
  if (new Set(cols).size !== cols.length) throw invalid('duplicate columns');
  return cols;
}

function toTask({ doc, file }: Entry): Task {
  const checklist = getChecklist(doc.body);
  return {
    id: doc.id,
    title: doc.title,
    status: doc.status,
    priority: doc.priority,
    labels: doc.labels,
    order: doc.order,
    created: doc.created,
    updated: doc.updated,
    body: doc.body,
    description: getDescription(doc.body),
    checklist,
    progress: { done: checklist.filter((i) => i.done).length, total: checklist.length },
    file,
  };
}

// ------------------------------------------------------------------- store

export interface StoreOptions {
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class BoardStore {
  constructor(
    readonly root: string,
    private readonly opts: StoreOptions = {},
  ) {}

  today(): string {
    return localDate(this.opts.now?.() ?? new Date());
  }

  private projectDir(slug: string): string {
    return safeJoin(this.root, assertSlug(slug));
  }

  private tasksDir(slug: string): string {
    return safeJoin(this.projectDir(slug), 'tasks');
  }

  private boardFile(slug: string): string {
    return safeJoin(this.projectDir(slug), 'board.json');
  }

  // ------------------------------------------------------------ projects

  async listProjects(): Promise<Project[]> {
    let dirents;
    try {
      dirents = await fs.readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return [];
      throw err;
    }
    const projects: Project[] = [];
    for (const d of dirents) {
      if (!d.isDirectory() || !SLUG_RE.test(d.name)) continue;
      try {
        projects.push(await this.getProject(d.name));
      } catch {
        // folder without a valid board.json: not a project
      }
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getProject(slug: string): Promise<Project> {
    const file = this.boardFile(slug);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw new VckbError('NOT_FOUND', `Project not found: ${slug}`);
      throw err;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      throw invalid(`board.json of "${slug}" is not valid JSON`);
    }
    const nextId = Number(data.nextId);
    return {
      slug,
      name: typeof data.name === 'string' && data.name.trim() ? data.name : slug,
      description: typeof data.description === 'string' ? data.description : '',
      columns: vColumns(data.columns ?? DEFAULT_COLUMNS),
      nextId: Number.isInteger(nextId) && nextId > 0 ? nextId : 1,
    };
  }

  private async writeBoard(slug: string, board: Board): Promise<void> {
    const { name, description, columns, nextId } = board;
    await atomicWrite(this.boardFile(slug), `${JSON.stringify({ name, description, columns, nextId }, null, 2)}\n`);
  }

  async createProject(input: { name: string; slug?: string; description?: string; columns?: string[] }): Promise<Project> {
    const name = vString(input.name, 'name', LIMITS.projectName, { required: true });
    const slug = assertSlug(input.slug ?? kebab(name));
    const description =
      input.description === undefined ? '' : vString(input.description, 'description', LIMITS.projectDescription, { multiline: true });
    const columns = input.columns === undefined ? [...DEFAULT_COLUMNS] : vColumns(input.columns);

    await fs.mkdir(this.root, { recursive: true });
    const dir = this.projectDir(slug);
    try {
      await fs.mkdir(dir);
    } catch (err) {
      if (isErrno(err, 'EEXIST')) throw new VckbError('CONFLICT', `Project already exists: ${slug}`);
      throw err;
    }
    await fs.mkdir(this.tasksDir(slug), { recursive: true });
    const board: Board = { name, description, columns, nextId: 1 };
    await this.writeBoard(slug, board);
    return { slug, ...board };
  }

  // --------------------------------------------------------------- tasks

  /**
   * Reads every task file tolerantly. Hand-edited files never break the listing: missing fields
   * get safe defaults, unknown statuses land in the first column, files without an ID get a
   * provisional one, and every problem is reported in `warnings`.
   */
  private async scan(slug: string): Promise<Scan> {
    const board = await this.getProject(slug);
    const dir = this.tasksDir(slug);
    let files: string[];
    try {
      // Regular files only: symlinks are skipped so nothing is read/written outside the boards dir.
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      files = dirents.filter((d) => d.isFile()).map((d) => d.name);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) files = [];
      else throw err;
    }
    files = files.filter((f) => f.endsWith('.md') && !TEMP_FILE_RE.test(f)).sort();

    const warnings: BoardWarning[] = [];
    const entries: Entry[] = [];
    const withoutId: Entry[] = [];
    const firstColumn = board.columns[0];
    let maxId = 0;

    for (const file of files) {
      const fileId = FILE_ID_RE.exec(file);
      if (fileId) maxId = Math.max(maxId, Number(fileId[1]));
      const full = safeJoin(dir, file);
      let parsed;
      try {
        parsed = parseTaskFile(await fs.readFile(full, 'utf8'));
      } catch (err) {
        warnings.push({ code: 'invalid_file', file, message: `${file}: ${(err as Error).message}` });
        continue;
      }
      const { doc } = parsed;
      const missing = [...parsed.missing];
      const reported = missing.filter((f) => f !== 'id' && f !== 'status');

      let id: string | null = null;
      if (doc.id) {
        try {
          id = normalizeTaskId(doc.id);
        } catch {
          missing.push('id');
        }
      }
      if (id && id !== doc.id) missing.push('id'); // "t-4" is persisted as "T-004"
      if (!id && fileId) {
        id = formatTaskId(Number(fileId[1]));
        reported.unshift('id');
      }
      if (id) maxId = Math.max(maxId, idNumber(id));
      doc.id = id ?? '';

      if (!doc.title) doc.title = titleFromFile(file);

      const column = board.columns.find((c) => c === doc.status.toLowerCase());
      if (column !== doc.status) {
        if (!missing.includes('status')) missing.push('status');
        if (column) {
          reported.push('status');
        } else {
          const what = doc.status ? `status ${JSON.stringify(doc.status)} is not a column` : 'no "status"';
          warnings.push({ code: 'unknown_status', file, id: doc.id || undefined, column: firstColumn, message: `${file}: ${what}; shown in "${firstColumn}"` });
        }
        doc.status = column ?? firstColumn;
      }

      if (!doc.created || !doc.updated) {
        const mtime = localDate((await fs.stat(full)).mtime);
        doc.created ||= mtime;
        doc.updated ||= mtime;
      }

      if (reported.length) {
        warnings.push({
          code: 'incomplete_frontmatter',
          file,
          id: doc.id || undefined,
          fields: reported,
          message: `${file}: missing or invalid ${reported.join(', ')}; using defaults`,
        });
      }
      const entry: Entry = { doc, file, missing };
      entries.push(entry);
      if (!id) withoutId.push(entry);
    }

    // Files without any usable ID get the IDs the next creation would take; createTask persists
    // them before allocating, so they stay stable.
    let next = Math.max(board.nextId, maxId + 1);
    for (const e of withoutId) {
      e.doc.id = formatTaskId(next++);
      warnings.push({
        code: 'provisional_id',
        file: e.file,
        id: e.doc.id,
        message: `${e.file}: no "id"; provisionally ${e.doc.id} (saved on the next write or by "vckb doctor --fix")`,
      });
    }

    const filesById = new Map<string, string[]>();
    for (const e of entries) filesById.set(e.doc.id, [...(filesById.get(e.doc.id) ?? []), e.file]);
    for (const [id, dupes] of filesById) {
      if (dupes.length > 1) {
        warnings.push({ code: 'duplicate_id', id, files: dupes, message: `ID ${id} is used by ${dupes.length} files: ${dupes.join(', ')}` });
      }
    }

    // Tasks without an order go to the end of their column, in file-name order.
    for (const col of board.columns) {
      const inCol = entries.filter((e) => e.doc.status === col);
      let end = Math.max(0, ...inCol.filter((e) => !e.missing.includes('order')).map((e) => e.doc.order));
      for (const e of inCol) if (e.missing.includes('order')) e.doc.order = end += 10;
      const idsByOrder = new Map<number, string[]>();
      for (const e of inCol) idsByOrder.set(e.doc.order, [...(idsByOrder.get(e.doc.order) ?? []), e.doc.id]);
      const repeated = [...idsByOrder].filter(([, ids]) => ids.length > 1);
      if (repeated.length) {
        const detail = repeated.map(([o, ids]) => `${o}: ${ids.join(', ')}`).join('; ');
        warnings.push({ code: 'duplicate_order', column: col, message: `column "${col}" repeats order values (${detail}); renumbered on the next write` });
      }
    }

    if (board.nextId <= maxId) {
      warnings.push({
        code: 'next_id_behind',
        message: `board.json nextId is ${board.nextId} but ${formatTaskId(maxId)} exists; the next task gets ${formatTaskId(Math.max(maxId, next - 1) + 1)}`,
      });
    }

    entries.sort(byEntryOrder);
    return { board, entries, warnings, maxId: Math.max(maxId, next - 1) };
  }

  /** Finds a task by ID. Writing to an ID shared by several files is refused (ambiguous). */
  private find(entries: Entry[], id: string, forWrite: boolean): Entry {
    const matches = entries.filter((e) => e.doc.id === id).sort((a, b) => a.file.localeCompare(b.file));
    if (!matches.length) throw new VckbError('NOT_FOUND', `Task not found: ${id}`);
    if (forWrite && matches.length > 1) {
      const files = matches.map((e) => e.file).join(', ');
      throw new VckbError('CONFLICT', `ID ${id} is used by several files (${files}). Run "vckb doctor <project> --fix".`);
    }
    return matches[0];
  }

  async scanTasks(
    slug: string,
    filter: { status?: string; label?: string } = {},
  ): Promise<{ tasks: Task[]; warnings: BoardWarning[] }> {
    const { entries, warnings } = await this.scan(slug);
    const tasks = entries
      .filter((e) => (!filter.status || e.doc.status === filter.status) && (!filter.label || e.doc.labels.includes(filter.label)))
      .map(toTask);
    return { tasks, warnings };
  }

  async listTasks(slug: string, filter: { status?: string; label?: string } = {}): Promise<Task[]> {
    return (await this.scanTasks(slug, filter)).tasks;
  }

  async getTask(slug: string, id: string): Promise<Task> {
    const { entries } = await this.scan(slug);
    return toTask(this.find(entries, normalizeTaskId(id), false));
  }

  private async writeEntry(slug: string, entry: { doc: TaskDoc; file: string }): Promise<void> {
    await atomicWrite(safeJoin(this.tasksDir(slug), entry.file), serializeTask(entry.doc));
  }

  /**
   * Puts `doc` (stored as `file`) at `position` in the `status` column, renumbering order
   * (10, 20, 30...). A neighbor is written only if its order changed or it has defaults to persist.
   */
  private async place(slug: string, entries: Entry[], file: string, doc: TaskDoc, status: string, position: number): Promise<void> {
    const column = entries.filter((e) => e.doc.status === status && e.file !== file).sort(byEntryOrder);
    const pos = Math.max(0, Math.min(position, column.length));
    const ordered: (Entry | null)[] = [...column];
    ordered.splice(pos, 0, null);
    for (const [i, e] of ordered.entries()) {
      const order = (i + 1) * 10;
      if (e === null) doc.order = order;
      else if (e.doc.order !== order || e.missing.length) await this.writeEntry(slug, { file: e.file, doc: { ...e.doc, order } });
    }
  }

  /**
   * Puts `doc` at the end of `status`. A column with repeated or missing order values is
   * renumbered on the way (the column is being rewritten anyway).
   */
  private async placeAtEnd(slug: string, entries: Entry[], file: string, doc: TaskDoc, status: string): Promise<void> {
    const others = entries.filter((e) => e.doc.status === status && e.file !== file);
    if (columnNeedsRenumber(others)) {
      await this.place(slug, entries, file, doc, status, others.length);
    } else {
      doc.order = Math.max(0, ...others.map((e) => e.doc.order)) + 10;
    }
  }

  async createTask(slug: string, input: CreateTaskInput): Promise<Task> {
    const title = vString(input.title, 'title', LIMITS.title, { required: true });
    return withLock(this.projectDir(slug), async () => {
      const { board, entries, maxId } = await this.scan(slug);
      const status = input.status === undefined ? board.columns[0] : vStatus(board, input.status);
      const priority = input.priority === undefined ? 'medium' : vPriority(input.priority);
      const labels = input.labels === undefined ? [] : vLabels(input.labels);
      let body: string;
      if (input.body !== undefined) {
        body = vString(input.body, 'body', LIMITS.body, { multiline: true });
      } else {
        const description =
          input.description === undefined ? '' : vString(input.description, 'description', LIMITS.body, { multiline: true });
        body = newTaskBody(description, input.checklist === undefined ? [] : vChecklist(input.checklist));
      }

      // Self-correcting allocation: max(nextId, highest ID found in tasks/ + 1), so an ID that
      // exists on disk is never reused even if board.json fell behind. Provisional IDs are
      // persisted first so they don't shift once nextId moves past them.
      for (const e of entries) if (e.missing.includes('id')) await this.writeEntry(slug, e);
      const n = Math.max(board.nextId, maxId + 1);
      const id = formatTaskId(n);
      await this.writeBoard(slug, { ...board, nextId: n + 1 });

      const today = this.today();
      const doc: TaskDoc = { id, title, status, priority, labels, order: 0, created: today, updated: today, extra: {}, body };
      const file = `${id}-${kebab(title)}.md`;
      if (input.position !== undefined) {
        await this.place(slug, entries, file, doc, status, vInt(input.position, 'position', 0, 100_000));
      } else {
        await this.placeAtEnd(slug, entries, file, doc, status);
      }
      const entry: Entry = { doc, file, missing: [] };
      await this.writeEntry(slug, entry);
      return toTask(entry);
    });
  }

  async updateTask(slug: string, id: string, patch: UpdateTaskInput): Promise<Task> {
    const taskId = normalizeTaskId(id);
    if (!patch || typeof patch !== 'object' || Object.values(patch).every((v) => v === undefined)) {
      throw invalid('nothing to update');
    }
    return withLock(this.projectDir(slug), async () => {
      const { board, entries } = await this.scan(slug);
      const entry = this.find(entries, taskId, true);
      const doc: TaskDoc = { ...entry.doc };

      if (patch.title !== undefined) doc.title = vString(patch.title, 'title', LIMITS.title, { required: true });
      if (patch.priority !== undefined) doc.priority = vPriority(patch.priority);
      if (patch.labels !== undefined) doc.labels = vLabels(patch.labels);
      if (patch.body !== undefined) doc.body = vString(patch.body, 'body', LIMITS.body, { multiline: true });
      if (patch.description !== undefined) {
        doc.body = setDescription(doc.body, vString(patch.description, 'description', LIMITS.body, { multiline: true }));
      }
      if (patch.checklist !== undefined) doc.body = setChecklist(doc.body, vChecklist(patch.checklist));
      if (doc.body.length > LIMITS.body) throw invalid(`body exceeds ${LIMITS.body} characters`);

      const status = patch.status === undefined ? doc.status : vStatus(board, patch.status);
      const moving = status !== doc.status;
      doc.status = status;

      if (patch.position !== undefined) {
        await this.place(slug, entries, entry.file, doc, status, vInt(patch.position, 'position', 0, 100_000));
      } else if (patch.order !== undefined) {
        doc.order = vInt(patch.order, 'order', -1_000_000, 1_000_000);
      } else if (moving) {
        await this.placeAtEnd(slug, entries, entry.file, doc, status);
      }

      doc.updated = this.today();
      const updated: Entry = { doc, file: entry.file, missing: [] };
      await this.writeEntry(slug, updated);
      return toTask(updated);
    });
  }

  async moveTask(slug: string, id: string, status: string, position?: number): Promise<Task> {
    return this.updateTask(slug, id, { status, position });
  }

  async addNote(slug: string, id: string, text: string): Promise<Task> {
    const note = vString(text, 'note', LIMITS.note, { required: true, multiline: true });
    const taskId = normalizeTaskId(id);
    return withLock(this.projectDir(slug), async () => {
      const { entries } = await this.scan(slug);
      const entry = this.find(entries, taskId, true);
      const today = this.today();
      const updated: Entry = { file: entry.file, missing: [], doc: { ...entry.doc, body: appendNote(entry.doc.body, note, today), updated: today } };
      await this.writeEntry(slug, updated);
      return toTask(updated);
    });
  }

  async deleteTask(slug: string, id: string): Promise<void> {
    const taskId = normalizeTaskId(id);
    await withLock(this.projectDir(slug), async () => {
      const { entries } = await this.scan(slug);
      const entry = this.find(entries, taskId, true);
      await fs.rm(safeJoin(this.tasksDir(slug), entry.file));
    });
  }

  async summary(slug: string, nextLimit = 5): Promise<Summary> {
    const { board, entries, warnings } = await this.scan(slug);
    const next = entries
      .filter((e) => e.doc.status === 'todo')
      .sort((a, b) => byPriority(a.doc, b.doc))
      .slice(0, nextLimit)
      .map(toTask);
    return {
      project: { slug: board.slug, name: board.name },
      columns: board.columns.map((name) => ({ name, count: entries.filter((e) => e.doc.status === name).length })),
      total: entries.length,
      next,
      warnings,
    };
  }

  /** Recommended next task: highest priority in "todo" (ties broken by order). */
  async nextTask(slug: string): Promise<Task | null> {
    return (await this.summary(slug, 1)).next[0] ?? null;
  }

  // -------------------------------------------------------------- doctor

  /**
   * Lists a board's problems and what would fix them. Read-only unless `fix` is true; then,
   * under the project lock: persists defaulted fields, gives duplicated IDs a new one (the file
   * whose name matches the ID, or else the oldest, keeps it), renumbers columns with repeated
   * or missing order values and moves nextId past the highest ID.
   */
  async doctor(slug: string, { fix = false }: { fix?: boolean } = {}): Promise<DoctorReport> {
    const diagnose = async (): Promise<DoctorReport & { apply: () => Promise<void> }> => {
      const { board, entries, warnings, maxId } = await this.scan(slug);
      const plans = new Map<string, { entry: Entry; doc: TaskDoc; renameTo?: string; changes: string[] }>();
      const plan = (e: Entry) => {
        let p = plans.get(e.file);
        if (!p) plans.set(e.file, (p = { entry: e, doc: { ...e.doc }, changes: [] }));
        return p;
      };
      const show = (field: string, v: unknown) => `${field}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;

      for (const e of entries) {
        for (const field of e.missing) {
          if (field !== 'order') plan(e).changes.push(`set ${show(field, e.doc[field as keyof TaskDoc])}`);
        }
      }

      let next = Math.max(board.nextId, maxId + 1);
      const taken = new Set(entries.map((e) => e.file.toLowerCase()));
      const groups = new Map<string, Entry[]>();
      for (const e of entries) groups.set(e.doc.id, [...(groups.get(e.doc.id) ?? []), e]);
      for (const [id, group] of groups) {
        if (group.length < 2) continue;
        const named = (e: Entry) => Number(Number(FILE_ID_RE.exec(e.file)?.[1]) === idNumber(id));
        const ranked = [...group].sort(
          (a, b) => named(b) - named(a) || a.doc.created.localeCompare(b.doc.created) || a.file.localeCompare(b.file),
        );
        for (const e of ranked.slice(1)) {
          const p = plan(e);
          p.doc.id = formatTaskId(next++);
          p.changes.push(`id: ${id} → ${p.doc.id} (duplicate of ${ranked[0].file})`);
          if (FILE_ID_RE.test(e.file)) {
            const name = e.file.replace(FILE_ID_RE, p.doc.id);
            if (!taken.has(name.toLowerCase())) {
              p.renameTo = name;
              taken.add(name.toLowerCase());
            }
          }
        }
      }

      for (const col of board.columns) {
        const column = entries.filter((e) => e.doc.status === col);
        if (!columnNeedsRenumber(column)) continue;
        for (const [i, e] of column.sort(byEntryOrder).entries()) {
          const order = (i + 1) * 10;
          if (e.doc.order === order && !e.missing.includes('order')) continue;
          const p = plan(e);
          p.changes.push(e.missing.includes('order') ? `set order: ${order}` : `order: ${e.doc.order} → ${order}`);
          p.doc.order = order;
        }
      }

      const nextId = Math.max(board.nextId, next);
      const actions = [...plans.values()].map(({ entry, renameTo, changes }) => ({ file: entry.file, ...(renameTo ? { renameTo } : {}), changes }));
      return {
        project: slug,
        warnings,
        actions,
        nextId: nextId !== board.nextId ? { from: board.nextId, to: nextId } : null,
        manual: warnings.filter((w) => w.code === 'invalid_file'),
        fixed: false,
        apply: async () => {
          const dir = this.tasksDir(slug);
          for (const { entry, doc, renameTo } of plans.values()) {
            if (renameTo) {
              await atomicWrite(safeJoin(dir, renameTo), serializeTask(doc));
              await fs.rm(safeJoin(dir, entry.file));
            } else {
              await this.writeEntry(slug, { file: entry.file, doc });
            }
          }
          if (nextId !== board.nextId) await this.writeBoard(slug, { ...board, nextId });
        },
      };
    };

    if (!fix) {
      const { apply: _apply, ...report } = await diagnose();
      return report;
    }
    return withLock(this.projectDir(slug), async () => {
      const { apply, ...report } = await diagnose();
      await apply();
      const remaining = (await this.scan(slug)).warnings;
      return { ...report, fixed: true, remaining };
    });
  }
}
