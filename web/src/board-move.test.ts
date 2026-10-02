import { describe, expect, it } from 'vitest';
import { applyMove, columnOf, type Movable } from './board-move';

const t = (id: string, status: string, order: number): Movable => ({ id, file: `${id}.md`, status, order });
const board = () => [t('T-001', 'todo', 10), t('T-002', 'todo', 20), t('T-003', 'todo', 30), t('T-004', 'doing', 10)];
const ids = (tasks: Movable[] | null, status: string) => columnOf(tasks!, status).map((x) => x.id);

describe('applyMove (mirror of the server)', () => {
  it('moves between columns at a position and renumbers only the target column', () => {
    const next = applyMove(board(), 'T-002.md', 'doing', 0)!;
    expect(ids(next, 'doing')).toEqual(['T-002', 'T-004']);
    expect(columnOf(next, 'doing').map((x) => x.order)).toEqual([10, 20]);
    expect(ids(next, 'todo')).toEqual(['T-001', 'T-003']);
    expect(columnOf(next, 'todo').map((x) => x.order)).toEqual([10, 30]); // source keeps its gaps
  });

  it('drops into an empty column', () => {
    const next = applyMove(board(), 'T-001.md', 'review', 0)!;
    expect(ids(next, 'review')).toEqual(['T-001']);
    expect(next.find((x) => x.id === 'T-001')).toMatchObject({ status: 'review', order: 10 });
  });

  it('top and end (positions past the end are clamped)', () => {
    expect(ids(applyMove(board(), 'T-004.md', 'todo', 0), 'todo')).toEqual(['T-004', 'T-001', 'T-002', 'T-003']);
    expect(ids(applyMove(board(), 'T-004.md', 'todo', 3), 'todo')).toEqual(['T-001', 'T-002', 'T-003', 'T-004']);
    expect(ids(applyMove(board(), 'T-004.md', 'todo', 99), 'todo')).toEqual(['T-001', 'T-002', 'T-003', 'T-004']);
  });

  it('reorders up and down within a column', () => {
    expect(ids(applyMove(board(), 'T-003.md', 'todo', 0), 'todo')).toEqual(['T-003', 'T-001', 'T-002']);
    expect(ids(applyMove(board(), 'T-001.md', 'todo', 2), 'todo')).toEqual(['T-002', 'T-003', 'T-001']);
    expect(ids(applyMove(board(), 'T-001.md', 'todo', 1), 'todo')).toEqual(['T-002', 'T-001', 'T-003']);
  });

  it('dropping in the same place is a no-op (null: no request is sent)', () => {
    expect(applyMove(board(), 'T-002.md', 'todo', 1)).toBeNull();
    expect(applyMove(board(), 'T-004.md', 'doing', 0)).toBeNull();
    expect(applyMove(board(), 'missing.md', 'todo', 0)).toBeNull();
  });

  it('does not mutate its input', () => {
    const before = board();
    const copy = JSON.stringify(before);
    applyMove(before, 'T-001.md', 'doing', 0);
    expect(JSON.stringify(before)).toBe(copy);
  });
});
