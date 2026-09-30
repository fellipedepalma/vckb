import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.js';
import { tempWorkspace } from './helpers.js';

/** Boards edited by hand (or by agents writing files directly) must never break VCKB. */

async function setup() {
  const ws = await tempWorkspace();
  await ws.store.createProject({ name: 'App', slug: 'app' });
  const tasks = path.join(ws.boards, 'app', 'tasks');
  const put = (file: string, content: string) => writeFile(path.join(tasks, file), content);
  const read = (file: string) => readFile(path.join(tasks, file), 'utf8');
  const board = async () => JSON.parse(await readFile(path.join(ws.boards, 'app', 'board.json'), 'utf8'));
  return { ...ws, tasks, put, read, board };
}

async function cli(boards: string, ...args: string[]) {
  let out = '';
  let err = '';
  const code = await run([...args, '--dir', boards], { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

const codes = (ws: { code: string }[]) => [...new Set(ws.map((w) => w.code))].sort();

/** Snapshot of every file (name + content + mtime) to prove nothing was written. */
async function snapshot(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(`${path.relative(dir, p)}|${(await stat(p)).mtimeMs}|${await readFile(p, 'utf8')}`);
    }
  };
  await walk(dir);
  return out.sort().join('\n');
}

describe('A1: self-correcting nextId', () => {
  it('uses max(nextId, highest ID in tasks/) + 1 even when board.json fell behind', async () => {
    const { store, put, board } = await setup();
    await put('T-041-by-hand.md', '---\nid: T-041\ntitle: By hand\nstatus: todo\norder: 10\ncreated: 2026-09-01\nupdated: 2026-09-01\n---\n');
    expect((await board()).nextId).toBe(1);
    expect((await store.createTask('app', { title: 'New' })).id).toBe('T-042');
    expect((await board()).nextId).toBe(43);
  });

  it('counts file-name prefixes of unparsable files too (never reuses them)', async () => {
    const { store, put } = await setup();
    await put('T-009-broken.md', '---\ntitle: [unclosed\n---\n');
    expect((await store.createTask('app', { title: 'New' })).id).toBe('T-010');
  });

  it('keeps nextId when it is ahead (IDs of deleted tasks are not reused)', async () => {
    const { store } = await setup();
    await store.createTask('app', { title: 'a' });
    await store.createTask('app', { title: 'b' });
    await store.deleteTask('app', 'T-002');
    expect((await store.createTask('app', { title: 'c' })).id).toBe('T-003');
  });
});

describe('A2: duplicate IDs and orders', () => {
  it('lists both files with a duplicate_id warning instead of dropping one', async () => {
    const { store, put } = await setup();
    await store.createTask('app', { title: 'Original', status: 'todo' });
    await put('T-001-copy.md', '---\nid: T-001\ntitle: Copy\nstatus: todo\norder: 20\ncreated: 2026-09-30\nupdated: 2026-09-30\n---\n');
    const { tasks, warnings } = await store.scanTasks('app');
    expect(tasks.map((t) => t.file)).toEqual(['T-001-original.md', 'T-001-copy.md']);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'duplicate_id', id: 'T-001', files: ['T-001-copy.md', 'T-001-original.md'] }));
  });

  it('refuses to write through an ambiguous ID (CONFLICT) but still reads it', async () => {
    const { store, put } = await setup();
    await store.createTask('app', { title: 'Original' });
    await put('T-001-copy.md', '---\nid: T-001\ntitle: Copy\nstatus: backlog\norder: 20\ncreated: 2026-09-30\nupdated: 2026-09-30\n---\n');
    await expect(store.moveTask('app', 'T-001', 'todo')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.addNote('app', 'T-001', 'x')).rejects.toThrow(/doctor/);
    expect((await store.getTask('app', 'T-001')).file).toBe('T-001-copy.md');
  });

  it('flags repeated orders and renumbers the column when it is rewritten', async () => {
    const { store, put, read } = await setup();
    const task = (id: string, order: number) =>
      put(`${id}-x.md`, `---\nid: ${id}\ntitle: ${id}\nstatus: todo\npriority: low\norder: ${order}\ncreated: 2026-09-30\nupdated: 2026-09-30\n---\n`);
    await task('T-001', 10);
    await task('T-002', 10);
    await task('T-003', 20);
    const { tasks, warnings } = await store.scanTasks('app');
    expect(tasks.map((t) => t.id)).toEqual(['T-001', 'T-002', 'T-003']);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'duplicate_order', column: 'todo' }));

    const created = await store.createTask('app', { title: 'D', status: 'todo' });
    expect(created.order).toBe(40);
    const col = await store.listTasks('app', { status: 'todo' });
    expect(col.map((t) => [t.id, t.order])).toEqual([
      ['T-001', 10],
      ['T-002', 20],
      ['T-003', 30],
      ['T-004', 40],
    ]);
    expect(await read('T-002-x.md')).toContain('order: 20\n');
    expect(codes((await store.scanTasks('app')).warnings)).toEqual([]);
  });

  it('a healthy column is not renumbered on append (no git noise)', async () => {
    const { store, read } = await setup();
    await store.createTask('app', { title: 'a', status: 'todo' });
    await store.createTask('app', { title: 'b', status: 'todo' });
    await store.deleteTask('app', 'T-001');
    const before = await read('T-002-b.md');
    await store.createTask('app', { title: 'c', status: 'todo' });
    expect(await read('T-002-b.md')).toBe(before);
  });
});

