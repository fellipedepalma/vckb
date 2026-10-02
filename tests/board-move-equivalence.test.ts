import { describe, expect, it } from 'vitest';
import { applyMove, columnOf } from '../web/src/board-move.js';
import { tempWorkspace } from './helpers.js';

/**
 * The UI moves cards optimistically with applyMove(). This proves it predicts exactly what the
 * server writes: the same moves applied to the real store (in a temp dir) give the same order.
 */
describe('UI move prediction == server', () => {
  it('matches the store for a sequence of cross-column, empty-column and same-column moves', async () => {
    const { store } = await tempWorkspace();
    await store.createProject({ name: 'App', slug: 'app' });
    for (const [title, status] of [
      ['a', 'todo'],
      ['b', 'todo'],
      ['c', 'todo'],
      ['d', 'todo'],
      ['e', 'doing'],
      ['f', 'doing'],
      ['g', 'backlog'],
    ]) {
      await store.createTask('app', { title, status });
    }
    const moves: [string, string, number][] = [
      ['T-002', 'doing', 0], // to the top of another column
      ['T-004', 'doing', 99], // past the end: clamped
      ['T-001', 'review', 0], // empty column
      ['T-003', 'todo', 0], // same column, no-op candidate
      ['T-005', 'doing', 2], // down within the column
      ['T-006', 'doing', 0], // up within the column
      ['T-007', 'done', 0], // empty Done
      ['T-002', 'todo', 1], // back, in the middle
    ];
    const columns = (await store.getProject('app')).columns;
    let predicted = await store.listTasks('app');
    for (const [id, status, position] of moves) {
      const file = predicted.find((x) => x.id === id)!.file;
      const next = applyMove(predicted, file, status, position);
      if (next) {
        predicted = next;
        await store.moveTask('app', id, status, position);
      }
      const actual = await store.listTasks('app');
      for (const c of columns) {
        const label = `after ${id} -> ${status}@${position}, column ${c}`;
        expect(columnOf(predicted, c).map((x) => x.id), label).toEqual(columnOf(actual, c).map((x) => x.id));
        expect(columnOf(predicted, c).map((x) => x.order), label).toEqual(columnOf(actual, c).map((x) => x.order));
      }
    }
  });

  it('a no-op predicted by the UI is also a no-op on the server', async () => {
    const { store } = await tempWorkspace();
    await store.createProject({ name: 'App', slug: 'app' });
    for (const title of ['a', 'b', 'c']) await store.createTask('app', { title, status: 'todo' });
    const tasks = await store.listTasks('app');
    expect(applyMove(tasks, tasks[1].file, 'todo', 1)).toBeNull();
    await store.moveTask('app', tasks[1].id, 'todo', 1);
    const after = await store.listTasks('app', { status: 'todo' });
    expect(after.map((x) => [x.id, x.order])).toEqual(tasks.map((x) => [x.id, x.order]));
  });
});
