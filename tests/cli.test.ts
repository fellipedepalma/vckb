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
  it('add / list / move / note / next / done direto nos arquivos', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'App', slug: 'app' });

    expect((await cli(boards, 'projects')).out).toContain('app  —  App');

    const add = await cli(boards, 'add', 'app', 'Configurar CI', '--priority', 'high', '--label', 'infra', '--label', 'ci', '--status', 'todo');
    expect(add).toMatchObject({ code: 0, out: 'Criada T-001 em "todo": Configurar CI\n' });
    await cli(boards, 'add', 'app', 'Outra', '--status', 'todo');

    const list = await cli(boards, 'list', 'app', '--status', 'todo');
    expect(list.out).toBe('todo (2)\n  T-001  [alta]  Configurar CI  #infra #ci\n  T-002  [média]  Outra\n');

    expect((await cli(boards, 'next', 'app')).out).toMatch(/^T-001 — Configurar CI/);

    expect((await cli(boards, 'move', 'app', 'T-001', 'doing')).out).toBe('T-001 → doing\n');
    expect((await cli(boards, 'note', 'app', 'T-001', 'escolhi GitHub Actions')).out).toBe('Nota adicionada em T-001\n');
    expect((await cli(boards, 'done', 'app', 'T-001')).out).toBe('T-001 → done\n');

    const raw = await readFile(path.join(boards, 'app', 'tasks', 'T-001-configurar-ci.md'), 'utf8');
    expect(raw).toContain('status: done\n');
    expect(raw).toContain('## Notas do agente\n\n- 2026-09-30: escolhi GitHub Actions\n'.replace('2026-09-30', store.today()));

    const json = await cli(boards, 'list', 'app', '--json');
    expect(JSON.parse(json.out)).toHaveLength(2);
  });

  it('erros saem no stderr com código != 0', async () => {
    const { store, boards } = await tempWorkspace();
    await store.createProject({ name: 'App', slug: 'app' });
    await cli(boards, 'add', 'app', 'x');
    expect(await cli(boards, 'move', 'app', 'T-001', 'feito')).toMatchObject({ code: 1, err: expect.stringMatching(/status inválido/) });
    expect(await cli(boards, 'move', 'app', '../x', 'todo')).toMatchObject({ code: 1, err: expect.stringMatching(/ID de tarefa inválido/) });
    expect(await cli(boards, 'list', '../..')).toMatchObject({ code: 1, err: expect.stringMatching(/Slug de projeto inválido/) });
    expect((await cli(boards, 'voar')).code).toBe(2);
    expect((await cli(boards, 'list', 'app', '--xyz')).code).toBe(2);
  });
});