describe('A3: incomplete frontmatter', () => {
  it('fills safe defaults, warns, and never crashes', async () => {
    const { store, put } = await setup();
    await put('T-005-quick-idea.md', '---\ntitle: Quick idea\n---\nSome text\n');
    await put('notes-from-agent.md', '---\nstatus: todo\n---\n');
    await put('empty.md', '---\n---\n');
    const { tasks, warnings } = await store.scanTasks('app');
    const byFile = Object.fromEntries(tasks.map((t) => [t.file, t]));

    expect(byFile['T-005-quick-idea.md']).toMatchObject({ id: 'T-005', title: 'Quick idea', status: 'backlog', priority: 'medium', labels: [] });
    expect(byFile['T-005-quick-idea.md'].created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(byFile['notes-from-agent.md']).toMatchObject({ id: 'T-007', title: 'notes from agent', status: 'todo' });
    expect(byFile['empty.md']).toMatchObject({ id: 'T-006', title: 'empty', status: 'backlog' });

    expect(warnings).toContainEqual(
      expect.objectContaining({ code: 'incomplete_frontmatter', file: 'T-005-quick-idea.md', fields: ['id', 'priority', 'order', 'created', 'updated'] }),
    );
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'provisional_id', file: 'notes-from-agent.md', id: 'T-007' }));
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'unknown_status', file: 'empty.md', column: 'backlog' }));
  });

  it('a status outside the columns shows in the first column with a warning', async () => {
    const { store, put } = await setup();
    await put('T-001-x.md', '---\nid: T-001\ntitle: x\nstatus: in-progress\norder: 10\ncreated: 2026-09-30\nupdated: 2026-09-30\n---\n');
    await put('T-002-y.md', '---\nid: T-002\ntitle: y\nstatus: Doing\norder: 10\ncreated: 2026-09-30\nupdated: 2026-09-30\n---\n');
    const { tasks, warnings } = await store.scanTasks('app');
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ['T-001', 'backlog'],
      ['T-002', 'doing'],
    ]);
    expect(warnings.find((w) => w.code === 'unknown_status')?.message).toBe(
      'T-001-x.md: status "in-progress" is not a column; shown in "backlog"',
    );
  });

  it('provisional IDs stay stable: they are persisted before a new task takes the next number', async () => {
    const { store, put, read } = await setup();
    await put('idea.md', '---\ntitle: Idea\n---\n');
    expect((await store.listTasks('app'))[0].id).toBe('T-001');
    expect((await store.createTask('app', { title: 'New' })).id).toBe('T-002');
    expect(await read('idea.md')).toMatch(/^---\nid: T-001\ntitle: Idea\nstatus: backlog\n/);
    expect((await store.getTask('app', 'T-001')).title).toBe('Idea');
  });

  it('writing a defaulted task persists complete frontmatter and keeps the body', async () => {
    const { store, put, read } = await setup();
    await put('T-003-raw.md', '---\ntitle: Raw\nassignee: gemini\n---\nBody stays.\n');
    await store.addNote('app', 'T-003', 'done');
    const raw = await read('T-003-raw.md');
    expect(raw).toMatch(/^---\nid: T-003\ntitle: Raw\nstatus: backlog\npriority: medium\nlabels: \[\]\norder: 10\ncreated: \d{4}-\d{2}-\d{2}\nupdated: 2026-09-30\nassignee: gemini\n---\nBody stays.\n/);
    // Only board.json is still behind (a note does not allocate IDs); the task file is complete now.
    expect(codes((await store.scanTasks('app')).warnings)).toEqual(['next_id_behind']);
  });
});

