import { describe, expect, it } from 'vitest';
import { apiSetup } from './api-helpers.js';

describe('REST API', () => {
  it('full flow: project → tasks → patch → summary → delete', async () => {
    const { req } = await apiSetup();
    expect((await req('POST', '/api/projects', { name: 'Demo' })).status).toBe(201);
    expect(await (await req('GET', '/api/projects')).json()).toMatchObject([{ slug: 'demo', name: 'Demo' }]);

    const created = await req('POST', '/api/projects/demo/tasks', { title: 'First', status: 'todo', priority: 'high', labels: ['ui'] });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: 'T-001', status: 'todo' });
    await req('POST', '/api/projects/demo/tasks', { title: 'Second', status: 'todo', labels: ['api'] });

    const byLabel = await (await req('GET', '/api/projects/demo/tasks?label=api')).json();
    expect(byLabel.map((t: { id: string }) => t.id)).toEqual(['T-002']);

    const patched = await req('PATCH', '/api/projects/demo/tasks/T-001', { status: 'doing', title: 'First (edited)' });
    expect(await patched.json()).toMatchObject({ status: 'doing', title: 'First (edited)' });

    const noted = await req('POST', '/api/projects/demo/tasks/T-001/notes', { text: 'did X' });
    expect((await noted.json()).body).toContain('did X');

    const summary = await (await req('GET', '/api/projects/demo/summary')).json();
    expect(summary.columns.find((c: { name: string }) => c.name === 'doing').count).toBe(1);
    expect(summary.next.map((t: { id: string }) => t.id)).toEqual(['T-002']);

    expect((await req('DELETE', '/api/projects/demo/tasks/T-002')).status).toBe(204);
    expect((await req('GET', '/api/projects/demo/tasks/T-002')).status).toBe(404);
  });

  it('validation errors become 400 with a message', async () => {
    const { req } = await apiSetup();
    await req('POST', '/api/projects', { name: 'Demo' });
    const bad = await req('POST', '/api/projects/demo/tasks', { title: 'x', status: 'nonexistent' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/invalid status/);
    expect((await req('POST', '/api/projects/demo/tasks', '{not-json')).status).toBe(400);
    expect((await req('PATCH', '/api/projects/demo/tasks/T-001', { priority: 'high' })).status).toBe(404);
    await req('POST', '/api/projects/demo/tasks', { title: 'valid' });
    expect((await req('PATCH', '/api/projects/demo/tasks/T-001', { priority: 'urgent' })).status).toBe(400);
    expect((await req('PATCH', '/api/projects/demo/tasks/T-001', {})).status).toBe(400);
    expect((await req('GET', '/api/projects/does-not-exist/tasks')).status).toBe(404);
  });

  it('ignores fields that are not whitelisted', async () => {
    const { req } = await apiSetup();
    await req('POST', '/api/projects', { name: 'Demo' });
    const res = await req('POST', '/api/projects/demo/tasks', { title: 'x', id: 'T-999', created: '1999-01-01', __proto__: { a: 1 } });
    expect(await res.json()).toMatchObject({ id: 'T-001', created: '2026-09-30' });
  });

  it('SSE delivers "change" events from the watcher', async () => {
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
