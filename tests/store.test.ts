import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempWorkspace } from './helpers.js';

async function setup() {
  const ws = await tempWorkspace();
  await ws.store.createProject({ name: 'My App', slug: 'app' });
  return ws;
}

const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

describe('projects', () => {
  it('creates board.json with default columns and lists the project', async () => {
    const { store, boards } = await tempWorkspace();
    const p = await store.createProject({ name: 'Online Shop' });
    expect(p.slug).toBe('online-shop');
    const board = JSON.parse(await readFile(path.join(boards, 'online-shop', 'board.json'), 'utf8'));
    expect(board).toEqual({ name: 'Online Shop', description: '', columns: ['backlog', 'todo', 'doing', 'review', 'done'], nextId: 1 });
    expect((await store.listProjects()).map((x) => x.slug)).toEqual(['online-shop']);
    await expect(store.createProject({ name: 'Online Shop' })).rejects.toThrow(/already exists/);
  });
});

describe('create task', () => {
  it('assigns sequential IDs, writes T-NNN-kebab.md and bumps nextId', async () => {
    const { store, boards } = await setup();
    const a = await store.createTask('app', { title: 'Café Login Page', priority: 'high', labels: ['ui'] });
    const b = await store.createTask('app', { title: 'Second', status: 'todo', checklist: [{ text: 'x', done: false }] });
    expect([a.id, b.id]).toEqual(['T-001', 'T-002']);
    expect(a.status).toBe('backlog');
    expect(a.file).toBe('T-001-cafe-login-page.md');
    expect(b.progress).toEqual({ done: 0, total: 1 });
    const raw = await readFile(path.join(boards, 'app', 'tasks', a.file), 'utf8');
    expect(raw).toBe(
      '---\nid: T-001\ntitle: Café Login Page\nstatus: backlog\npriority: high\nlabels: [ui]\norder: 10\n' +
        'created: 2026-09-30\nupdated: 2026-09-30\n---\n## Checklist\n\n## Agent notes\n',
    );
    const board = JSON.parse(await readFile(path.join(boards, 'app', 'board.json'), 'utf8'));
    expect(board.nextId).toBe(3);
  });

  it('concurrent creations never duplicate IDs (lock + atomic write)', async () => {
    const { store } = await setup();
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => store.createTask('app', { title: `t${i}` })));
    expect(new Set(ids(created)).size).toBe(12);
    expect((await store.getProject('app')).nextId).toBe(13);
  });

  it('does not reuse the ID of a hand-made file that did not bump nextId', async () => {
    const { store, boards } = await setup();
    await writeFile(path.join(boards, 'app', 'tasks', 'T-007-manual.md'), '---\nid: T-007\ntitle: Manual\nstatus: todo\n---\n');
    const t = await store.createTask('app', { title: 'New' });
    expect(t.id).toBe('T-008');
  });

  it('validates status against the board columns', async () => {
    const { store } = await setup();
    await expect(store.createTask('app', { title: 'x', status: 'finished' })).rejects.toThrow(/invalid status/);
  });

  it('leaves no temp files or lock behind', async () => {
    const { store, boards } = await setup();
    await store.createTask('app', { title: 'x' });
    expect(await readdir(path.join(boards, 'app'))).toEqual(['board.json', 'tasks']);
    expect(await readdir(path.join(boards, 'app', 'tasks'))).toEqual(['T-001-x.md']);
  });
});

