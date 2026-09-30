import { describe, expect, it } from 'vitest';
import {
  appendNote,
  getChecklist,
  getDescription,
  kebab,
  newTaskBody,
  parseTask,
  serializeTask,
  setChecklist,
  setDescription,
} from '../src/core/task-file.js';

const SAMPLE = `---
id: T-001
title: Título curto
status: todo
priority: high
labels: [backend, ui]
order: 10
created: 2026-09-30
updated: 2026-09-30
---
Descrição livre em **Markdown**.

## Checklist
- [ ] item 1
- [x] item 2

## Notas do agente
(agentes anotam decisões e o que foi feito aqui)
`;

describe('parse/serialização do frontmatter', () => {
  it('lê todos os campos, normalizando datas do YAML para AAAA-MM-DD', () => {
    const t = parseTask(SAMPLE);
    expect(t).toMatchObject({
      id: 'T-001',
      title: 'Título curto',
      status: 'todo',
      priority: 'high',
      labels: ['backend', 'ui'],
      order: 10,
      created: '2026-09-30',
      updated: '2026-09-30',
    });
  });

  it('round-trip reproduz o arquivo byte a byte', () => {
    expect(serializeTask(parseTask(SAMPLE))).toBe(SAMPLE);
  });

  it('preserva o corpo intacto ao mudar só o frontmatter', () => {
    const t = parseTask(SAMPLE);
    const out = serializeTask({ ...t, status: 'doing', order: 30 });
    expect(parseTask(out).body).toBe(t.body);
    expect(out).toContain('status: doing\n');
    expect(out.split('---\n').slice(2).join('---\n')).toBe(t.body);
  });

  it('preserva campos extras desconhecidos', () => {
    const raw = SAMPLE.replace('order: 10\n', 'order: 10\nassignee: claude\n');
    const out = serializeTask(parseTask(raw));
    expect(out).toContain('assignee: claude');
    expect(parseTask(out).extra).toEqual({ assignee: 'claude' });
  });

  it('coloca aspas quando o título tem caracteres especiais de YAML', () => {
    const t = parseTask(SAMPLE);
    const out = serializeTask({ ...t, title: 'API: rota #1 [beta]' });
    expect(parseTask(out).title).toBe('API: rota #1 [beta]');
  });

  it('é tolerante com campos ausentes, mas exige id e title', () => {
    const t = parseTask('---\nid: T-9\ntitle: X\n---\ncorpo\n');
    expect(t).toMatchObject({ priority: 'medium', labels: [], order: 0, status: '' });
    expect(() => parseTask('---\ntitle: X\n---\n')).toThrow(/id/);
    expect(() => parseTask('---\nid: T-1\n---\n')).toThrow(/title/);
  });
});

describe('corpo Markdown', () => {
  const body = parseTask(SAMPLE).body;

  it('extrai checklist e descrição', () => {
    expect(getChecklist(body)).toEqual([
      { text: 'item 1', done: false },
      { text: 'item 2', done: true },
    ]);
    expect(getDescription(body)).toBe('Descrição livre em **Markdown**.');
  });

  it('setChecklist troca só os itens e mantém as outras seções', () => {
    const out = setChecklist(body, [
      { text: 'item 1', done: true },
      { text: 'novo', done: false },
    ]);
    expect(getChecklist(out)).toEqual([
      { text: 'item 1', done: true },
      { text: 'novo', done: false },
    ]);
    expect(out).toContain('## Notas do agente\n(agentes anotam');
    expect(getDescription(out)).toBe(getDescription(body));
  });

  it('setChecklist cria a seção antes das notas quando não existe', () => {
    const out = setChecklist('Texto\n\n## Notas do agente\n- x\n', [{ text: 'a', done: false }]);
    expect(out).toBe('Texto\n\n## Checklist\n\n- [ ] a\n\n## Notas do agente\n- x\n');
  });

  it('setDescription troca só o texto inicial', () => {
    const out = setDescription(body, 'Nova descrição');
    expect(out.startsWith('Nova descrição\n\n## Checklist')).toBe(true);
    expect(getChecklist(out)).toEqual(getChecklist(body));
  });

  it('appendNote acrescenta ao fim da seção de notas', () => {
    const out = appendNote(body, 'decidi usar Hono', '2026-09-30');
    expect(out.endsWith('(agentes anotam decisões e o que foi feito aqui)\n- 2026-09-30: decidi usar Hono\n')).toBe(true);
    const twice = appendNote(out, 'segunda', '2026-10-01');
    expect(twice.endsWith('- 2026-09-30: decidi usar Hono\n- 2026-10-01: segunda\n')).toBe(true);
  });

  it('appendNote cria a seção se faltar e não mexe em seções seguintes', () => {
    expect(appendNote('Só texto\n', 'oi', '2026-09-30')).toBe('Só texto\n\n## Notas do agente\n\n- 2026-09-30: oi\n');
    const mid = appendNote('## Notas do agente\n- a\n\n## Extra\nfim\n', 'b', 'D');
    expect(mid).toBe('## Notas do agente\n- a\n- D: b\n\n## Extra\nfim\n');
  });

  it('newTaskBody gera o esqueleto padrão', () => {
    expect(newTaskBody('Desc', [{ text: 'a', done: false }])).toBe(
      'Desc\n\n## Checklist\n\n- [ ] a\n\n## Notas do agente\n',
    );
  });

  it('kebab remove acentos e símbolos', () => {
    expect(kebab('Configurar Autenticação & Deploy!')).toBe('configurar-autenticacao-deploy');
    expect(kebab('!!!')).toBe('tarefa');
  });
});
