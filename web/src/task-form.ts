/**
 * The task details form, as pure functions (no React): what the fields hold, how they are checked
 * before a request is sent, and which fields changed. Self-contained on purpose (no imports):
 * the limits and the label rule are copies of the server's (`LIMITS` and `LABEL_RE` in
 * src/core/store.ts); tests/task-form-equivalence.test.ts runs both sides against the real store.
 */
export const FORM_LIMITS = { title: 200, description: 100_000, labels: 20 } as const;

/** Same rule as the server: starts with a letter or digit, then letters, digits, `_`, `.`, `-`; 32 max. */
export const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,31}$/u;

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type FormPriority = (typeof PRIORITIES)[number];

/** What the form shows: labels are one comma-separated text field. */
export interface FormValues {
  title: string;
  status: string;
  priority: string;
  labels: string;
  description: string;
}

/** The part of a task the form edits. */
export interface FormTask {
  title: string;
  status: string;
  priority: string;
  labels: string[];
  description: string;
}

/** The body of the PATCH: only what changed. Never `body`, `checklist` or `position`. */
export interface TaskPatch {
  title?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  description?: string;
}

export type FormField = 'title' | 'status' | 'priority' | 'labels' | 'description';

export type FieldError =
  | { kind: 'required' }
  | { kind: 'tooLong'; max: number }
  | { kind: 'lineBreak' }
  | { kind: 'badLabel'; label: string }
  | { kind: 'tooManyLabels'; max: number }
  | { kind: 'unknownValue' }
  | { kind: 'server'; message: string };

export type FormErrors = Partial<Record<FormField, FieldError>>;

export const toFormValues = (task: FormTask): FormValues => ({
  title: task.title,
  status: task.status,
  priority: task.priority,
  labels: task.labels.join(', '),
  description: task.description,
});

/** "ui, forms,, ui" -> ["ui", "forms"]: split on commas, trimmed, empties dropped, first one kept. */
export function parseLabels(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(',')) {
    const label = part.trim();
    if (label) seen.add(label);
  }
  return [...seen];
}

/** Checks the values the way the server will; an empty result means a request can be sent. */
export function validateForm(values: FormValues, columns: readonly string[]): FormErrors {
  const errors: FormErrors = {};
  const title = values.title.trim();
  if (!title) errors.title = { kind: 'required' };
  else if (/[\r\n]/.test(title)) errors.title = { kind: 'lineBreak' };
  else if (title.length > FORM_LIMITS.title) errors.title = { kind: 'tooLong', max: FORM_LIMITS.title };

  if (!columns.includes(values.status)) errors.status = { kind: 'unknownValue' };
  if (!(PRIORITIES as readonly string[]).includes(values.priority)) errors.priority = { kind: 'unknownValue' };

  const labels = parseLabels(values.labels);
  const bad = labels.find((l) => !LABEL_RE.test(l));
  if (bad !== undefined) errors.labels = { kind: 'badLabel', label: bad };
  else if (labels.length > FORM_LIMITS.labels) errors.labels = { kind: 'tooManyLabels', max: FORM_LIMITS.labels };

  if (values.description.trim().length > FORM_LIMITS.description) errors.description = { kind: 'tooLong', max: FORM_LIMITS.description };
  return errors;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The PATCH body for `values` against the task as it was loaded: only the fields that changed.
 * Title and description are compared trimmed (the server trims both), so a stray space is no change.
 * Status is sent without a position: the server then puts the card at the end of the new column.
 * Returns {} when nothing changed.
 */
export function diffForm(task: FormTask, values: FormValues): TaskPatch {
  const patch: TaskPatch = {};
  const title = values.title.trim();
  if (title !== task.title) patch.title = title;
  if (values.status !== task.status) patch.status = values.status;
  if (values.priority !== task.priority) patch.priority = values.priority;
  const labels = parseLabels(values.labels);
  if (!sameList(labels, task.labels)) patch.labels = labels;
  if (values.description.trim() !== task.description.trim()) patch.description = values.description.trim();
  return patch;
}

export const isDirty = (task: FormTask, values: FormValues) => Object.keys(diffForm(task, values)).length > 0;

/**
 * Which field a server 400 is about, from its message (`"title" is required`, `invalid label: "x"`,
 * `at most 20 labels`, `invalid status: ...`, `body exceeds ...`); null when it names none.
 */
export function fieldOfServerError(message: string): FormField | null {
  const quoted = /^"(title|status|priority|description)"/.exec(message);
  if (quoted) return quoted[1] as FormField;
  if (/^(invalid label|at most \d+ labels|"labels")/.test(message)) return 'labels';
  if (/^invalid status/.test(message)) return 'status';
  if (/^body exceeds/.test(message)) return 'description';
  return null;
}