describe('move and reorder', () => {
  async function withColumn() {
    const ws = await setup();
    for (const title of ['A', 'B', 'C']) await ws.store.createTask('app', { title, status: 'todo' });
    return ws;
  }

  it('moves to the end of another column and keeps the body', async () => {
    const { store, boards } = await withColumn();
    await store.addNote('app', 'T-001', 'a note');
    const before = await store.getTask('app', 'T-001');
    await store.createTask('app', { title: 'D', status: 'doing' });
    const moved = await store.moveTask('app', 'T-001', 'doing');
    expect(moved).toMatchObject({ status: 'doing', order: 20 });
    expect(moved.body).toBe(before.body);
    const raw = await readFile(path.join(boards, 'app', 'tasks', moved.file), 'utf8');
    expect(raw).toContain('status: doing\n');
    expect(raw).toContain('- 2026-09-30: a note');
  });

  it('rejects a column that does not exist', async () => {
    const { store } = await withColumn();
    await expect(store.moveTask('app', 'T-001', 'nope')).rejects.toThrow(/invalid status/);
  });

  it('reorders within the column via position and renumbers 10, 20, 30', async () => {
    const { store } = await withColumn();
    await store.updateTask('app', 'T-003', { position: 0 });
    const col = await store.listTasks('app', { status: 'todo' });
    expect(ids(col)).toEqual(['T-003', 'T-001', 'T-002']);
    expect(col.map((t) => t.order)).toEqual([10, 20, 30]);
  });

  it('moves to a specific position in another column', async () => {
    const { store } = await withColumn();
    await store.moveTask('app', 'T-001', 'doing');
    await store.moveTask('app', 'T-002', 'doing');
    await store.moveTask('app', 'T-003', 'doing', 1);
    expect(ids(await store.listTasks('app', { status: 'doing' }))).toEqual(['T-001', 'T-003', 'T-002']);
    expect(await store.listTasks('app', { status: 'todo' })).toEqual([]);
  });

  it('accepts loosely formatted IDs (t-1)', async () => {
    const { store } = await withColumn();
    expect((await store.moveTask('app', 't-1', 'review')).id).toBe('T-001');
  });
});

describe('edit, notes, delete, summary', () => {
  it('PATCH of description and checklist keeps the notes', async () => {
    const { store } = await setup();
    await store.createTask('app', { title: 'x', description: 'old', checklist: [{ text: 'a', done: false }] });
    await store.addNote('app', 'T-001', 'note 1');
    const t = await store.updateTask('app', 'T-001', {
      description: 'new',
      checklist: [
        { text: 'a', done: true },
        { text: 'b', done: false },
      ],
      labels: ['ui', 'ui', 'api'],
    });
    expect(t.description).toBe('new');
    expect(t.progress).toEqual({ done: 1, total: 2 });
    expect(t.labels).toEqual(['ui', 'api']);
    expect(t.body).toContain('- 2026-09-30: note 1');
  });

  it('deletes and then reports not found', async () => {
    const { store } = await setup();
    await store.createTask('app', { title: 'x' });
    await store.deleteTask('app', 'T-001');
    await expect(store.getTask('app', 'T-001')).rejects.toThrow(/not found/);
  });

  it('summary counts per column and sorts "todo" by priority; next returns the first', async () => {
    const { store } = await setup();
    await store.createTask('app', { title: 'low', status: 'todo', priority: 'low' });
    await store.createTask('app', { title: 'medium', status: 'todo' });
    await store.createTask('app', { title: 'high', status: 'todo', priority: 'high' });
    await store.createTask('app', { title: 'in progress', status: 'doing', priority: 'high' });
    const s = await store.summary('app');
    expect(s.columns).toEqual([
      { name: 'backlog', count: 0 },
      { name: 'todo', count: 3 },
      { name: 'doing', count: 1 },
      { name: 'review', count: 0 },
      { name: 'done', count: 0 },
    ]);
    expect(s.next.map((t) => t.title)).toEqual(['high', 'medium', 'low']);
    expect((await store.nextTask('app'))?.title).toBe('high');
  });

  it('invalid files do not break the listing and are reported in the summary', async () => {
    const { store, boards } = await setup();
    await store.createTask('app', { title: 'ok' });
    await writeFile(path.join(boards, 'app', 'tasks', 'broken.md'), 'no frontmatter');
    expect(ids(await store.listTasks('app'))).toEqual(['T-001']);
    expect((await store.summary('app')).invalidFiles).toEqual([{ file: 'broken.md', error: 'frontmatter is missing "id"' }]);
  });
});
