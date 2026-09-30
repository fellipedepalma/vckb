import { describe, expect, it } from 'vitest';
import { apiSetup } from './api-helpers.js';

describe('API REST', () => {
  it('fluxo completo: projeto → tarefas → patch → summary → delete', async () => {
    const { req } = await apiSetup();
    expect((await req('POST', '/api/projects', { name: 'Demo' })).status).toBe(201);
    expect(await (await req('GET', '/api/projects')).json()).toMatchObject([{ slug: 'demo', name: 'Demo' }]);

    const created = await req('POST', '/api/projects/demo/tasks', { title: 'Primeira', status: 'todo', priority: 'high', labels: ['ui'] });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'T-001', status: 'todo' });
    await req('POST', '/api/projects/demo/tasks', { title: 'Segunda', status: 'todo', labels: ['api'] });

    const byLabel = await (await req('GET', '/api/projects/demo/tasks?label=api')).json();
    expect(byLabel.map((t: { id: string }) => t.id)).toEqual(['T-002']);

    const patched = await req('PATCH', '/api/projects/demo/tasks/T-001', { status: 'doing', title: 'Primeira (editada)' });
    expect(await patched.json()).toMatchObject({ status: 'doing', title: 'Primeira (editada)' });

    const noted = await req('POST', '/api/projects/demo/tasks/T-001/notes', { text: 'feito X' });
    expect((await noted.json()).body).toContain('feito X');

    const summary = await (await req('GET', '/api/projects/demo/summary')).json();
    expect(summary.columns.find((c: { name: string }) => c.name === 'doing').count).toBe(1);
    expect(summary.next.map((t: { id: string }) => t.id)).toEqual(['T-002']);

    expect((await req('DELETE', '/api/projects/demo/tasks/T-002')).status).toBe(204);
    expect((await req('GET', '/api/projects/demo/tasks/T-002')).status).toBe(404);
  });

  it('erros de validação viram 400 com mensagem', async () => {
    const { req } = await apiSetup();
    await req('POST', '/api/projects', { name: 'Demo' });
    const bad = await req('POST', '/api/projects/demo/tasks', { title: 'x', status: 'inexistente' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/status inválido/);
    expect((await req('POST', '/api/projects/demo/tasks', '{nao-json')).status).toBe(400);
    expect((await req('PATCH', '/api/projects/demo/tasks/T-001', { priority: 'high' })).status).toBe(404);
    await req('POST', '/api/projects/demo/tasks', { title: 'válida' });
    expect((await req('PATCH', '/api/projects/demo/tasks/T-001', { priority: 'urgente' })).status).toBe(400);
    expect((await req('PATCH', '/api/projects/demo/tasks/T-001', {})).status).toBe(400);
    expect((await req('GET', '/api/projects/nao-existe/tasks')).status).toBe(404);
  });

  it('ignora campos que não estão na whitelist', async () => {
    const { req } = await apiSetup();
    await req('POST', '/api/projects', { name: 'Demo' });
    const res = await req('POST', '/api/projects/demo/tasks', { title: 'x', id: 'T-999', created: '1999-01-01', __proto__: { a: 1 } });
    expect(await res.json()).toMatchObject({ id: 'T-001', created: '2026-09-30' });
  });

  it('SSE entrega eventos "change" do watcher', async () => {
    const { req, events } = await apiSetup();
    const res = await req('GET', '/api/events');
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };
    await readUntil('event: ready');
    events.emit('change', { project: 'demo' });
    await readUntil('event: change');
    expect(text).toContain('data: {"project":"demo"}');
    await reader.cancel();
  });
});
