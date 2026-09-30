import type { BoardWarning, Task } from './types';

/** Files mentioned by warnings (a task shows a warning mark if its file is one of them). */
export function filesWithWarnings(warnings: BoardWarning[]): Set<string> {
  const out = new Set<string>();
  for (const w of warnings) {
    if (w.file) out.add(w.file);
    for (const f of w.files ?? []) out.add(f);
  }
  return out;
}

/** Tasks per column, in board order; each column sorted by `order` (then ID, like the server). */
export function groupByColumn(columns: string[], tasks: Task[]): Map<string, Task[]> {
  const groups = new Map<string, Task[]>(columns.map((c) => [c, []]));
  for (const t of tasks) groups.get(t.status)?.push(t);
  for (const list of groups.values()) list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id) || a.file.localeCompare(b.file));
  return groups;
}

/** The column where agents hand work to the human. Highlighted; there is only one meaning for marigold. */
export const REVIEW_COLUMN = 'review';

/** Finished work: shown quieter so open work stands out. */
export const DONE_COLUMN = 'done';
