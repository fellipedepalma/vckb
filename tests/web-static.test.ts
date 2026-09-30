import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiSetup, TOKEN } from './api-helpers.js';

/** The built UI served from dist/web: SPA fallback, caching, and no way out of the web root. */
async function setup() {
  const ctx = await apiSetup();
  const webRoot = path.join(ctx.base, 'web');
  await mkdir(path.join(webRoot, 'assets'), { recursive: true });
  await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(webRoot, 'assets', 'app-abc123.js'), 'console.log(1)');
  await writeFile(path.join(webRoot, 'favicon.svg'), '<svg/>');
  await writeFile(path.join(webRoot, '.env'), 'VCKB_TOKEN=secret-in-web-root');
  await writeFile(path.join(webRoot, 'assets', 'notes.md'), '# not a web type');
  await writeFile(path.join(ctx.base, 'secret.txt'), 'outside the web root');
  const { createApp } = await import('../src/server/app.js');
  const app = createApp({ store: ctx.store, token: TOKEN, webRoot });
  return { ...ctx, app };
}

describe('web UI static serving', () => {
  it('serves index.html at / and for client routes (SPA fallback), with the CSP', async () => {
    const { app } = await setup();
    for (const url of ['/', '/p/example', '/p/some/deep/route']) {
      const res = await app.request(url);
      expect(res.status, url).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('content-security-policy')).toMatch(/^default-src 'self'; script-src 'self'/);
      expect(await res.text()).toContain('<div id="root"></div>');
    }
  });

  it('serves hashed assets as immutable with the right type; HEAD has no body', async () => {
    const { app } = await setup();
    const js = await app.request('/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await app.request('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');
    const head = await app.request('/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('never serves dotfiles, unknown types or anything outside the web root', async () => {
    const { app } = await setup();
    const attempts = [
      '/.env',
      '/assets/../.env',
      '/%2eenv',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/..%5csecret.txt',
      '/assets/notes.md',
      '/%00',
      '/%E0%A4%A',
      '/secret.txt',
    ];
    for (const url of attempts) {
      const res = await app.request(url);
      const body = await res.text();
      expect(body, url).not.toContain('secret-in-web-root');
      expect(body, url).not.toContain('outside the web root');
      expect(body, url).not.toContain('# not a web type');
      expect([200, 400, 404], url).toContain(res.status);
      if (res.status === 200) expect(body, url).toContain('<div id="root"></div>'); // only ever the app shell
    }
  });

  it('a missing file with an extension is a real 404, not the app shell', async () => {
    const { app } = await setup();
    expect((await app.request('/assets/old-deadbeef.js')).status).toBe(404);
  });

  it('/api keeps its JSON behavior: unknown API paths never fall back to the shell', async () => {
    const { app } = await setup();
    const unauth = await app.request('/api/nope');
    expect(unauth.status).toBe(401);
    const res = await app.request('/api/nope', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('without a web root only the API is served', async () => {
    const { app } = await apiSetup();
    expect((await app.request('/')).status).toBe(404);
  });

  it('a foreign Host gets 421 for the UI too (DNS rebinding)', async () => {
    const { app } = await setup();
    expect((await app.request('http://evil.example/')).status).toBe(421);
  });
});

describe('board snapshot endpoint', () => {
  it('returns project, tasks and warnings from one read', async () => {
    const { req, boards } = await apiSetup();
    await req('POST', '/api/projects', { name: 'App', slug: 'app' });
    await req('POST', '/api/projects/app/tasks', { title: 'One' });
    await writeFile(path.join(boards, 'app', 'tasks', 'loose.md'), '---\ntitle: Loose\n---\n');
    const snap = await (await req('GET', '/api/projects/app/board')).json();
    expect(snap.project).toMatchObject({ slug: 'app', name: 'App', columns: ['backlog', 'todo', 'doing', 'review', 'done'] });
    expect(snap.tasks.map((t: { title: string }) => t.title).sort()).toEqual(['Loose', 'One']);
    expect(snap.warnings.map((w: { code: string }) => w.code)).toContain('provisional_id');
  });
});
