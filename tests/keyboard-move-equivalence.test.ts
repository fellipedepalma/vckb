import { describe, expect, it } from 'vitest';
import { applyMove, columnOf } from '../web/src/board-move.js';
import { type ArrowKey, type Items, keyboardMove, locate } from '../web/src/keyboard-move.js';
import { tempWorkspace } from './helpers.js';

/**
 * A keyboard move (pick up, arrows, drop) ends as one PATCH { status, position } with the card's
 * final column and index. This proves that the final order the UI shows equals what the server
 * writes for that PATCH, for sequences that cross columns, hit edges and visit empty columns.
 */
describe('keyboard move prediction == server', () => {
  it('matches the store after each pick-up/arrows/drop sequence', async () => {
    const { store } = await tempWorkspace();
    await store.createProject({ name: 'App', slug: 'app' });
    for (const [title, status] of [
      ['a', 'todo'],
      ['b', 'todo'],
      ['c', 'todo'],
      ['d', 'doing'],
      ['e', 'done'],
    ]) {
      await store.createTask('app', { title, status });
    }
    const { columns } = await store.getProject('app');
    const sequences: [string, ArrowKey[]][] = [
      ['T-003', ['ArrowRight']], // index 2 clamped to the end of Doing
      ['T-001', ['ArrowRight', 'ArrowRight']], // through Doing into empty Review
      ['T-002', ['ArrowUp', 'ArrowUp', 'ArrowLeft']], // edge no-op, then empty Backlog
      ['T-004', ['ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowUp']], // into Done, up
      ['T-005', ['ArrowLeft', 'ArrowDown', 'ArrowRight']], // there and back (same column)
    ];
    for (const [id, keys] of sequences) {
      const tasks = await store.listTasks('app');
      const file = tasks.find((t) => t.id === id)!.file;
      let items: Items = Object.fromEntries(columns.map((c) => [c, columnOf(tasks, c).map((t) => t.file)]));
      for (const key of keys) items = keyboardMove(columns, items, file, key) ?? items;
      const end = locate(columns, items, file)!;
      // Same rule as the UI: no PATCH when the card ends where it started.
      if (applyMove(tasks, file, end.column, end.index)) await store.moveTask('app', id, end.column, end.index);
      const actual = await store.listTasks('app');
      for (const c of columns) {
        // The order the keyboard produced is exactly what the server ends with.
        expect(columnOf(actual, c).map((t) => t.file), `${id} ${keys.join(',')} column ${c}`).toEqual(items[c]);
      }
    }
  });
});
