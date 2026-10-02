/**
 * Keyboard moves while a card is picked up (Space): one arrow press = one step.
 *   ArrowUp / ArrowDown     one position up / down in the same column
 *   ArrowLeft / ArrowRight  the adjacent column, keeping the index (clamped to the end; empty
 *                           columns are reachable)
 * An arrow against an edge is a no-op (null). Pure, so it can be tested apart from dnd-kit.
 * `items` maps each column to its card ids (file names), top to bottom, the moving card included.
 */
export type Items = Record<string, string[]>;
export const ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type ArrowKey = (typeof ARROW_KEYS)[number];

export const isArrowKey = (code: string): code is ArrowKey => (ARROW_KEYS as readonly string[]).includes(code);

/** Where a card is: its column, 0-based index and the column's size (card included). */
export function locate(columns: string[], items: Items, id: string): { column: string; index: number; total: number } | null {
  for (const column of columns) {
    const index = (items[column] ?? []).indexOf(id);
    if (index >= 0) return { column, index, total: items[column].length };
  }
  return null;
}

export function keyboardMove(columns: string[], items: Items, id: string, key: ArrowKey): Items | null {
  const at = locate(columns, items, id);
  if (!at) return null;
  const list = items[at.column];
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const to = at.index + (key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= list.length) return null;
    const next = [...list];
    next.splice(at.index, 1);
    next.splice(to, 0, id);
    return { ...items, [at.column]: next };
  }
  const c = columns.indexOf(at.column) + (key === 'ArrowLeft' ? -1 : 1);
  if (c < 0 || c >= columns.length) return null;
  const target = columns[c];
  const others = (items[target] ?? []).filter((x) => x !== id);
  const index = Math.min(at.index, others.length);
  others.splice(index, 0, id);
  return { ...items, [at.column]: list.filter((x) => x !== id), [target]: others };
}
