import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempWorkspace } from './helpers.js';

async function setup() {
  const ws = await tempWorkspace();
  await ws.store.createProject({ name: 'Meu App', slug: 'app' });
  return ws;
}

const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

describe('projetos', () => {
  it('cria board.json com colunas padrão e lista o projeto', async () => {
    const { store, boards } = await tempWorkspace();
    const p = await store.createProject({ name: 'Loja Online' });
    expect(p.slug).toBe('loja-online');
    const board = JSON.parse(await readFile(path.join(boards, 'loja-online', 'board.json'), 'utf8'));
    expect(board).toEqual({ name: 'Loja Online', description: '', columns: ['backlog', 'todo', 'doing', 'review', 'done'], nextId: 1 });
    expect((await store.listProjects()).map((x) => x.slug)).toEqual(['loja-online']);
    await expect(store.createProject({ name: 'Loja Online' })).rejects.toThrow(/já existe/);
  });
});

describe('criar tarefa', () => {
  it('gera IDs sequenciais, arquivo T-NNN-kebab.md e incrementa nextId', async () => {
    const { store, boards } = await setup();
    const a = await store.createTask('app', { title: 'Criar Página de Login', priority: 'high', labels: ['ui'] });
    const b = await store.createTask('app', { title: 'Segunda', status: 'todo', checklist: [{ text: 'x', done: false }] });
    expect([a.id, b.id]).toEqual(['T-001', 'T-002']);
    expect(a.status).toBe('backlog');
    expect(a.file).toBe('T-001-criar-pagina-de-login.md');
    expect(b.progress).toEqual({ done: 0, total: 1 });
    const raw = await readFile(path.join(boards, 'app', 'tasks', a.file), 'utf8');
    expect(raw).toBe(
      '---\nid: T-001\ntitle: Criar Página de Login\nstatus: backlog\npriority: high\nlabels: [ui]\norder: 10\n' +
        'created: 2026-09-30\nupdated: 2026-09-30\n---\n## Checklist\n\n## Notas do agente\n',
    );
    const board = JSON.parse(await readFile(path.join(boards, 'app', 'board.json'), 'utf8'));
    expect(board.nextId).toBe(3);
  });

  it('criações concorrentes não duplicam IDs (lock + escrita atômica)', async () => {
    const { store } = await setup();
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => store.createTask('app', { title: `t${i}` })));
    expect(new Set(ids(created)).size).toBe(12);
    expect((await store.getProject('app')).nextId).toBe(13);
  });

  it('não reutiliza ID de arquivo criado à mão sem atualizar nextId', async () => {
    const { store, boards } = await setup();
    await writeFile(path.join(boards, 'app', 'tasks', 'T-007-manual.md'), '---\nid: T-007\ntitle: Manual\nstatus: todo\n---\n');
    const t = await store.createTask('app', { title: 'Nova' });
    expect(t.id).toBe('T-008');
  });

  it('valida status contra as colunas do board', async () => {
    const { store } = await setup();
    await expect(store.createTask('app', { title: 'x', status: 'feito' })).rejects.toThrow(/status inválido/);
  });

  it('não deixa arquivos temporários nem lock para trás', async () => {
    const { store, boards } = await setup();
    await store.createTask('app', { title: 'x' });
    expect(await readdir(path.join(boards, 'app'))).toEqual(['board.json', 'tasks']);
    expect(await readdir(path.join(boards, 'app', 'tasks'))).toEqual(['T-001-x.md']);
  });
});

