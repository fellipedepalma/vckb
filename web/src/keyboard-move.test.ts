import { describe, expect, it } from 'vitest';
import { type Items, keyboardMove, locate } from './keyboard-move';

const columns = ['backlog', 'todo', 'doing', 'review', 'done'];
const board = (): Items => ({ backlog: [], todo: ['a', 'b', 'c'], doing: ['d'], review: [], done: ['e', 'f'] });

describe('keyboardMove', () => {
  it('up and down move one position inside the column', () => {
    expect(keyboardMove(columns, board(), 'b', 'ArrowUp')!.todo).toEqual(['b', 'a', 'c']);
    expect(keyboardMove(columns, board(), 'b', 'ArrowDown')!.todo).toEqual(['a', 'c', 'b']);
  });

  it('an arrow against an edge is a no-op', () => {
    expect(keyboardMove(columns, board(), 'a', 'ArrowUp')).toBeNull(); // top
    expect(keyboardMove(columns, board(), 'c', 'ArrowDown')).toBeNull(); // bottom
    expect(keyboardMove(columns, { ...board(), backlog: ['x'] }, 'x', 'ArrowLeft')).toBeNull(); // first column
    expect(keyboardMove(columns, board(), 'f', 'ArrowRight')).toBeNull(); // last column
    expect(keyboardMove(columns, board(), 'missing', 'ArrowDown')).toBeNull();
  });

  it('left and right keep the index, clamped to the end of a shorter column', () => {
    const r = keyboardMove(columns, board(), 'c', 'ArrowRight')!; // index 2 -> doing has 1 card
    expect(r.todo).toEqual(['a', 'b']);
    expect(r.doing).toEqual(['d', 'c']);
    const l = keyboardMove(columns, board(), 'a', 'ArrowRight')!; // index 0 stays 0
    expect(l.doing).toEqual(['a', 'd']);
  });

  it('empty columns are reachable in both directions', () => {
    const toReview = keyboardMove(columns, board(), 'd', 'ArrowRight')!;
    expect(toReview.review).toEqual(['d']);
    expect(toReview.doing).toEqual([]);
    const toBacklog = keyboardMove(columns, board(), 'b', 'ArrowLeft')!;
    expect(toBacklog.backlog).toEqual(['b']);
  });

  it('does not mutate its input and locate() reports 0-based index and column size', () => {
    const before = board();
    const copy = JSON.stringify(before);
    keyboardMove(columns, before, 'a', 'ArrowRight');
    expect(JSON.stringify(before)).toBe(copy);
    expect(locate(columns, before, 'c')).toEqual({ column: 'todo', index: 2, total: 3 });
    expect(locate(columns, before, 'zzz')).toBeNull();
  });
});
