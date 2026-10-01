import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli/run.js';
import { tempWorkspace } from './helpers.js';

async function cli(boards: string, ...args: string[]) {
  let out = '';
  let err = '';
  const code = await run([...args, '--dir', boards], { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

describe('CLI', () => {
  it('add / list / move / note / next / done straight on the files', async () => {
    process.env.VCKB_TODAY = '2026-09-30';
    try {
      const { store, boards } = await tempWorkspace();
      await store.createProject({ name: 'App', slug: 'app' });

      expect((await cli(boards, 'projects')).out).toContain('app  —  App');

      const add = await cli(boards, 'add', 'app', 'Set up CI', '--priority', 'high', '--label', 'infra', '--label', 'ci', '--status', 'todo');
      expect(add).toMatchObject({ code: 0, out: 'Created T-001 in "todo": Set up CI\n' });
      await cli(boards, 'add', 'app', 'Another', '--status', 'todo');

      const list = await cli(boards, 'list', 'app', '--status', 'todo');
      expect(list.out).toBe('todo (2)\n  T-001  [high]  Set up CI  #infra #ci\n  T-002  [medium]  Another\n');

      expect((await cli(boards, 'next', 'app')).out).toMatch(/^T-001 — Set up CI/);

      expect((await cli(boards, 'move', 'app', 'T-001', 'doing')).out).toBe('T-001 → doing\n');
      expect((await cli(boards, 'note', 'app', 'T-001', 'picked GitHub Actions')).out).toBe('Note added to T-001\n');
      expect((await cli(boards, 'done', 'app', 'T-001')).out).toBe('T-001 → done\n');

      const raw = await readFile(path.join(boards, 'app', 'tasks', 'T-001-set-up-ci.md'), 'utf8');
      expect(raw).toContain('status: done\n');
      expect(raw).toContain(`## Agent notes\n\n- 2026-09-30: picked GitHub Actions\n`);

      const json = await cli(boards, 'list', 'app', '--json');
      expect(JSON.parse(json.out)).toMatchObject({ tasks: [{ id: 'T-001' }, { id: 'T-002' }], warnings: [] });
    } finally {
      delete process.env.VCKB_TODAY;
    }
  });

  it('errors go to stderr with a non-zero exit code', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'App', slug: 'app' });
    await cli(boards, 'add', 'app', 'x');
    expect(await cli(boards, 'move', 'app', 'T-001', 'finished')).toMatchObject({ code: 1, err: expect.stringMatching(/invalid status/) });
    expect(await cli(boards, 'move', 'app', '../x', 'todo')).toMatchObject({ code: 1, err: expect.stringMatching(/Invalid task ID/) });
    expect(await cli(boards, 'list', '../..')).toMatchObject({ code: 1, err: expect.stringMatching(/Invalid project slug/) });
    expect((await cli(boards, 'fly')).code).toBe(2);
    expect((await cli(boards, 'list', 'app', '--xyz')).code).toBe(2);
  });
});
