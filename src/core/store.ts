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
  parseTask,
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
  /** Nome do arquivo dentro de tasks/ (nunca um caminho absoluto). */
  file: string;
}

export interface InvalidTaskFile {
  file: string;
  error: string;
}

export interface CreateTaskInput {
  title: string;
  status?: string;
  priority?: Priority;
  labels?: string[];
  description?: string;
  checklist?: ChecklistItem[];
  /** Corpo completo; se informado, ignora description/checklist. */
  body?: string;
  /** Posição (0 = topo) dentro da coluna; padrão = fim. */
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
  /** Nova posição (0 = topo) na coluna de destino; reordena os vizinhos. */
  position?: number;
  /** Valor explícito de `order` (alternativa a `position`). */
  order?: number;
}

export interface Summary {
  project: { slug: string; name: string };
  columns: { name: string; count: number }[];
  total: number;
  next: Task[];
  invalidFiles: InvalidTaskFile[];
}

interface Entry {
  doc: TaskDoc;
  file: string;
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,31}$/u;

const byOrder = (a: TaskDoc, b: TaskDoc) => a.order - b.order || a.id.localeCompare(b.id);
const byPriority = (a: TaskDoc, b: TaskDoc) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byOrder(a, b);

const invalid = (msg: string) => new VckbError('INVALID', msg);

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException)?.code === code;
}

// ---------------------------------------------------------------- validação

function vString(v: unknown, field: string, max: number, { required = false, multiline = false } = {}): string {
  if (typeof v !== 'string') throw invalid(`"${field}" deve ser texto`);
  const s = multiline ? v : v.trim();
  if (required && !s.trim()) throw invalid(`"${field}" é obrigatório`);
  if (s.length > max) throw invalid(`"${field}" excede ${max} caracteres`);
  if (!multiline && /[\r\n]/.test(s)) throw invalid(`"${field}" não pode ter quebras de linha`);
  return s;
}

function vPriority(v: unknown): Priority {
  if (!PRIORITIES.includes(v as Priority)) throw invalid(`"priority" deve ser ${PRIORITIES.join(' | ')}`);
  return v as Priority;
}

function vLabels(v: unknown): string[] {
  if (!Array.isArray(v)) throw invalid('"labels" deve ser uma lista');
  if (v.length > LIMITS.labels) throw invalid(`no máximo ${LIMITS.labels} labels`);
  const out = v.map((l) => {
    const s = typeof l === 'string' ? l.trim() : '';
    if (!LABEL_RE.test(s)) throw invalid(`label inválida: ${JSON.stringify(l)}`);
    return s;
  });
  return [...new Set(out)];
}

function vChecklist(v: unknown): ChecklistItem[] {
  if (!Array.isArray(v)) throw invalid('"checklist" deve ser uma lista');
  if (v.length > LIMITS.checklist) throw invalid(`no máximo ${LIMITS.checklist} itens no checklist`);
  return v.map((i) => {
    if (!i || typeof i !== 'object') throw invalid('item de checklist inválido');
    const item = i as Record<string, unknown>;
    return { text: vString(item.text, 'checklist.text', 500), done: item.done === true };
  });
}

function vStatus(board: Board, v: unknown): string {
  if (typeof v !== 'string' || !board.columns.includes(v)) {
    throw invalid(`status inválido: ${JSON.stringify(v)}. Colunas: ${board.columns.join(', ')}`);
  }
  return v;
}

function vInt(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`"${field}" deve ser inteiro entre ${min} e ${max}`);
  }
  return v;
}

function vColumns(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITS.columns) {
    throw invalid(`"columns" deve ter de 1 a ${LIMITS.columns} colunas`);
  }
  const cols = v.map((c) => {
    if (typeof c !== 'string' || !COLUMN_RE.test(c)) throw invalid(`coluna inválida: ${JSON.stringify(c)}`);
    return c;
  });
  if (new Set(cols).size !== cols.length) throw invalid('colunas repetidas');
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
  /** Relógio injetável (testes). */
  now?: () => Date;
}

export class BoardStore {
  constructor(
    readonly root: string,
    private readonly opts: StoreOptions = {},
  ) {}

