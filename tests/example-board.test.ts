import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../src/core/paths.js';
import { BoardStore } from '../src/core/store.js';

describe('shipped example board', () => {
  it('boards/example parses cleanly with one task per column', async () => {
    const store = new BoardStore(path.join(PACKAGE_ROOT, 'boards'));
    const summary = await store.summary('example');
    expect(summary.invalidFiles).toEqual([]);
    expect(summary.project).toEqual({ slug: 'example', name: 'Example' });
    expect(summary.columns.map((c) => c.count)).toEqual([1, 1, 1, 1, 1]);
    const tasks = await store.listTasks('example');
    expect(tasks.every((t) => t.body.includes('## Agent notes'))).toBe(true);
  });
});
