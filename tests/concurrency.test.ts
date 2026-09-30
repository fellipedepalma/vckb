import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { etagOf } from '../src/core/store.js';
import { parseIfMatch } from '../src/server/app.js';
import { apiSetup } from './api-helpers.js';

/**
 * Optimistic concurrency: the UI may have a task open while an agent edits the same file on disk.
 * Writes carrying If-Match must fail with 412 instead of silently overwriting the agent's edit.
 */

async function setup() {
  const ctx = await apiSetup();
  await ctx.req('POST', '/api/projects', { name: 'App', slug: 'app' });
  const created = await ctx.req('POST', '/api/projects/app/tasks', { title: 'Shared', status: 'todo' });
  const task = await created.json();
  const file = path.join(ctx.boards, 'app', 'tasks', task.file);
  /** Simulates an agent editing the file directly. */
  const agentEdit = async () => writeFile(file, (await readFile(file, 'utf8')).replace('title: Shared', 'title: Changed by agent'));
  return { ...ctx, task, file, agentEdit, createdEtag: created.headers.get('etag') };
}

describe('ETag', () => {
  it('is a hash of the file content, sent on create/read/update and in listings', async () => {
    const { req, task, file, createdEtag } = await setup();
    expect(task.etag).toBe(etagOf(await readFile(file, 'utf8')));
    expect(createdEtag).toBe(`"${task.etag}"`);
    const got = await req('GET', '/api/projects/app/tasks/T-001');
    expect(got.headers.get('etag')).toBe(`"${task.etag}"`);
    const [listed] = await (await req('GET', '/api/projects/app/tasks')).json();
    expect(listed.etag).toBe(task.etag);
  });

  it('changes when the file changes on disk', async () => {
    const { req, task, agentEdit } = await setup();
    await agentEdit();
    const after = await req('GET', '/api/projects/app/tasks/T-001');
    expect(after.headers.get('etag')).not.toBe(`"${task.etag}"`);
  });
});

describe('If-Match on PATCH / DELETE / notes', () => {
  it('PATCH with the current ETag succeeds and returns the new one', async () => {
    const { req, task } = await setup();
    const res = await req('PATCH', '/api/projects/app/tasks/T-001', { priority: 'high' }, { 'If-Match': `"${task.etag}"` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(res.headers.get('etag')).toBe(`"${body.etag}"`);
    expect(body.etag).not.toBe(task.etag);
  });

  it('PATCH after an agent edited the file: 412, and the agent edit is kept', async () => {
    const { req, task, agentEdit, file } = await setup();
    await agentEdit();
    const onDisk = await readFile(file, 'utf8');
    const res = await req('PATCH', '/api/projects/app/tasks/T-001', { title: 'From the UI', status: 'doing', position: 0 }, { 'If-Match': `"${task.etag}"` });
    expect(res.status).toBe(412);
    expect((await res.json()).error).toMatch(/changed on disk/);
    expect(await readFile(file, 'utf8')).toBe(onDisk);
  });

  it('DELETE after an agent edit: 412 and the file survives; with the fresh ETag: 204', async () => {
    const { req, task, agentEdit, file } = await setup();
    await agentEdit();
    expect((await req('DELETE', '/api/projects/app/tasks/T-001', undefined, { 'If-Match': `"${task.etag}"` })).status).toBe(412);
    expect(await readFile(file, 'utf8')).toContain('Changed by agent');
    const fresh = (await req('GET', '/api/projects/app/tasks/T-001')).headers.get('etag')!;
    expect((await req('DELETE', '/api/projects/app/tasks/T-001', undefined, { 'If-Match': fresh })).status).toBe(204);
  });

  it('notes honor If-Match too', async () => {
    const { req, task, agentEdit } = await setup();
    await agentEdit();
    expect((await req('POST', '/api/projects/app/tasks/T-001/notes', { text: 'x' }, { 'If-Match': `"${task.etag}"` })).status).toBe(412);
  });

  it('"*", a list containing the current tag, and no header all proceed; weak or malformed tags fail', async () => {
    const { req, task } = await setup();
    const patch = (h: Record<string, string>) => req('PATCH', '/api/projects/app/tasks/T-001', { labels: ['x'] }, h);
    expect((await patch({ 'If-Match': '*' })).status).toBe(200);
    let current = (await req('GET', '/api/projects/app/tasks/T-001')).headers.get('etag')!;
    expect((await patch({ 'If-Match': `"stale", ${current}` })).status).toBe(200);
    current = (await req('GET', '/api/projects/app/tasks/T-001')).headers.get('etag')!;
    expect((await patch({ 'If-Match': `W/${current}` })).status).toBe(412);
    expect((await patch({ 'If-Match': current.slice(1, -1) })).status).toBe(412); // unquoted
    expect((await patch({})).status).toBe(200); // CLI/agents without If-Match keep working
    expect(task.etag).toMatch(/^[0-9a-f]{32}$/);
  });

  it('only the moved task is checked: a stale neighbor does not block a move', async () => {
    const { req } = await setup();
    const other = await (await req('POST', '/api/projects/app/tasks', { title: 'Other', status: 'todo' })).json();
    const res = await req('PATCH', `/api/projects/app/tasks/${other.id}`, { status: 'todo', position: 0 }, { 'If-Match': `"${other.etag}"` });
    expect(res.status).toBe(200);
    expect((await (await req('GET', '/api/projects/app/tasks?status=todo')).json()).map((t: { id: string }) => t.id)).toEqual(['T-002', 'T-001']);
  });
});

describe('parseIfMatch', () => {
  it('parses RFC 9110 forms', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch(' * ')).toEqual(['*']);
    expect(parseIfMatch('"a", "b"')).toEqual(['a', 'b']);
    expect(parseIfMatch('W/"a"')).toEqual([]);
    expect(parseIfMatch('a')).toEqual([]);
    expect(parseIfMatch('')).toEqual([]);
  });
});