  today(): string {
    const d = this.opts.now?.() ?? new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

  // ------------------------------------------------------------ projetos

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
        // pasta sem board.json válido: não é um projeto
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
      if (isErrno(err, 'ENOENT')) throw new VckbError('NOT_FOUND', `Projeto não encontrado: ${slug}`);
      throw err;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      throw invalid(`board.json de "${slug}" não é JSON válido`);
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
      if (isErrno(err, 'EEXIST')) throw new VckbError('CONFLICT', `Projeto já existe: ${slug}`);
      throw err;
    }
    await fs.mkdir(this.tasksDir(slug), { recursive: true });
    const board: Board = { name, description, columns, nextId: 1 };
    await this.writeBoard(slug, board);
    return { slug, ...board };
  }

  // ------------------------------------------------------------- tarefas

  private async readEntries(slug: string): Promise<{ board: Project; entries: Entry[]; invalid: InvalidTaskFile[] }> {
    const board = await this.getProject(slug);
    let files: string[];
    try {
      // Só arquivos regulares: symlinks são ignorados para não ler/gravar fora de boards/.
      const dirents = await fs.readdir(this.tasksDir(slug), { withFileTypes: true });
      files = dirents.filter((d) => d.isFile()).map((d) => d.name);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) files = [];
      else throw err;
    }
    const entries: Entry[] = [];
    const bad: InvalidTaskFile[] = [];
    const seen = new Set<string>();
    for (const file of files.filter((f) => f.endsWith('.md') && !TEMP_FILE_RE.test(f)).sort()) {
      try {
        const raw = await fs.readFile(safeJoin(this.tasksDir(slug), file), 'utf8');
        const doc = parseTask(raw);
        doc.id = normalizeTaskId(doc.id);
        if (seen.has(doc.id)) throw new Error(`ID duplicado ${doc.id}`);
        seen.add(doc.id);
        entries.push({ doc, file });
      } catch (err) {
        bad.push({ file, error: (err as Error).message });
      }
    }
    entries.sort((a, b) => byOrder(a.doc, b.doc));
    return { board, entries, invalid: bad };
  }

  async scanTasks(slug: string): Promise<{ tasks: Task[]; invalid: InvalidTaskFile[] }> {
    const { entries, invalid: bad } = await this.readEntries(slug);
    return { tasks: entries.map(toTask), invalid: bad };
  }

  async listTasks(slug: string, filter: { status?: string; label?: string } = {}): Promise<Task[]> {
    const { tasks } = await this.scanTasks(slug);
    return tasks.filter(
      (t) => (!filter.status || t.status === filter.status) && (!filter.label || t.labels.includes(filter.label)),
    );
  }

  async getTask(slug: string, id: string): Promise<Task> {
    const taskId = normalizeTaskId(id);
    const { entries } = await this.readEntries(slug);
    const entry = entries.find((e) => e.doc.id === taskId);
    if (!entry) throw new VckbError('NOT_FOUND', `Tarefa não encontrada: ${taskId}`);
    return toTask(entry);
  }

  private async writeEntry(slug: string, entry: Entry): Promise<void> {
    await atomicWrite(safeJoin(this.tasksDir(slug), entry.file), serializeTask(entry.doc));
  }

  /**
   * Coloca `doc` na posição `position` da coluna `status`, renumerando order
   * (10, 20, 30...). Grava apenas os vizinhos cujo order mudou.
   */
  private async place(slug: string, entries: Entry[], doc: TaskDoc, status: string, position: number): Promise<void> {
    const column = entries.filter((e) => e.doc.status === status && e.doc.id !== doc.id).sort((a, b) => byOrder(a.doc, b.doc));
    const pos = Math.max(0, Math.min(position, column.length));
    const ordered: (Entry | null)[] = [...column];
    ordered.splice(pos, 0, null);
    for (const [i, e] of ordered.entries()) {
      const order = (i + 1) * 10;
      if (e === null) doc.order = order;
      else if (e.doc.order !== order) await this.writeEntry(slug, { file: e.file, doc: { ...e.doc, order } });
    }
  }

  private endOrder(entries: Entry[], status: string, exceptId?: string): number {
    const orders = entries.filter((e) => e.doc.status === status && e.doc.id !== exceptId).map((e) => e.doc.order);
    return (orders.length ? Math.max(...orders) : 0) + 10;
  }

  async createTask(slug: string, input: CreateTaskInput): Promise<Task> {
    const title = vString(input.title, 'title', LIMITS.title, { required: true });
    return withLock(this.projectDir(slug), async () => {
      const { board, entries } = await this.readEntries(slug);
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

      // nextId manda, mas nunca reutiliza um ID que já existe em disco (ex.: criado à mão).
      const maxExisting = Math.max(0, ...entries.map((e) => Number(e.doc.id.slice(2))));
      const n = Math.max(board.nextId, maxExisting + 1);
      const id = formatTaskId(n);
      await this.writeBoard(slug, { ...board, nextId: n + 1 });

      const today = this.today();
      const doc: TaskDoc = { id, title, status, priority, labels, order: 0, created: today, updated: today, extra: {}, body };
      if (input.position !== undefined) {
        await this.place(slug, entries, doc, status, vInt(input.position, 'position', 0, 100_000));
      } else {
        doc.order = this.endOrder(entries, status);
      }
      const entry = { doc, file: `${id}-${kebab(title)}.md` };
      await this.writeEntry(slug, entry);
      return toTask(entry);
    });
  }

  async updateTask(slug: string, id: string, patch: UpdateTaskInput): Promise<Task> {
    const taskId = normalizeTaskId(id);
    if (!patch || typeof patch !== 'object' || Object.values(patch).every((v) => v === undefined)) {
      throw invalid('nada para atualizar');
    }
    return withLock(this.projectDir(slug), async () => {
      const { board, entries } = await this.readEntries(slug);
      const entry = entries.find((e) => e.doc.id === taskId);
      if (!entry) throw new VckbError('NOT_FOUND', `Tarefa não encontrada: ${taskId}`);
      const doc: TaskDoc = { ...entry.doc };

      if (patch.title !== undefined) doc.title = vString(patch.title, 'title', LIMITS.title, { required: true });
      if (patch.priority !== undefined) doc.priority = vPriority(patch.priority);
      if (patch.labels !== undefined) doc.labels = vLabels(patch.labels);
      if (patch.body !== undefined) doc.body = vString(patch.body, 'body', LIMITS.body, { multiline: true });
      if (patch.description !== undefined) {
        doc.body = setDescription(doc.body, vString(patch.description, 'description', LIMITS.body, { multiline: true }));
      }
      if (patch.checklist !== undefined) doc.body = setChecklist(doc.body, vChecklist(patch.checklist));
      if (doc.body.length > LIMITS.body) throw invalid(`corpo excede ${LIMITS.body} caracteres`);

      const status = patch.status === undefined ? doc.status : vStatus(board, patch.status);
      const moving = status !== doc.status;
      doc.status = status;

      if (patch.position !== undefined) {
        await this.place(slug, entries, doc, status, vInt(patch.position, 'position', 0, 100_000));
      } else if (patch.order !== undefined) {
        doc.order = vInt(patch.order, 'order', -1_000_000, 1_000_000);
      } else if (moving) {
        doc.order = this.endOrder(entries, status, doc.id);
      }

      doc.updated = this.today();
      const updated = { doc, file: entry.file };
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
      const { entries } = await this.readEntries(slug);
      const entry = entries.find((e) => e.doc.id === taskId);
      if (!entry) throw new VckbError('NOT_FOUND', `Tarefa não encontrada: ${taskId}`);
      const today = this.today();
      const updated = { file: entry.file, doc: { ...entry.doc, body: appendNote(entry.doc.body, note, today), updated: today } };
      await this.writeEntry(slug, updated);
      return toTask(updated);
    });
  }

  async deleteTask(slug: string, id: string): Promise<void> {
    const taskId = normalizeTaskId(id);
    await withLock(this.projectDir(slug), async () => {
      const { entries } = await this.readEntries(slug);
      const entry = entries.find((e) => e.doc.id === taskId);
      if (!entry) throw new VckbError('NOT_FOUND', `Tarefa não encontrada: ${taskId}`);
      await fs.rm(safeJoin(this.tasksDir(slug), entry.file));
    });
  }

  async summary(slug: string, nextLimit = 5): Promise<Summary> {
    const { board, entries, invalid: bad } = await this.readEntries(slug);
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
      invalidFiles: bad,
    };
  }

  /** Próxima tarefa recomendada: a de maior prioridade em "todo" (desempate por order). */
  async nextTask(slug: string): Promise<Task | null> {
    return (await this.summary(slug, 1)).next[0] ?? null;
  }
}
