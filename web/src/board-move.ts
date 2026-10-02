/**
 * Moving a card, as the server does it (`BoardStore.place` in src/core/store.ts):
 * - `position` is the index in the target column with the moved task taken out (0 = top),
 *   clamped to [0, n];
 * - the target column is renumbered 10, 20, 30… in that order; other columns keep their values.
 * The UI applies this optimistically, so after a successful PATCH the server's state is identical.
 *
 * Self-contained on purpose (no imports): tests/board-move-equivalence.test.ts runs it against the
 * real store to prove both sides agree.
 */
export interface Movable {
  id: string;
  file: string;
  status: string;
  order: number;
}

/** Same ordering as the server: order, then ID, then file name. */
export const byBoardOrder = (a: Movable, b: Movable) => a.order - b.order || a.id.localeCompare(b.id) || a.file.localeCompare(b.file);

export function columnOf<T extends Movable>(tasks: T[], status: string): T[] {
  return tasks.filter((t) => t.status === status).sort(byBoardOrder);
}

/**
 * The tasks after moving `file` to `status` at `position`, or null when nothing would change
 * (same column, same place): the UI then sends no request at all.
 */
export function applyMove<T extends Movable>(tasks: T[], file: string, status: string, position: number): T[] | null {
  const moving = tasks.find((t) => t.file === file);
  if (!moving) return null;
  const others = tasks.filter((t) => t.status === status && t.file !== file).sort(byBoardOrder);
  const pos = Math.max(0, Math.min(Math.trunc(position), others.length));
  if (moving.status === status && columnOf(tasks, status).findIndex((t) => t.file === file) === pos) return null;
  const ordered = [...others];
  ordered.splice(pos, 0, moving);
  const order = new Map(ordered.map((t, i) => [t.file, (i + 1) * 10]));
  return tasks.map((t) => (order.has(t.file) ? { ...t, status, order: order.get(t.file)! } : t));
}
