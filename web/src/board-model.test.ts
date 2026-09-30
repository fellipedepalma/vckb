import { describe, expect, it } from 'vitest';
import { filesWithWarnings, groupByColumn } from './board-model';
import type { Task } from './types';

const task = (id: string, status: string, order: number, file = `${id}.md`) => ({ id, status, order, file }) as Task;

describe('board model', () => {
  it('groups by column in board order and sorts by order, then ID, then file', () => {
    const groups = groupByColumn(
      ['todo', 'done'],
      [task('T-003', 'todo', 20), task('T-001', 'done', 10), task('T-002', 'todo', 10), task('T-002', 'todo', 10, 'T-002-copy.md'), task('T-009', 'gone', 10)],
    );
    expect([...groups.keys()]).toEqual(['todo', 'done']);
    expect(groups.get('todo')!.map((t) => t.file)).toEqual(['T-002-copy.md', 'T-002.md', 'T-003.md']);
    expect(groups.get('done')!.map((t) => t.id)).toEqual(['T-001']);
  });

  it('collects files mentioned by warnings (single file or duplicate groups)', () => {
    const files = filesWithWarnings([
      { code: 'incomplete_frontmatter', message: '', file: 'a.md' },
      { code: 'duplicate_id', message: '', files: ['b.md', 'c.md'] },
      { code: 'next_id_behind', message: '' },
    ]);
    expect([...files].sort()).toEqual(['a.md', 'b.md', 'c.md']);
  });
});