describe('mover e reordenar', () => {
  async function withColumn() {
    const ws = await setup();
    for (const title of ['A', 'B', 'C']) await ws.store.createTask('app', { title, status: 'todo' });
    return ws;
  }

  it('move para outra coluna no fim e preserva o corpo', async () => {
    const { store, boards } = await withColumn();
    await store.addNote('app', 'T-001', 'anotação');
    const before = await store.getTask('app', 'T-001');
    await store.createTask('app', { title: 'D', status: 'doing' });
    const moved = await store.moveTask('app', 'T-001', 'doing');
    expect(moved).toMatchObject({ status: 'doing', order: 20 });
    expect(moved.body).toBe(before.body);
    const raw = await readFile(path.join(boards, 'app', 'tasks', moved.file), 'utf8');
    expect(raw).toContain('status: doing\n');
    expect(raw).toContain('- 2026-09-30: anotação');
  });

  it('rejeita coluna inexistente', async () => {
    const { store } = await withColumn();
    await expect(store.moveTask('app', 'T-001', 'nope')).rejects.toThrow(/status inválido/);
  });

  it('reordena dentro da coluna com position e renumera 10, 20, 30', async () => {
    const { store } = await withColumn();
    await store.updateTask('app', 'T-003', { position: 0 });
    const col = await store.listTasks('app', { status: 'todo' });
    expect(ids(col)).toEqual(['T-003', 'T-001', 'T-002']);
    expect(col.map((t) => t.order)).toEqual([10, 20, 30]);
  });

  it('move para posição específica em outra coluna', async () => {
    const { store } = await withColumn();
    await store.moveTask('app', 'T-001', 'doing');
    await store.moveTask('app', 'T-002', 'doing');
    await store.moveTask('app', 'T-003', 'doing', 1);
    expect(ids(await store.listTasks('app', { status: 'doing' }))).toEqual(['T-001', 'T-003', 'T-002']);
    expect(await store.listTasks('app', { status: 'todo' })).toEqual([]);
  });

  it('aceita IDs em formato solto (t-1)', async () => {
    const { store } = await withColumn();
    expect((await store.moveTask('app', 't-1', 'review')).id).toBe('T-001');
  });
});

describe('editar, notas, excluir, resumo', () => {
  it('PATCH de descrição e checklist mantém notas', async () => {
    const { store } = await setup();
    await store.createTask('app', { title: 'x', description: 'velha', checklist: [{ text: 'a', done: false }] });
    await store.addNote('app', 'T-001', 'nota 1');
    const t = await store.updateTask('app', 'T-001', {
      description: 'nova',
      checklist: [
        { text: 'a', done: true },
        { text: 'b', done: false },
      ],
      labels: ['ui', 'ui', 'api'],
    });
    expect(t.description).toBe('nova');
    expect(t.progress).toEqual({ done: 1, total: 2 });
    expect(t.labels).toEqual(['ui', 'api']);
    expect(t.body).toContain('- 2026-09-30: nota 1');
  });

  it('exclui e responde 404 depois', async () => {
    const { store } = await setup();
    await store.createTask('app', { title: 'x' });
    await store.deleteTask('app', 'T-001');
    await expect(store.getTask('app', 'T-001')).rejects.toThrow(/não encontrada/);
  });

  it('summary conta por coluna e ordena "todo" por prioridade; next pega a primeira', async () => {
    const { store } = await setup();
    await store.createTask('app', { title: 'baixa', status: 'todo', priority: 'low' });
    await store.createTask('app', { title: 'média', status: 'todo' });
    await store.createTask('app', { title: 'alta', status: 'todo', priority: 'high' });
    await store.createTask('app', { title: 'em andamento', status: 'doing', priority: 'high' });
    const s = await store.summary('app');
    expect(s.columns).toEqual([
      { name: 'backlog', count: 0 },
      { name: 'todo', count: 3 },
      { name: 'doing', count: 1 },
      { name: 'review', count: 0 },
      { name: 'done', count: 0 },
    ]);
    expect(s.next.map((t) => t.title)).toEqual(['alta', 'média', 'baixa']);
    expect((await store.nextTask('app'))?.title).toBe('alta');
  });

  it('arquivos inválidos não derrubam a listagem e aparecem no summary', async () => {
    const { store, boards } = await setup();
    await store.createTask('app', { title: 'ok' });
    await writeFile(path.join(boards, 'app', 'tasks', 'quebrado.md'), 'sem frontmatter');
    expect(ids(await store.listTasks('app'))).toEqual(['T-001']);
    expect((await store.summary('app')).invalidFiles).toEqual([{ file: 'quebrado.md', error: 'frontmatter sem "id"' }]);
  });
});