describe('A4: vckb doctor', () => {
  async function messy() {
    const ws = await setup();
    const full = (id: string, status: string, order: number, extra = '') =>
      `---\nid: ${id}\ntitle: Task ${id}\nstatus: ${status}\npriority: medium\norder: ${order}\ncreated: 2026-09-01\nupdated: 2026-09-01\n${extra}---\nbody of ${id}\n`;
    await ws.put('T-001-a.md', full('T-001', 'todo', 10));
    await ws.put('T-002-b.md', full('T-002', 'todo', 10));
    await ws.put('T-003-c.md', full('T-003', 'todo', 30));
    await ws.put('T-003-copy.md', full('T-003', 'review', 10).replace('created: 2026-09-01', 'created: 2026-09-20'));
    await ws.put('T-007-no-order.md', '---\nid: T-007\ntitle: No order\nstatus: wip\n---\n');
    await ws.put('loose.md', '---\ntitle: Loose\nstatus: todo\n---\n');
    await ws.put('T-008-broken.md', '---\ntitle: [oops\n---\n');
    return ws;
  }

  it('without --fix lists the problems and changes nothing', async () => {
    const { store, boards } = await messy();
    const before = await snapshot(boards);
    const report = await store.doctor('app');
    expect(report.fixed).toBe(false);
    expect(codes(report.warnings)).toEqual([
      'duplicate_id',
      'duplicate_order',
      'incomplete_frontmatter',
      'invalid_file',
      'next_id_behind',
      'provisional_id',
      'unknown_status',
    ]);
    expect(report.nextId).toEqual({ from: 1, to: 11 });
    expect(report.manual.map((w) => w.file)).toEqual(['T-008-broken.md']);
    expect(report.actions).toContainEqual({ file: 'T-003-copy.md', renameTo: 'T-010-copy.md', changes: ['id: T-003 → T-010 (duplicate of T-003-c.md)'] });

    const res = await cli(boards, 'doctor', 'app');
    expect(res.code).toBe(0);
    expect(res.out).toContain('Would fix (run with --fix):');
    expect(res.out).toContain('Needs manual fixing:');
    expect(await snapshot(boards)).toBe(before);
  });

  it('--fix renumbers orders, reassigns duplicates, persists defaults and adjusts nextId', async () => {
    const { store, boards, read, board, tasks } = await messy();
    const res = await cli(boards, 'doctor', 'app', '--fix');
    expect(res.code).toBe(0);
    expect(res.out).toContain('Fixed:');
    expect(res.out).toContain('board.json: nextId 1 → 11');

    expect((await board()).nextId).toBe(11);
    expect((await readdir(tasks)).sort()).toEqual([
      'T-001-a.md',
      'T-002-b.md',
      'T-003-c.md',
      'T-007-no-order.md',
      'T-008-broken.md',
      'T-010-copy.md',
      'loose.md',
    ]);
    expect(await read('T-010-copy.md')).toBe(
      '---\nid: T-010\ntitle: Task T-003\nstatus: review\npriority: medium\nlabels: []\norder: 10\ncreated: 2026-09-20\nupdated: 2026-09-01\n---\nbody of T-003\n',
    );
    const list = await store.listTasks('app');
    const view = (status: string) => list.filter((t) => t.status === status).map((t) => [t.id, t.order]);
    expect(view('todo')).toEqual([
      ['T-001', 10],
      ['T-002', 20],
      ['T-003', 30],
      ['T-009', 40],
    ]);
    expect(view('backlog')).toEqual([['T-007', 10]]);
    expect(await read('loose.md')).toMatch(/^---\nid: T-009\n/);

    const after = await store.doctor('app');
    expect(codes(after.warnings)).toEqual(['invalid_file']);
    expect(after.actions).toEqual([]);
  });

  it('--json returns the report', async () => {
    const { boards } = await messy();
    const res = await cli(boards, 'doctor', 'app', '--json');
    expect(JSON.parse(res.out)).toMatchObject({ project: 'app', fixed: false, nextId: { from: 1, to: 11 } });
  });

  it('a clean board reports no problems', async () => {
    const { store, boards } = await setup();
    await store.createTask('app', { title: 'ok' });
    expect((await cli(boards, 'doctor', 'app')).out).toBe('app: no problems found.\n');
  });
});

describe('A2/A3 in the CLI listing', () => {
  it('list prints warnings to stderr and --json carries them', async () => {
    const { boards, put } = await setup();
    await put('T-001-x.md', '---\nid: T-001\ntitle: x\nstatus: nope\n---\n');
    const text = await cli(boards, 'list', 'app');
    expect(text.code).toBe(0);
    expect(text.out).toContain('backlog (1)\n  T-001  [medium]  x\n');
    expect(text.err).toContain('warning: T-001-x.md: status "nope" is not a column; shown in "backlog"');
    expect(text.err).toContain('Run "vckb doctor app" for details.');
    const json = JSON.parse((await cli(boards, 'list', 'app', '--json')).out);
    expect(json.tasks).toHaveLength(1);
    expect(codes(json.warnings)).toEqual(['incomplete_frontmatter', 'next_id_behind', 'unknown_status']);
  });
});
